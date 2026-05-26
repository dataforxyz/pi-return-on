import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";
import {
	collectConditionLeafTargets,
	collectFileWatchTargets,
	collectIncomingWebhookTargets,
	normalizeCondition,
} from "../src/index.ts";

function makeJob(condition: unknown): any {
	return {
		id: "ro_test",
		label: "x",
		cwd: "/work",
		createdAt: 0,
		updatedAt: 0,
		status: "active",
		condition: normalizeCondition(condition),
		resume: "wake",
		latches: {},
		leafState: {},
	};
}

test("normalizeCondition: rejects non-object input", () => {
	assert.throws(() => normalizeCondition(undefined), /must be an object/);
	assert.throws(() => normalizeCondition(42), /must be an object/);
});

test("normalizeCondition: bare duration string becomes timer", () => {
	const c = normalizeCondition("2s") as any;
	assert.equal(c.type, "timer");
	assert.equal(c.after, "2s");
});

test("normalizeCondition: JSON string is parsed", () => {
	const c = normalizeCondition('{"type":"timer","after":"5s"}') as any;
	assert.equal(c.type, "timer");
	assert.equal(c.after, "5s");
});

test("normalizeCondition: any/all/not shorthands map to op groups", () => {
	const any = normalizeCondition({ any: [{ type: "timer", after: "1s" }, { type: "timer", after: "2s" }] }) as any;
	assert.equal(any.op, "or");
	assert.equal(any.children.length, 2);
	const all = normalizeCondition({ all: [{ type: "timer", after: "1s" }] }) as any;
	assert.equal(all.op, "and");
	const not = normalizeCondition({ not: { type: "timer", after: "1s" } }) as any;
	assert.equal(not.op, "not");
	assert.equal(not.children.length, 1);
});

test("normalizeCondition: empty any/all rejected", () => {
	assert.throws(() => normalizeCondition({ any: [] }), /any group requires children/);
	assert.throws(() => normalizeCondition({ all: [] }), /all group requires children/);
});

test("normalizeCondition: file shorthand wraps to type=file", () => {
	const c = normalizeCondition({ file: "/tmp/x" }) as any;
	assert.equal(c.type, "file");
	assert.equal(c.path, "/tmp/x");
});

test("normalizeCondition: timer requires after/at/duration", () => {
	assert.throws(() => normalizeCondition({ type: "timer" }), /requires after, at, or duration/);
	const c = normalizeCondition({ type: "timer", duration: "3s" }) as any;
	assert.equal(c.after, "3s");
});

test("normalizeCondition: file requires non-empty path", () => {
	assert.throws(() => normalizeCondition({ type: "file" }), /file condition requires path/);
});

test("normalizeCondition: webhook path must start with /", () => {
	assert.throws(() => normalizeCondition({ type: "webhook", path: "no-slash" }), /path must start with/);
	const c = normalizeCondition({ type: "webhook", path: "/hook" }) as any;
	assert.equal(c.path, "/hook");
});

test("normalizeCondition: unknown type throws", () => {
	assert.throws(() => normalizeCondition({ type: "nope" }), /unsupported condition type/);
});

test("collectConditionLeafTargets: flattens nested groups with keys", () => {
	const c = normalizeCondition({
		any: [
			{ type: "timer", after: "1s" },
			{ all: [{ type: "file", path: "/a" }, { type: "timer", after: "2s" }] },
		],
	});
	const leaves = collectConditionLeafTargets(c);
	assert.equal(leaves.length, 3);
	const keys = leaves.map((l) => l.key).sort();
	assert.deepEqual(keys, ["root.0", "root.1.0", "root.1.1"]);
});

test("collectConditionLeafTargets: single leaf yields one target with key=root", () => {
	const c = normalizeCondition({ type: "timer", after: "1s" });
	const leaves = collectConditionLeafTargets(c);
	assert.equal(leaves.length, 1);
	assert.equal(leaves[0]!.key, "root");
});

test("collectFileWatchTargets: only file leaves, paths resolved against cwd", () => {
	const job = makeJob({
		any: [
			{ type: "timer", after: "1s" },
			{ type: "file", path: "logs/out.log" },
			{ all: [{ type: "file", path: "/abs/path" }, { type: "webhook", path: "/hook" }] },
		],
	});
	const targets = collectFileWatchTargets(job);
	assert.equal(targets.length, 2);
	const sorted = [...targets].sort((a, b) => a.key.localeCompare(b.key));
	assert.equal(sorted[0]!.filePath, path.resolve("/work", "logs/out.log"));
	assert.equal(sorted[0]!.basename, "out.log");
	assert.equal(sorted[0]!.dir, path.resolve("/work", "logs"));
	assert.equal(sorted[1]!.filePath, "/abs/path");
});

test("collectIncomingWebhookTargets: only webhook leaves with key path", () => {
	const job = makeJob({
		all: [
			{ type: "file", path: "/x" },
			{ type: "webhook", path: "/hook1", token: "t1", method: "POST" },
			{ any: [{ type: "webhook", path: "/hook2", token: "t2", method: "GET" }] },
		],
	});
	const targets = collectIncomingWebhookTargets(job);
	assert.equal(targets.length, 2);
	const keys = targets.map((t) => t.key).sort();
	assert.deepEqual(keys, ["root.1", "root.2.0"]);
	assert.equal(targets.every((t) => t.jobId === job.id), true);
});
