#!/usr/bin/env node
// Prune old Pi agent session JSONL logs.
//
// Safety:
//  - Dry-run by default. Use --apply to actually delete.
//  - Only deletes files matching *.jsonl under the sessions root.
//  - Skips files modified within --min-age-hours (default 24h) so the
//    currently active session can't be removed mid-run.
//  - Defaults to 30 days retention; tune with --days N.
//
// The scan-errors tooling uses --since to filter by entry timestamp, which is
// the right move for in-flight analysis. This pruner is the orthogonal
// "actually free disk" tool: once a session is older than the retention
// window it's no longer interesting for trend tracking and can go.

import { readdir, stat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
let retentionDays = 30;
let minAgeHours = 24;
let apply = false;
let jsonOut = false;
const roots = [];

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--days") {
		const days = Number(args[++i]);
		if (!Number.isFinite(days) || days <= 0) {
			console.error(`Invalid --days value: ${args[i]}`);
			process.exit(2);
		}
		retentionDays = days;
	} else if (arg === "--min-age-hours") {
		const hours = Number(args[++i]);
		if (!Number.isFinite(hours) || hours < 0) {
			console.error(`Invalid --min-age-hours value: ${args[i]}`);
			process.exit(2);
		}
		minAgeHours = hours;
	} else if (arg === "--apply") {
		apply = true;
	} else if (arg === "--json") {
		jsonOut = true;
	} else if (arg === "--help" || arg === "-h") {
		console.log(`Usage: prune-old-sessions [--days N] [--min-age-hours H] [--apply] [--json] [root...]

Prunes *.jsonl session log files older than N days (default 30) under each
root (default ~/.pi/agent/sessions). Files modified within the last H hours
(default 24) are always kept as a guard against active sessions.

Dry-run by default. Pass --apply to actually delete.`);
		process.exit(0);
	} else {
		roots.push(resolve(arg));
	}
}
if (roots.length === 0) roots.push(join(homedir(), ".pi", "agent", "sessions"));

const now = Date.now();
const retentionCutoff = now - retentionDays * 86_400_000;
const minAgeCutoff = now - minAgeHours * 3_600_000;

async function* walk(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(full);
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			yield full;
		}
	}
}

const result = {
	roots,
	retentionDays,
	minAgeHours,
	apply,
	considered: 0,
	skippedActive: 0,
	skippedFresh: 0,
	candidates: 0,
	bytes: 0,
	deleted: 0,
	deletedBytes: 0,
	errors: [],
};

for (const root of roots) {
	for await (const file of walk(root)) {
		result.considered++;
		let st;
		try {
			st = await stat(file);
		} catch (error) {
			result.errors.push({ file, error: String(error?.message ?? error) });
			continue;
		}
		if (st.mtimeMs >= minAgeCutoff) {
			result.skippedActive++;
			continue;
		}
		if (st.mtimeMs >= retentionCutoff) {
			result.skippedFresh++;
			continue;
		}
		result.candidates++;
		result.bytes += st.size;
		if (apply) {
			try {
				await rm(file);
				result.deleted++;
				result.deletedBytes += st.size;
			} catch (error) {
				result.errors.push({ file, error: String(error?.message ?? error) });
			}
		}
	}
}

function fmtBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

if (jsonOut) {
	console.log(JSON.stringify(result, null, 2));
} else {
	const mode = apply ? "APPLY" : "dry-run";
	console.log(`prune-old-sessions [${mode}] retention=${retentionDays}d min-age=${minAgeHours}h roots=${roots.join(",")}`);
	console.log(`considered=${result.considered} kept_active=${result.skippedActive} kept_fresh=${result.skippedFresh} candidates=${result.candidates} (${fmtBytes(result.bytes)})`);
	if (apply) console.log(`deleted=${result.deleted} (${fmtBytes(result.deletedBytes)})`);
	else console.log(`(no files deleted; re-run with --apply to free ${fmtBytes(result.bytes)})`);
	if (result.errors.length) {
		console.log(`errors: ${result.errors.length}`);
		for (const { file, error } of result.errors.slice(0, 5)) console.log(`  ${file}: ${error}`);
	}
}
