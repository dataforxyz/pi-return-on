import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const fixture = path.join(repoRoot, "test", "fixtures", "state-writer-child.ts");

function startWriter(stateDir: string, writerId: string, mode = "register", extraEnv: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
	return spawn(tsxBin, [fixture], {
		cwd: repoRoot,
		env: {
			...process.env,
			...extraEnv,
			PI_RETURN_ON_STATE_DIR: stateDir,
			RETURN_ON_WRITER_ID: writerId,
			RETURN_ON_WRITER_MODE: mode,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
}

async function waitForOutput(child: ChildProcessWithoutNullStreams, marker: string, timeoutMs = 10_000): Promise<string> {
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += String(chunk); });
	child.stderr.on("data", (chunk) => { stderr += String(chunk); });
	return await new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${marker}; stdout=${stdout}; stderr=${stderr}`)), timeoutMs);
		const check = () => {
			if (!stdout.includes(marker)) return;
			clearTimeout(timeout);
			resolve(stdout);
		};
		child.stdout.on("data", check);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code) => {
			if (!stdout.includes(marker)) {
				clearTimeout(timeout);
				reject(new Error(`writer exited with ${code}; stdout=${stdout}; stderr=${stderr}`));
			}
		});
		check();
	});
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 10_000): Promise<void> {
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += String(chunk); });
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr += String(chunk); });
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (code === 0) resolve();
			else reject(new Error(`writer exited with ${code}; stdout=${stdout}; stderr=${stderr}`));
		};
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error(`writer did not exit; stdout=${stdout}; stderr=${stderr}`));
		}, timeoutMs);
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", finish);
		if (child.exitCode !== null) finish(child.exitCode);
	});
}

async function readJobsDocument(stateDir: string): Promise<any> {
	return JSON.parse(await fs.readFile(path.join(stateDir, "jobs.json"), "utf8"));
}

async function readJobs(stateDir: string): Promise<any[]> {
	return (await readJobsDocument(stateDir)).jobs;
}

async function assertJobsRevisionMatchesContent(stateDir: string): Promise<void> {
	const document = await readJobsDocument(stateDir);
	const expected = createHash("sha256").update(JSON.stringify(document.jobs)).digest("hex");
	assert.equal(document.revision, expected);
	assert.equal((await fs.readFile(path.join(stateDir, "jobs.revision"), "utf8")).trim(), expected);
}

test("cross-process jobs lock preserves concurrent registrations", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "return-on-concurrent-register-"));
	try {
		const writers = Array.from({ length: 8 }, (_, index) => startWriter(stateDir, `writer-${index}`));
		await Promise.all(writers.map((writer) => waitForExit(writer)));
		const jobs = await readJobs(stateDir);
		assert.equal(jobs.length, 8);
		assert.deepEqual(new Set(jobs.map((job) => job.label)), new Set(Array.from({ length: 8 }, (_, index) => `writer writer-${index}`)));
		assert.equal(jobs.every((job) => job.status === "active"), true);
		await assertJobsRevisionMatchesContent(stateDir);
	} finally {
		await fs.rm(stateDir, { recursive: true, force: true });
	}
});

test("performance canary bounds 4,000 recent terminal jobs under concurrent startup writers", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "return-on-performance-canary-"));
	try {
		const now = Date.now();
		const terminalJobs = Array.from({ length: 4_000 }, (_, index) => ({
			id: `ro_terminal_${index}`,
			label: `terminal ${index}`,
			cwd: stateDir,
			createdAt: now - 10_000 + index,
			updatedAt: now - 10_000 + index,
			status: "fired",
			condition: { type: "timer", after: "1s" },
			resume: "done",
			firedAt: now - 10_000 + index,
			latches: {},
			leafState: {},
		}));
		await fs.writeFile(path.join(stateDir, "jobs.json"), JSON.stringify({ version: 1, jobs: terminalJobs }, null, 2), "utf8");
		const firedDir = path.join(stateDir, "fired");
		await fs.mkdir(firedDir, { recursive: true });
		await Promise.all(Array.from({ length: 1_000 }, (_, index) => {
			const job = terminalJobs[index];
			return fs.writeFile(path.join(firedDir, `${job.id}.json`), JSON.stringify({
				version: 1,
				event: "return_on.fired",
				id: job.id,
				jobId: job.id,
				label: job.label,
				reason: "canary",
				createdAt: job.createdAt,
				firedAt: job.firedAt,
				cwd: stateDir,
				resume: job.resume,
				job,
				deliveryStatus: "wake-sent",
				deliveredAt: now,
			}), "utf8");
		}));
		const startedAt = Date.now();
		const writers = Array.from({ length: 4 }, (_, index) => startWriter(stateDir, `canary-${index}`));
		await Promise.all(writers.map((writer) => waitForExit(writer, 20_000)));
		const elapsedMs = Date.now() - startedAt;
		const jobs = await readJobs(stateDir);
		assert.equal(jobs.filter((job) => job.status !== "active").length, 500);
		assert.equal(jobs.filter((job) => job.status === "active").length, 4);
		assert.equal(jobs.some((job) => job.id === "ro_terminal_0"), false);
		assert.equal(jobs.some((job) => job.id === "ro_terminal_3999"), true);
		assert.ok(elapsedMs < 20_000, `performance canary exceeded 20s: ${elapsedMs}ms`);
		const stat = await fs.stat(path.join(stateDir, "jobs.json"));
		assert.ok(stat.size < 2_000_000, `bounded jobs state remained too large: ${stat.size} bytes`);
		await assertJobsRevisionMatchesContent(stateDir);
	} finally {
		await fs.rm(stateDir, { recursive: true, force: true });
	}
});

test("pending insert intent survives lock timeout and commits on a later save", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "return-on-insert-retry-"));
	try {
		const lockFile = path.join(stateDir, "jobs.lock");
		const holder = spawn("/usr/bin/flock", ["-x", lockFile, "/bin/sh", "-c", "printf 'LOCKED\\n'; IFS= read -r _ || :"], { stdio: ["pipe", "pipe", "pipe"] });
		await waitForOutput(holder, "LOCKED");
		const writer = startWriter(stateDir, "retry", "retry-after-lock-timeout", { PI_RETURN_ON_LOCK_TIMEOUT_MS: "30" });
		await waitForOutput(writer, "SAVE_FAILED_PENDING");
		holder.stdin.end();
		await waitForExit(holder);
		const now = Date.now();
		const unrelated = {
			id: "ro_unrelated_disk",
			label: "unrelated disk job",
			cwd: stateDir,
			createdAt: now,
			updatedAt: now,
			status: "active",
			condition: { type: "timer", after: "1h" },
			resume: "unrelated",
			latches: {},
			leafState: {},
		};
		const diskJobs = [unrelated];
		const revision = createHash("sha256").update(JSON.stringify(diskJobs)).digest("hex");
		await fs.writeFile(path.join(stateDir, "jobs.json"), JSON.stringify({ version: 1, revision, jobs: diskJobs }, null, 2), "utf8");
		await fs.writeFile(path.join(stateDir, "jobs.revision"), `${revision}\n`, "utf8");
		await new Promise((resolve) => setTimeout(resolve, 200));
		writer.stdin.write("GO\n");
		await waitForExit(writer);
		const jobs = await readJobs(stateDir);
		assert.deepEqual(new Set(jobs.map((job) => job.label)), new Set(["writer retry first", "unrelated disk job"]));
		assert.equal(jobs.filter((job) => job.label === "writer retry first").length, 1);
		assert.equal(jobs.every((job) => job.status === "active"), true);
		await assertJobsRevisionMatchesContent(stateDir);
	} finally {
		await fs.rm(stateDir, { recursive: true, force: true });
	}
});

test("a stale process save cannot resurrect a formerly active job after its terminal record is pruned", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "return-on-stale-resurrection-"));
	try {
		const now = Date.now();
		const staleJob = {
			id: "ro_stale_active",
			label: "stale active",
			cwd: stateDir,
			sessionFile: path.join(stateDir, "stale.jsonl"),
			createdAt: now - 100_000,
			updatedAt: now - 90_000,
			status: "active",
			condition: { type: "timer", after: "1s" },
			resume: "old resume",
			latches: {},
			leafState: { root: { lastCheckAt: now, lastValue: false } },
		};
		await fs.mkdir(stateDir, { recursive: true });
		await fs.writeFile(path.join(stateDir, "jobs.json"), JSON.stringify({ version: 1, jobs: [staleJob] }, null, 2), "utf8");
		const writer = startWriter(stateDir, "stale", "stale-writer");
		await waitForOutput(writer, "READY");

		const jobs: any[] = [];
		const revision = createHash("sha256").update(JSON.stringify(jobs)).digest("hex");
		await fs.writeFile(path.join(stateDir, "jobs.json"), JSON.stringify({ version: 1, revision, jobs }, null, 2), "utf8");
		await fs.writeFile(path.join(stateDir, "jobs.revision"), `${revision}\n`, "utf8");
		writer.stdin.write("GO\n");
		await waitForExit(writer);

		const saved = await readJobs(stateDir);
		assert.equal(saved.some((job) => job.id === staleJob.id), false);
		assert.equal(saved.length, 1);
		assert.equal(saved[0].label, "writer stale");
		assert.equal(saved[0].status, "active");
		await assertJobsRevisionMatchesContent(stateDir);
	} finally {
		await fs.rm(stateDir, { recursive: true, force: true });
	}
});
