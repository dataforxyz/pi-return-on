import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
	applyFiredEventToJob,
	collectConditionLeafTargets,
	collectFileWatchTargets,
	evaluateCondition,
	firedEventNeedsJobProtection,
	collectIncomingWebhookTargets,
	mergeHandlersForSave,
	mergeJobsForPrunedSave,
	mergeJobsForReload,
	mergeJobsForSave,
	jobEvaluationPersistenceKey,
	jobsNeedProtectionLookup,
	normalizeCondition,
	patchFiredEvent,
	pruneTempFiles,
	readResponseTextLimited,
	requestContentLengthExceedsLimit,
	releaseFiredEventClaim,
	retainBoundedJobs,
	revisionMarkerIsCurrent,
	tryClaimFiredEvent,
	withJobsFileLock,
	withJobsFileLockRetry,
	normalizeReturnOnToolParams,
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

function makeMergeJob(id: string, status: "active" | "fired" | "cancelled", updatedAt: number): any {
	return {
		...makeJob({ type: "timer", after: "1m" }),
		id,
		status,
		createdAt: updatedAt - 10,
		updatedAt,
		...(status === "fired" ? { firedAt: updatedAt } : {}),
		...(status === "cancelled" ? { cancelledAt: updatedAt } : {}),
	};
}

function makeHandler(id: string, status: "starting" | "running" | "complete" | "failed", startedAt: number): any {
	return {
		id,
		jobId: `job_${id}`,
		label: id,
		cwd: "/work",
		status,
		startedAt,
		...(status === "complete" || status === "failed" ? { endedAt: startedAt + 10 } : {}),
		dir: `/state/${id}`,
		eventPath: `/state/${id}/event.json`,
		promptPath: `/state/${id}/prompt.md`,
		stdoutPath: `/state/${id}/stdout.log`,
		stderrPath: `/state/${id}/stderr.log`,
		sessionDir: `/state/${id}/sessions`,
	};
}

test("mergeJobsForSave preserves jobs added by another process", () => {
	const disk = makeMergeJob("ro_disk", "active", 10);
	const memory = makeMergeJob("ro_memory", "active", 20);
	assert.deepEqual(mergeJobsForSave([memory], [disk], [], [memory.id]).map((job) => job.id), ["ro_disk", "ro_memory"]);
});

test("mergeJobsForSave does not resurrect a terminal job absent from disk", () => {
	const staleTerminal = makeMergeJob("ro_pruned", "fired", 20);
	assert.deepEqual(mergeJobsForSave([staleTerminal], []), []);
});

test("mergeJobsForSave restores a missing terminal job only when pending delivery protects it", () => {
	const pendingTerminal = makeMergeJob("ro_pending", "fired", 20);
	assert.deepEqual(mergeJobsForSave([pendingTerminal], [], [pendingTerminal.id]).map((job) => job.id), [pendingTerminal.id]);
});

test("mergeJobsForSave does not resurrect terminal jobs from stale active memory", () => {
	const staleActive = { ...makeMergeJob("ro_same", "active", 10), updatedAt: 1_000_000, leafState: { root: { lastCheckAt: 1_000_000, lastValue: false } } };
	const diskFired = makeMergeJob("ro_same", "fired", 20);
	const merged = mergeJobsForSave([staleActive], [diskFired]);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].status, "fired");
	assert.equal(merged[0].updatedAt, 20);
});

test("mergeJobsForSave preserves newer re-armed active job over stale terminal copy", () => {
	const staleTerminal = makeMergeJob("ro_same", "fired", 20);
	const rearmedActive = { ...makeMergeJob("ro_same", "active", 30), maxFires: 2, fireCount: 1, lastFiredAt: 30, rearmPending: true };
	const merged = mergeJobsForSave([rearmedActive], [staleTerminal]);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].status, "active");
	assert.equal(merged[0].fireCount, 1);
});

test("mergeJobsForSave never lets stale multi-fire active state override cancellation", () => {
	const cancelled = { ...makeMergeJob("ro_same", "cancelled", 20), fireCount: 1 };
	const staleActive = { ...makeMergeJob("ro_same", "active", 1_000), maxFires: 3, fireCount: 1, lastFiredAt: 30, rearmPending: true };
	const merged = mergeJobsForSave([staleActive], [cancelled]);
	assert.equal(merged[0].status, "cancelled");
});

test("mergeJobsForSave keeps the newer active copy", () => {
	const disk = makeMergeJob("ro_same", "active", 10);
	const memory = { ...makeMergeJob("ro_same", "active", 30), label: "newer" };
	const merged = mergeJobsForSave([memory], [disk]);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].label, "newer");
});

test("mergeJobsForSave keeps in-memory leaf-state progress on timestamp ties", () => {
	const disk = makeMergeJob("ro_same", "active", 10);
	const memory = { ...makeMergeJob("ro_same", "active", 10), leafState: { root: { lastCheckAt: 20, lastValue: false } } };
	const merged = mergeJobsForSave([memory], [disk]);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].leafState.root.lastCheckAt, 20);
});

test("mergeJobsForPrunedSave preserves active jobs added by another process while pruning stale terminal jobs", () => {
	const cutoff = 100;
	const staleTerminal = makeMergeJob("ro_old", "fired", 50);
	const concurrentActive = makeMergeJob("ro_new_active", "active", 120);
	const memoryKept = makeMergeJob("ro_memory_active", "active", 110);
	const merged = mergeJobsForPrunedSave([memoryKept], [staleTerminal, concurrentActive], cutoff);
	assert.deepEqual(merged.map((job) => job.id), ["ro_memory_active", "ro_new_active"]);
	assert.equal(merged.some((job) => job.id === "ro_old"), false);
});

test("mergeJobsForPrunedSave keeps protected terminal fired events", () => {
	const protectedTerminal = makeMergeJob("ro_protected", "fired", 50);
	const merged = mergeJobsForPrunedSave([], [protectedTerminal], 100, ["ro_protected"]);
	assert.deepEqual(merged.map((job) => job.id), ["ro_protected"]);
});

test("retainBoundedJobs caps thousands of terminal jobs while preserving active and protected jobs", () => {
	const terminal = Array.from({ length: 4_000 }, (_, index) => makeMergeJob(`ro_terminal_${index}`, "fired", index + 1));
	const active = makeMergeJob("ro_active", "active", 5_000);
	const protectedOld = makeMergeJob("ro_protected_old", "fired", 1);
	const retained = retainBoundedJobs([...terminal, active, protectedOld], 0, 500, [protectedOld.id]);
	assert.equal(retained.filter((job) => job.status !== "active" && job.id !== protectedOld.id).length, 500);
	assert.equal(retained.some((job) => job.id === active.id), true);
	assert.equal(retained.some((job) => job.id === protectedOld.id), true);
	assert.equal(retained.some((job) => job.id === "ro_terminal_3999"), true);
	assert.equal(retained.some((job) => job.id === "ro_terminal_0"), false);
});

test("retainBoundedJobs applies age retention before the count bound", () => {
	const old = makeMergeJob("ro_old", "cancelled", 50);
	const recent = makeMergeJob("ro_recent", "fired", 150);
	assert.deepEqual(retainBoundedJobs([old, recent], 100, 500).map((job) => job.id), [recent.id]);
});

test("jobsNeedProtectionLookup counts unique terminal ids across memory and disk", () => {
	const terminal = Array.from({ length: 500 }, (_, index) => makeMergeJob(`ro_terminal_${index}`, "fired", 1_000 + index));
	assert.equal(jobsNeedProtectionLookup(terminal, structuredClone(terminal), 0, 500), false);
	assert.equal(jobsNeedProtectionLookup([...terminal, makeMergeJob("ro_extra", "fired", 2_000)], terminal, 0, 500), true);
});

test("mergeJobsForReload preserves active in-memory latch progress over stale disk", () => {
	const disk = makeMergeJob("ro_same", "active", 10);
	const memory = { ...makeMergeJob("ro_same", "active", 20), latches: { root: { trueAt: 20, summary: "latched" } } };
	const merged = mergeJobsForReload([memory], [disk]);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].latches.root.summary, "latched");
});

test("mergeJobsForReload preserves explicit unsaved inserts but does not resurrect absent stale jobs", () => {
	const memoryInsert = makeMergeJob("ro_insert", "active", 20);
	const staleActive = makeMergeJob("ro_stale_active", "active", 30);
	const memoryTerminal = makeMergeJob("ro_old_fired", "fired", 20);
	const disk = makeMergeJob("ro_disk", "active", 10);
	const merged = mergeJobsForReload([memoryInsert, staleActive, memoryTerminal], [disk], [memoryInsert.id]);
	assert.deepEqual(merged.map((job) => job.id), ["ro_disk", "ro_insert"]);
});

test("mergeHandlersForSave preserves handler runs added by another process", () => {
	const disk = makeHandler("roh_disk", "running", 10);
	const memory = makeHandler("roh_memory", "starting", 20);
	assert.deepEqual(mergeHandlersForSave([memory], [disk]).map((run) => run.id), ["roh_disk", "roh_memory"]);
});

test("mergeHandlersForSave keeps terminal handler over stale active memory", () => {
	const memory = makeHandler("roh_same", "running", 10);
	const disk = makeHandler("roh_same", "complete", 20);
	const merged = mergeHandlersForSave([memory], [disk]);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].status, "complete");
});

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

test("normalizeCondition: exec command argv arrays become shell-safe command strings", () => {
	const c = normalizeCondition({ exec: { command: ["bash", "/tmp/watch pr.sh"] } }) as any;
	assert.equal(c.type, "exec");
	assert.equal(c.command, "bash '/tmp/watch pr.sh'");
});

test("jobEvaluationPersistenceKey ignores observation-only poll metadata", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "return-on-semantic-poll-"));
	const job = { ...makeJob({ type: "file", path: "missing", contains: "READY", every: 1 }), cwd: dir };
	await evaluateCondition(job, job.condition, "root", false);
	const firstKey = jobEvaluationPersistenceKey(job);
	const firstCheckAt = job.leafState.root.lastCheckAt;
	await new Promise((resolve) => setTimeout(resolve, 5));
	await evaluateCondition(job, job.condition, "root", false);
	assert.equal(jobEvaluationPersistenceKey(job), firstKey);
	assert.notEqual(job.leafState.root.lastCheckAt, firstCheckAt);
	await fs.rm(dir, { recursive: true, force: true });
});

test("revisionMarkerIsCurrent detects the jobs-rename-before-marker crash window", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "return-on-revision-window-"));
	const jobsFile = path.join(dir, "jobs.json");
	const revisionFile = path.join(dir, "jobs.revision");
	await fs.writeFile(jobsFile, "{}", "utf8");
	await fs.writeFile(revisionFile, "old\n", "utf8");
	const old = new Date(1_000);
	const newer = new Date(2_000);
	await fs.utimes(revisionFile, old, old);
	await fs.utimes(jobsFile, newer, newer);
	assert.equal(await revisionMarkerIsCurrent("old", jobsFile, revisionFile), false);
	await fs.utimes(revisionFile, newer, newer);
	assert.equal(await revisionMarkerIsCurrent("old", jobsFile, revisionFile), true);
	assert.equal(await revisionMarkerIsCurrent("different", jobsFile, revisionFile), false);
	await fs.rm(dir, { recursive: true, force: true });
});

test("withJobsFileLock serializes concurrent writers and does not steal a live lock", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "return-on-flock-"));
	const lockFile = path.join(dir, "jobs.lock");
	let releaseFirst!: () => void;
	let firstAcquired!: () => void;
	const acquired = new Promise<void>((resolve) => { firstAcquired = resolve; });
	const hold = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const first = withJobsFileLock(async () => {
		firstAcquired();
		await hold;
	}, lockFile, 1_000);
	await acquired;
	await assert.rejects(withJobsFileLock(async () => undefined, lockFile, 50), /Timed out acquiring/);
	releaseFirst();
	await first;
	let counter = 0;
	await Promise.all(Array.from({ length: 8 }, () => withJobsFileLock(async () => {
		const observed = counter;
		await new Promise((resolve) => setTimeout(resolve, 2));
		counter = observed + 1;
	}, lockFile, 2_000)));
	assert.equal(counter, 8);
	await fs.rm(dir, { recursive: true, force: true });
});

test("withJobsFileLockRetry acquires after transient contention", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "return-on-flock-retry-"));
	const lockFile = path.join(dir, "jobs.lock");
	let releaseFirst!: () => void;
	let firstAcquired!: () => void;
	const acquired = new Promise<void>((resolve) => { firstAcquired = resolve; });
	const hold = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const first = withJobsFileLock(async () => {
		firstAcquired();
		await hold;
	}, lockFile, 1_000);
	await acquired;
	setTimeout(releaseFirst, 80);
	let retried = false;
	await withJobsFileLockRetry(async () => { retried = true; }, lockFile, 30, 4, 10);
	assert.equal(retried, true);
	await first;
	await fs.rm(dir, { recursive: true, force: true });
});

test("withJobsFileLock recovers after a dead lock owner", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "return-on-flock-dead-"));
	const lockFile = path.join(dir, "jobs.lock");
	await new Promise<void>((resolve, reject) => {
		const child = spawn("flock", ["-x", lockFile, "sh", "-c", "kill -9 $$"]);
		child.once("error", reject);
		child.once("close", () => resolve());
	});
	let acquired = false;
	await withJobsFileLock(async () => { acquired = true; }, lockFile, 1_000);
	assert.equal(acquired, true);
	await fs.rm(dir, { recursive: true, force: true });
});

test("evaluateCondition blocks tampered exec leaves when job.allowExec is not true", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "return-on-exec-block-"));
	const marker = path.join(dir, "marker");
	const job = { ...makeJob({ type: "timer", after: "1m" }), cwd: dir, allowExec: false };
	const result = await evaluateCondition(job, normalizeCondition({ type: "exec", command: `touch ${JSON.stringify(marker)}` }), "root", false);
	assert.equal(result.value, false);
	assert.match(result.summary, /exec check blocked/);
	await assert.rejects(fs.stat(marker), /ENOENT/);
});

test("firedEventNeedsJobProtection preserves pending delivery but releases completed handlers", () => {
	const base: any = { deliveryStatus: "wake-sent", deliveredAt: 10 };
	assert.equal(firedEventNeedsJobProtection({ ...base, deliveryStatus: "pending", deliveredAt: undefined }, new Set()), true);
	assert.equal(firedEventNeedsJobProtection({ ...base, deliveryStatus: "failed" }, new Set()), true);
	assert.equal(firedEventNeedsJobProtection({ ...base, deliveryStatus: "queued" }, new Set()), true);
	assert.equal(firedEventNeedsJobProtection({ ...base, deliveryStatus: "handler-launched", handlerRunId: "run_active" }, new Set(["run_active"])), true);
	assert.equal(firedEventNeedsJobProtection({ ...base, deliveryStatus: "handler-launched", handlerRunId: "run_complete" }, new Set()), false);
	assert.equal(firedEventNeedsJobProtection(base, new Set()), false);
});

test("applyFiredEventToJob preserves re-armed active multi-fire event snapshots", () => {
	const existing = makeMergeJob("ro_multi", "active", 10);
	const snapshot = { ...makeMergeJob("ro_multi", "active", 30), maxFires: 3, fireCount: 1, rearmPending: true };
	const event: any = { job: snapshot };
	const result = applyFiredEventToJob(existing, event);
	assert.equal(result.job.status, "active");
	assert.equal(result.job.fireCount, 1);
	assert.equal(result.job.rearmPending, true);
	assert.equal(existing.fireCount, 1);
});

test("tryClaimFiredEvent allows only one active claimant and reclaims stale claims", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "return-on-claim-"));
	const eventPath = path.join(dir, "ro_claim.json");
	await fs.writeFile(eventPath, "{}", "utf8");
	assert.equal(await tryClaimFiredEvent(eventPath, "one", 1_000, 10_000), true);
	const claimPath = `${eventPath}.claim`;
	const firstClaim = JSON.parse(await fs.readFile(claimPath, "utf8"));
	assert.equal(await tryClaimFiredEvent(eventPath, "two", 2_000, 10_000), false);
	const old = new Date(0);
	await fs.utimes(claimPath, old, old);
	assert.equal(await tryClaimFiredEvent(eventPath, "three", 20_000, 1_000), true);
	let claim = JSON.parse(await fs.readFile(claimPath, "utf8"));
	assert.equal(claim.owner, "three");
	await releaseFiredEventClaim(eventPath, firstClaim.token);
	claim = JSON.parse(await fs.readFile(claimPath, "utf8"));
	assert.equal(claim.owner, "three");
	await fs.utimes(claimPath, old, old);
	const reclaimed = await Promise.all([
		tryClaimFiredEvent(eventPath, "four", 30_000, 1_000),
		tryClaimFiredEvent(eventPath, "five", 30_000, 1_000),
	]);
	assert.equal(reclaimed.filter(Boolean).length, 1);
	claim = JSON.parse(await fs.readFile(claimPath, "utf8"));
	assert.equal(["four", "five"].includes(claim.owner), true);
});

test("patchFiredEvent preserves multi-fire event path and original capsule fields", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "return-on-fired-event-"));
	const eventPath = path.join(dir, "ro_multi.2.json");
	const job = { ...makeMergeJob("ro_multi", "active", 90), maxFires: 3, fireCount: 2 };
	const original = {
		version: 1,
		event: "return_on.fired",
		id: "ro_multi",
		jobId: "ro_multi",
		label: "multi",
		reason: "second fire",
		createdAt: 10,
		firedAt: 100,
		cwd: dir,
		resume: "resume",
		job,
		deliveryStatus: "pending",
	};
	await fs.writeFile(eventPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
	const patched = await patchFiredEvent(eventPath, { deliveryStatus: "wake-sent", deliveredAt: 120, lastAttemptAt: 120 });
	const onDisk = JSON.parse(await fs.readFile(eventPath, "utf8"));
	assert.equal(patched.firedAt, 100);
	assert.equal(onDisk.reason, "second fire");
	assert.equal(onDisk.job.fireCount, 2);
	assert.equal(onDisk.deliveryStatus, "wake-sent");
	assert.equal(onDisk.deliveredAt, 120);
});

test("pruneTempFiles removes only stale atomic write remnants", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prune-tmp-"));
	const staleTmp = path.join(dir, "jobs.json.1.2.tmp");
	const freshTmp = path.join(dir, "handlers.json.1.2.tmp");
	const ordinary = path.join(dir, "keep.txt");
	await fs.writeFile(staleTmp, "stale");
	await fs.writeFile(freshTmp, "fresh");
	await fs.writeFile(ordinary, "ordinary");
	await fs.utimes(staleTmp, 1, 1);
	const cutoff = Date.now() - 1_000;
	assert.equal(await pruneTempFiles(dir, cutoff, false), 1);
	assert.deepEqual((await fs.readdir(dir)).sort(), ["handlers.json.1.2.tmp", "keep.txt"]);
});

test("normalizeCondition: file requires non-empty path", () => {
	assert.throws(() => normalizeCondition({ type: "file" }), /file condition requires path/);
});

test("normalizeCondition: url conditions require http or https", () => {
	assert.throws(() => normalizeCondition({ type: "url", url: "data:text/plain,ok" }), /url must use http or https/);
	assert.throws(() => normalizeCondition({ type: "url", url: "file:///tmp/x" }), /url must use http or https/);
	const c = normalizeCondition({ type: "url", url: "http://127.0.0.1:1234/health" }) as any;
	assert.equal(c.url, "http://127.0.0.1:1234/health");
});

test("readResponseTextLimited caps url response bodies", async () => {
	const response = new Response("abcdef");
	assert.equal(await readResponseTextLimited(response, 3), "abc\n[truncated 3 bytes]");
});

test("requestContentLengthExceedsLimit detects over-limit webhook bodies", () => {
	assert.equal(requestContentLengthExceedsLimit({ "content-length": "65537" }, 65536), true);
	assert.equal(requestContentLengthExceedsLimit({ "content-length": "65536" }, 65536), false);
	assert.equal(requestContentLengthExceedsLimit({ "content-length": "not-a-number" }, 65536), false);
});

test("normalizeCondition: webhook path must start with /", () => {
	assert.throws(() => normalizeCondition({ type: "webhook", path: "no-slash" }), /path must start with/);
	const c = normalizeCondition({ type: "webhook", path: "/hook" }) as any;
	assert.equal(c.path, "/hook");
});

test("normalizeCondition: webhook token must be non-empty when provided", () => {
	assert.throws(() => normalizeCondition({ type: "webhook", path: "/hook", token: "" }), /webhook condition token must be a non-empty string/);
	assert.throws(() => normalizeCondition({ type: "webhook", path: "/hook", token: "   " }), /webhook condition token must be a non-empty string/);
});

test("normalizeCondition: unknown type throws", () => {
	assert.throws(() => normalizeCondition({ type: "nope" }), /unsupported condition type/);
});

test("normalizeReturnOnToolParams recovers misplaced job options from condition", () => {
	const params = normalizeReturnOnToolParams({
		label: "pr watcher",
		condition: {
			exec: { command: "exit 0" },
			resume: "wake on PR outcome",
			timeout: "1h",
			checkInEvery: "10m",
			allowExec: true,
		},
	});
	assert.equal(params.resume, "wake on PR outcome");
	assert.equal(params.timeout, "1h");
	assert.equal(params.checkInEvery, "10m");
	assert.equal(params.allowExec, true);
	assert.deepEqual(params.condition, { exec: { command: "exit 0" } });
	const condition = normalizeCondition(params.condition) as any;
	assert.equal(condition.type, "exec");
	assert.equal(condition.command, "exit 0");
});

test("normalizeReturnOnToolParams gives clear missing-resume guidance", () => {
	assert.throws(
		() => normalizeReturnOnToolParams({ condition: { type: "timer", after: "1s" } }),
		/return_on requires a top-level resume string/,
	);
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
