#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const roots = [];
let sinceMs;
let untilMs;
let jsonOut = false;
let includeResolved = false;
const CURRENT_DEFAULT_MAX_TIMEOUT_MS = 2 * 60 * 60_000;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--since") {
		const parsed = Date.parse(args[++i]);
		if (!Number.isFinite(parsed)) {
			console.error(`Invalid --since value: ${args[i]}`);
			process.exit(2);
		}
		sinceMs = parsed;
	} else if (arg === "--until") {
		const parsed = Date.parse(args[++i]);
		if (!Number.isFinite(parsed)) {
			console.error(`Invalid --until value: ${args[i]}`);
			process.exit(2);
		}
		untilMs = parsed;
	} else if (arg === "--days") {
		const days = Number(args[++i]);
		if (!Number.isFinite(days) || days <= 0) {
			console.error(`Invalid --days value: ${args[i]}`);
			process.exit(2);
		}
		sinceMs = Date.now() - days * 86_400_000;
	} else if (arg === "--json") {
		jsonOut = true;
	} else if (arg === "--include-resolved") {
		includeResolved = true;
	} else if (arg === "--help" || arg === "-h") {
		console.log("Usage: scan-return-on-errors [--since <iso>] [--until <iso>] [--days N] [--include-resolved] [--json] [root...]");
		process.exit(0);
	} else {
		roots.push(resolve(arg));
	}
}
if (roots.length === 0) roots.push(join(homedir(), ".pi", "agent", "sessions"));

const errors = new Map();
const resolvedErrors = new Map();
const shapes = new Map();
const resolvedShapes = new Map();

async function* walk(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(fullPath);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield fullPath;
	}
}

function textContent(content) {
	if (!Array.isArray(content)) return String(content ?? "");
	return content
		.filter((block) => block && typeof block === "object" && block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function conditionShape(condition) {
	if (!condition || typeof condition !== "object" || Array.isArray(condition)) return typeof condition;
	const keys = Object.keys(condition).sort();
	return `keys=[${keys.join(",")}] type=${JSON.stringify(condition.type)}`;
}

function parseDuration(input) {
	if (typeof input === "number" && Number.isFinite(input)) return input;
	if (typeof input !== "string") return undefined;
	let trimmed = input.trim();
	if (!trimmed) return undefined;
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === "string") trimmed = parsed.trim();
		} catch {
			trimmed = trimmed.slice(1, -1).trim();
		}
	}
	const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?$/i);
	if (!match) return undefined;
	const value = Number(match[1]);
	const unit = (match[2] ?? "ms").toLowerCase();
	const multipliers = { ms: 1, s: 1000, sec: 1000, secs: 1000, m: 60_000, min: 60_000, mins: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, d: 86_400_000, day: 86_400_000, days: 86_400_000 };
	return Math.max(0, Math.round(value * (multipliers[unit] ?? 1)));
}

function parseConditionMaybe(condition) {
	if (typeof condition !== "string") return condition;
	const trimmed = condition.trim();
	if (!trimmed.startsWith("{")) return condition;
	try {
		return JSON.parse(trimmed);
	} catch {
		return condition;
	}
}

function hasCompatConditionShape(condition) {
	condition = parseConditionMaybe(condition);
	if (typeof condition === "string") return parseDuration(condition) !== undefined;
	if (!condition || typeof condition !== "object" || Array.isArray(condition)) return false;
	if (Array.isArray(condition.any)) return condition.any.some(hasCompatConditionShape);
	if (Array.isArray(condition.all)) return condition.all.some(hasCompatConditionShape);
	if (condition.not !== undefined) return hasCompatConditionShape(condition.not);
	if (Array.isArray(condition.children)) return condition.children.some(hasCompatConditionShape);
	if (condition.type === undefined) {
		if (typeof condition.timer === "string" || typeof condition.timer === "number") return true;
		if (typeof condition.exec === "string" || isPlainObject(condition.exec)) return true;
		if (typeof condition.file === "string" || isPlainObject(condition.file)) return true;
		if (isPlainObject(condition.process)) return true;
		if (typeof condition.port === "number" || isPlainObject(condition.port)) return true;
		if (typeof condition.url === "string" || isPlainObject(condition.url)) return true;
		if (isPlainObject(condition.webhook) || isPlainObject(condition.timer)) return true;
	}
	if (condition.type === "process" && condition.pidFile !== undefined) return true;
	return false;
}

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function classifyResolved(text, args) {
	const timeoutMatch = text.match(/^return_on timeout ([^ ]+) exceeds max ([^.]+)\./);
	if (timeoutMatch) {
		const requestedMs = parseDuration(timeoutMatch[1]);
		const oldMaxMs = parseDuration(timeoutMatch[2]);
		if (requestedMs !== undefined && oldMaxMs !== undefined && oldMaxMs < CURRENT_DEFAULT_MAX_TIMEOUT_MS && requestedMs <= CURRENT_DEFAULT_MAX_TIMEOUT_MS) {
			return "covered_by_current_default_max_timeout";
		}
	}
	if (
		text.includes("condition leaf uses wrapper shape")
		|| text.includes("unsupported condition type 'undefined'")
		|| text.includes("unsupported condition: no 'type' field")
		|| text.includes("condition must be an object")
		|| text.startsWith("process condition requires pid, name, commandContains, or matches")
	) {
		if (hasCompatConditionShape(args?.condition)) return "supported_by_current_condition_compat";
	}
	return undefined;
}

function addMapItem(map, key, item) {
	const existing = map.get(key) ?? { count: 0, examples: [], ...(item.reason ? { reason: item.reason } : {}) };
	existing.count += 1;
	if (item.reason && !existing.reason) existing.reason = item.reason;
	if (existing.examples.length < 3) existing.examples.push(item.example);
	map.set(key, existing);
}

function entryTimestampMs(entry) {
	const raw = entry?.timestamp;
	if (!raw) return undefined;
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function inRange(ms) {
	if (ms === undefined) return sinceMs === undefined && untilMs === undefined;
	if (sinceMs !== undefined && ms < sinceMs) return false;
	if (untilMs !== undefined && ms > untilMs) return false;
	return true;
}

async function scanFile(file) {
	const byId = new Map();
	const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of rl) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.id) byId.set(entry.id, entry);
		const msg = entry?.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "return_on" || msg.isError !== true) continue;
		if (!inRange(entryTimestampMs(entry))) continue;

		const text = textContent(msg.content) || "<empty error text>";
		const parent = byId.get(entry.parentId);
		const calls = Array.isArray(parent?.message?.content)
			? parent.message.content.filter((block) => block?.type === "toolCall" && block.name === "return_on")
			: [];
		const callArgs = calls[0]?.arguments;
		const reason = classifyResolved(text, callArgs);
		const errorMap = reason ? resolvedErrors : errors;
		addMapItem(errorMap, text, { reason, example: file });

		for (const call of calls) {
			const shape = conditionShape(call.arguments?.condition);
			const shapeReason = classifyResolved(text, call.arguments);
			const shapeMap = shapeReason ? resolvedShapes : shapes;
			addMapItem(shapeMap, shape, { reason: shapeReason, example: { file, arguments: call.arguments } });
		}
	}
}

for (const root of roots) {
	for await (const file of walk(root)) await scanFile(file);
}

// Some Pi sessions chain multiple tool results from one assistant entry, so later
// errored results may have a previous tool result as parent rather than the
// original return_on tool call. If the same error text was resolved elsewhere in
// the scan, treat the parentless duplicates as the same historical resolved
// class instead of leaving noisy leftovers.
for (const [text, unresolved] of [...errors.entries()]) {
	const resolved = resolvedErrors.get(text);
	if (!resolved) continue;
	resolved.count += unresolved.count;
	resolved.examples.push(...unresolved.examples.filter((example) => resolved.examples.length < 3));
	errors.delete(text);
}

const unresolvedTotal = [...errors.values()].reduce((sum, item) => sum + item.count, 0);
const resolvedTotal = [...resolvedErrors.values()].reduce((sum, item) => sum + item.count, 0);
const totalAll = unresolvedTotal + resolvedTotal;
const displayErrors = includeResolved ? mergeSortedMaps(errors, resolvedErrors) : [...errors.entries()].sort((a, b) => b[1].count - a[1].count);
const displayShapes = includeResolved ? mergeSortedMaps(shapes, resolvedShapes) : [...shapes.entries()].sort((a, b) => b[1].count - a[1].count);
const sortedResolvedErrors = [...resolvedErrors.entries()].sort((a, b) => b[1].count - a[1].count);

function mergeSortedMaps(primary, secondary) {
	return [...primary.entries(), ...secondary.entries()].sort((a, b) => b[1].count - a[1].count);
}

function serializeError([text, item], resolved = false) {
	return { text, count: item.count, ...(resolved || item.reason ? { resolved: resolved || !!item.reason, reason: item.reason } : {}), examples: item.examples };
}

function serializeShape([shape, item], resolved = false) {
	return { shape, count: item.count, ...(resolved || item.reason ? { resolved: resolved || !!item.reason, reason: item.reason } : {}), examples: item.examples };
}

if (jsonOut) {
	const payload = {
		scannedAt: new Date().toISOString(),
		roots,
		since: sinceMs ? new Date(sinceMs).toISOString() : null,
		until: untilMs ? new Date(untilMs).toISOString() : null,
		total: includeResolved ? totalAll : unresolvedTotal,
		totalAll,
		unresolvedTotal,
		resolvedTotal,
		resolvedSuppressed: includeResolved ? 0 : resolvedTotal,
		errors: displayErrors.map(([text, item]) => serializeError([text, item], !!item.reason)),
		resolvedErrors: sortedResolvedErrors.map((entry) => serializeError(entry, true)),
		shapes: displayShapes.map(([shape, item]) => serializeShape([shape, item], !!item.reason)),
	};
	process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
} else {
	const rangeNote = sinceMs || untilMs ? ` (since=${sinceMs ? new Date(sinceMs).toISOString() : "-"} until=${untilMs ? new Date(untilMs).toISOString() : "-"})` : "";
	const resolvedNote = resolvedTotal > 0 && !includeResolved ? `; suppressed ${resolvedTotal} historical errors covered by current compatibility/defaults (use --include-resolved to show)` : "";
	console.log(`return_on tool errors: ${includeResolved ? totalAll : unresolvedTotal}${rangeNote}${resolvedNote}`);
	for (const [text, item] of displayErrors) {
		console.log(`\n${item.count}x ${text}${item.reason ? ` [resolved: ${item.reason}]` : ""}`);
		for (const file of item.examples) console.log(`  example: ${file}`);
	}

	if (displayShapes.length > 0) {
		console.log("\nCondition shapes for errored calls:");
		for (const [shape, item] of displayShapes) {
			console.log(`\n${item.count}x ${shape}${item.reason ? ` [resolved: ${item.reason}]` : ""}`);
			for (const example of item.examples) {
				console.log(`  example: ${example.file}`);
				console.log(`  args: ${JSON.stringify(example.arguments)}`);
			}
		}
	}
}
