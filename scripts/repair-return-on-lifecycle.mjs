#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { getFiredDir, getHandlersPath, getJobsPath, getLifecycleAuditFile, getStateDir } from "./lib/state-paths.mjs";

const args = process.argv.slice(2);
let apply = false;
let staleMs = 10 * 60_000;
let stateDir = getStateDir();

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--apply") apply = true;
  else if (arg === "--dry-run") apply = false;
  else if (arg === "--stale-min") {
    const minutes = Number(args[++i]);
    if (!Number.isFinite(minutes) || minutes <= 0) die(`Invalid --stale-min value: ${args[i]}`);
    staleMs = minutes * 60_000;
  } else if (arg === "--help" || arg === "-h") {
    console.log(`Usage: repair-return-on-lifecycle [--apply] [--stale-min N] [stateDir]\n\nDry-run by default. Repairs two safe lifecycle issues:\n- expired active jobs: mark fired with reason=timeout and create a pending fired-event capsule for delivery on next Pi startup\n- stale in-flight handlers with dead pids: reconcile to failed/complete from stderr/stdout and record an end state\n\nUse --apply to write changes.`);
    process.exit(0);
  } else stateDir = resolve(arg);
}

function die(message) {
  console.error(message);
  process.exit(2);
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, file);
}

function appendLifecycleAudit(action, fields = {}) {
  mkdirSync(stateDir, { recursive: true });
  const entry = { version: 1, event: "return_on.lifecycle", timestamp: Date.now(), action, source: "repair-script", ...fields };
  appendFileSync(getLifecycleAuditFile(stateDir), `${JSON.stringify(entry)}\n`, "utf8");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readText(file) {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}

function truncate(text, max = 24 * 1024) {
  text = String(text ?? "");
  return text.length > max ? text.slice(0, max) : text;
}

function firedEventPath(job, fireCount) {
  const name = fireCount && fireCount > 1 ? `${job.id}.${fireCount}.json` : `${job.id}.json`;
  return join(getFiredDir(stateDir), name);
}

function writePendingFiredEvent(job, reason) {
  mkdirSync(getFiredDir(stateDir), { recursive: true });
  const eventPath = firedEventPath(job, job.fireCount);
  const event = {
    version: 1,
    event: "return_on.fired",
    id: job.id,
    jobId: job.id,
    label: job.label,
    reason,
    createdAt: job.createdAt,
    firedAt: job.lastFiredAt ?? job.firedAt ?? Date.now(),
    cwd: job.cwd,
    ...(job.sessionFile ? { sessionFile: job.sessionFile } : {}),
    resume: job.resume,
    job,
    deliveryStatus: "pending",
    lastAttemptAt: Date.now(),
  };
  atomicWriteJson(eventPath, event);
  return eventPath;
}

const now = Date.now();
const jobsFile = getJobsPath(stateDir);
const handlersFile = getHandlersPath(stateDir);
const jobsState = readJson(jobsFile, { version: 1, jobs: [] });
const handlersState = readJson(handlersFile, { version: 1, handlers: [] });
const jobs = Array.isArray(jobsState.jobs) ? jobsState.jobs : [];
const handlers = Array.isArray(handlersState.handlers) ? handlersState.handlers : [];
const changes = [];

for (const job of jobs) {
  if (job.status !== "active") continue;
  if (typeof job.timeoutAt !== "number" || job.timeoutAt > now) continue;
  const previousStatus = job.status;
  job.fireCount = (job.fireCount ?? 0) + 1;
  job.lastFiredAt = job.timeoutAt;
  job.firedAt = job.firedAt ?? job.timeoutAt;
  job.updatedAt = now;
  job.fireReason = "timeout";
  job.status = "fired";
  const eventPath = firedEventPath(job, job.fireCount);
  changes.push({ type: "expire_active_job", id: job.id, label: job.label, previousStatus, eventPath });
  if (apply) {
    writePendingFiredEvent(job, "timeout");
    appendLifecycleAudit("job_repaired_timeout", { id: job.id, label: job.label, timeoutAt: job.timeoutAt, eventPath });
  }
}

for (const run of handlers) {
  if (run.status !== "running" && run.status !== "starting") continue;
  if (now - (run.startedAt ?? now) < staleMs) continue;
  if (pidAlive(run.pid) !== false) continue;
  const stderr = readText(run.stderrPath).trim();
  const stdout = readText(run.stdoutPath).trim();
  run.endedAt = run.endedAt ?? now;
  run.exitCode = run.exitCode ?? null;
  run.signal = run.signal ?? null;
  run.summary = truncate(stdout || stderr);
  run.finishSource = "repair-script";
  if (run.status === "starting" || stderr) {
    run.status = "failed";
    run.error = run.error || stderr || "handler process is no longer running";
  } else {
    run.status = "complete";
  }
  changes.push({ type: "reconcile_dead_handler", id: run.id, jobId: run.jobId, label: run.label, status: run.status, pid: run.pid });
  if (apply) appendLifecycleAudit("handler_repaired_dead_pid", { id: run.id, jobId: run.jobId, label: run.label, status: run.status, pid: run.pid, error: run.error });
}

if (apply) {
  atomicWriteJson(jobsFile, { version: jobsState.version ?? 1, jobs });
  atomicWriteJson(handlersFile, { version: handlersState.version ?? 1, handlers });
}

console.log(`${apply ? "Applied" : "Dry-run"} return_on lifecycle repair: ${changes.length} change(s)`);
const byType = changes.reduce((acc, change) => { acc[change.type] = (acc[change.type] ?? 0) + 1; return acc; }, {});
console.log(JSON.stringify(byType, null, 2));
for (const change of changes.slice(0, 20)) console.log(`- ${JSON.stringify(change)}`);
if (!apply && changes.length) console.log("Re-run with --apply to write changes.");
