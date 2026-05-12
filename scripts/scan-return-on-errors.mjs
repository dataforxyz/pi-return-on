#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const roots = process.argv.slice(2).map((arg) => resolve(arg));
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
console.log(`return_on tool errors: ${total}`);
for (const [text, item] of [...errors.entries()].sort((a, b) => b[1].count - a[1].count)) {
	console.log(`\n${item.count}x ${text}`);
	for (const file of item.examples) console.log(`  example: ${file}`);
}

if (shapes.size > 0) {
	console.log("\nCondition shapes for errored calls:");
	for (const [shape, item] of [...shapes.entries()].sort((a, b) => b[1].count - a[1].count)) {
		console.log(`\n${item.count}x ${shape}`);
		for (const example of item.examples) {
			console.log(`  example: ${example.file}`);
			console.log(`  args: ${JSON.stringify(example.arguments)}`);
		}
	}
}
