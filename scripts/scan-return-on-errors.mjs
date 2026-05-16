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
	} else if (arg === "--help" || arg === "-h") {
		console.log("Usage: scan-return-on-errors [--since <iso>] [--until <iso>] [--days N] [--json] [root...]");
		process.exit(0);
	} else {
		roots.push(resolve(arg));
	}
}
if (roots.length === 0) roots.push(join(homedir(), ".pi", "agent", "sessions"));

const errors = new Map();
const shapes = new Map();

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
		const error = errors.get(text) ?? { count: 0, examples: [] };
		error.count += 1;
		if (error.examples.length < 3) error.examples.push(file);
		errors.set(text, error);

		const parent = byId.get(entry.parentId);
		const calls = Array.isArray(parent?.message?.content)
			? parent.message.content.filter((block) => block?.type === "toolCall" && block.name === "return_on")
			: [];
		for (const call of calls) {
			const shape = conditionShape(call.arguments?.condition);
			const item = shapes.get(shape) ?? { count: 0, examples: [] };
			item.count += 1;
			if (item.examples.length < 3) item.examples.push({ file, arguments: call.arguments });
			shapes.set(shape, item);
		}
	}
}

for (const root of roots) {
	for await (const file of walk(root)) await scanFile(file);
}

const total = [...errors.values()].reduce((sum, item) => sum + item.count, 0);
const sortedErrors = [...errors.entries()].sort((a, b) => b[1].count - a[1].count);
const sortedShapes = [...shapes.entries()].sort((a, b) => b[1].count - a[1].count);

if (jsonOut) {
	const payload = {
		scannedAt: new Date().toISOString(),
		roots,
		since: sinceMs ? new Date(sinceMs).toISOString() : null,
		until: untilMs ? new Date(untilMs).toISOString() : null,
		total,
		errors: sortedErrors.map(([text, item]) => ({ text, count: item.count, examples: item.examples })),
		shapes: sortedShapes.map(([shape, item]) => ({ shape, count: item.count, examples: item.examples })),
	};
	process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
} else {
	const rangeNote = sinceMs || untilMs ? ` (since=${sinceMs ? new Date(sinceMs).toISOString() : "-"} until=${untilMs ? new Date(untilMs).toISOString() : "-"})` : "";
	console.log(`return_on tool errors: ${total}${rangeNote}`);
	for (const [text, item] of sortedErrors) {
		console.log(`\n${item.count}x ${text}`);
		for (const file of item.examples) console.log(`  example: ${file}`);
	}

	if (shapes.size > 0) {
		console.log("\nCondition shapes for errored calls:");
		for (const [shape, item] of sortedShapes) {
			console.log(`\n${item.count}x ${shape}`);
			for (const example of item.examples) {
				console.log(`  example: ${example.file}`);
				console.log(`  args: ${JSON.stringify(example.arguments)}`);
			}
		}
	}
}
