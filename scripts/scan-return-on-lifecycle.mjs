#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
let jsonOut = false;
let staleMs = 10 * 60_000;
let sinceMs;
let stateDir = join(homedir(), ".local", "state", "pi-return-on");

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json") jsonOut = true;
  else if (arg === "--stale-min") {
    const minutes = Number(args[++i]);
    if (!Number.isFinite(minutes) || minutes <= 0) die(`Invalid --stale-min value: ${args[i]}`);
    staleMs = minutes * 60_000;
  } else if (arg === "--days") {
    const days = Number(args[++i]);
    if (!Number.isFinite(days) || days <= 0) die(`Invalid --days value: ${args[i]}`);
    sinceMs = Date.now() - days * 86_400_000;
  } else if (arg === "--since") {
    const parsed = Date.parse(args[++i]);
    if (!Number.isFinite(parsed)) die(`Invalid --since value: ${args[i]}`);
    sinceMs = parsed;
  } else if (arg === "--help" || arg === "-h") {
    console.log(`Usage: scan-return-on-lifecycle [--json] [--days N|--since ISO] [--stale-min N] [stateDir]\n\nScans ~/.local/state/pi-return-on by default for lifecycle health: timeouts, stale/expired active jobs, failed/stale handlers, and fired-event delivery states.`);
    process.exit(0);
  } else stateDir = resolve(arg);
}

function die(message) {
  console.error(message);
  process.exit(2);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(file) {
  try {
    return readFileSync(file, "utf8")
      .split(/\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line); } catch { return undefined; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function bucket(map, key) {
  const normalized = key ?? "<missing>";
  map[normalized] = (map[normalized] ?? 0) + 1;
}

function sample(items, mapper, limit = 8) {
  return items.slice(0, limit).map(mapper);
}

function ageMs(ts, now = Date.now()) {
  return typeof ts === "number" && Number.isFinite(ts) ? now - ts : undefined;
}

function formatMs(ms) {
  if (ms === undefined) return "?";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function newestLeafCheckAt(job) {
  const times = Object.values(job.leafState ?? {})
    .map((state) => state && typeof state.lastCheckAt === "number" ? state.lastCheckAt : undefined)
    .filter((value) => value !== undefined);
  return times.length ? Math.max(...times) : undefined;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const now = Date.now();
const jobsAll = readJson(join(stateDir, "jobs.json"), { jobs: [] }).jobs ?? [];
const handlersAll = readJson(join(stateDir, "handlers.json"), { handlers: [] }).handlers ?? [];
const jobs = sinceMs ? jobsAll.filter((job) => (job.createdAt ?? 0) >= sinceMs || (job.updatedAt ?? 0) >= sinceMs || (job.firedAt ?? 0) >= sinceMs) : jobsAll;
const jobIds = new Set(jobs.map((job) => job.id));
const handlers = sinceMs ? handlersAll.filter((handler) => jobIds.has(handler.jobId) || (handler.startedAt ?? 0) >= sinceMs || (handler.endedAt ?? 0) >= sinceMs) : handlersAll;

const lifecycleAudit = readJsonl(join(stateDir, "lifecycle-audit.jsonl"))
  .filter((entry) => !sinceMs || (entry.timestamp ?? 0) >= sinceMs);

const firedEvents = [];
const firedDir = join(stateDir, "fired");
if (existsSync(firedDir)) {
  for (const name of readdirSync(firedDir)) {
    if (!name.endsWith(".json")) continue;
    const event = readJson(join(firedDir, name), undefined);
    if (!event) continue;
    if (sinceMs && (event.firedAt ?? event.createdAt ?? 0) < sinceMs && !jobIds.has(event.jobId)) continue;
    firedEvents.push({ ...event, file: join(firedDir, name) });
  }
}

const byJobStatus = {};
const byFireReason = {};
for (const job of jobs) {
  bucket(byJobStatus, job.status);
  if (job.status === "fired") bucket(byFireReason, job.fireReason ?? "<none>");
}

const timedOut = jobs.filter((job) => job.status === "fired" && job.fireReason === "timeout");
const active = jobs.filter((job) => job.status === "active");
const activeExpired = active.filter((job) => typeof job.timeoutAt === "number" && job.timeoutAt <= now);
const activeStale = active.filter((job) => ageMs(newestLeafCheckAt(job) ?? job.updatedAt ?? job.createdAt, now) >= staleMs);
const activeNeverChecked = active.filter((job) => newestLeafCheckAt(job) === undefined);

const byHandlerStatus = {};
for (const handler of handlers) bucket(byHandlerStatus, handler.status);
const handlerFailed = handlers.filter((handler) => handler.status === "failed" || (typeof handler.exitCode === "number" && handler.exitCode !== 0));
const handlerInFlight = handlers.filter((handler) => handler.status === "running" || handler.status === "starting");
const handlerStale = handlerInFlight.filter((handler) => ageMs(handler.startedAt, now) >= staleMs);
const handlerDeadPid = handlerInFlight.filter((handler) => pidAlive(handler.pid) === false);
const completeNoSummary = handlers.filter((handler) => handler.status === "complete" && handler.notify !== "none" && !String(handler.summary ?? "").trim());

const byFiredEventStatus = {};
for (const event of firedEvents) bucket(byFiredEventStatus, event.status ?? event.deliveryStatus ?? "<missing>");
const byAuditAction = {};
for (const entry of lifecycleAudit) bucket(byAuditAction, entry.action);
const firedEventUndelivered = firedEvents.filter((event) => !["handler-launched", "wake-sent", "delivered"].includes(event.status ?? event.deliveryStatus));

const handlersByJob = new Map();
for (const handler of handlers) {
  const list = handlersByJob.get(handler.jobId) ?? [];
  list.push(handler);
  handlersByJob.set(handler.jobId, list);
}
const firedJobs = jobs.filter((job) => job.status === "fired");
const firedWithoutObservedDelivery = firedJobs.filter((job) => !firedEvents.some((event) => event.jobId === job.id) && !handlersByJob.has(job.id));
const firedWithOnlyFailedHandlers = firedJobs.filter((job) => {
  const list = handlersByJob.get(job.id) ?? [];
  return list.length > 0 && list.every((handler) => handler.status === "failed" || (typeof handler.exitCode === "number" && handler.exitCode !== 0));
});

const latencies = firedJobs
  .map((job) => (job.firedAt ?? job.updatedAt) - job.createdAt)
  .filter((value) => Number.isFinite(value) && value >= 0)
  .sort((a, b) => a - b);
function quantile(p) {
  if (!latencies.length) return undefined;
  return latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))];
}

function jobSample(job) {
  const lastCheckAt = newestLeafCheckAt(job);
  return {
    id: job.id,
    label: job.label,
    status: job.status,
    age: formatMs(ageMs(job.createdAt, now)),
    lastCheckAge: formatMs(ageMs(lastCheckAt ?? job.updatedAt ?? job.createdAt, now)),
    timeoutAge: typeof job.timeoutAt === "number" ? formatMs(now - job.timeoutAt) : undefined,
    fireReason: job.fireReason,
  };
}

function truncate(value, max = 240) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function handlerSample(handler) {
  return {
    id: handler.id,
    jobId: handler.jobId,
    label: handler.label,
    status: handler.status,
    age: formatMs(ageMs(handler.startedAt, now)),
    pid: handler.pid,
    pidAlive: pidAlive(handler.pid),
    exitCode: handler.exitCode,
    error: truncate(handler.error),
    stderrPath: handler.stderrPath,
  };
}

const report = {
  scannedAt: new Date(now).toISOString(),
  stateDir,
  since: sinceMs ? new Date(sinceMs).toISOString() : null,
  staleThresholdMs: staleMs,
  jobs: {
    total: jobs.length,
    byStatus: byJobStatus,
    fired: firedJobs.length,
    timedOut: timedOut.length,
    timedOutRate: firedJobs.length ? timedOut.length / firedJobs.length : 0,
    byFireReason,
    activeExpired: activeExpired.length,
    activeStale: activeStale.length,
    activeNeverChecked: activeNeverChecked.length,
    firedWithoutObservedDelivery: firedWithoutObservedDelivery.length,
    firedWithOnlyFailedHandlers: firedWithOnlyFailedHandlers.length,
    fireLatencyMs: { count: latencies.length, p50: quantile(0.5), p90: quantile(0.9), max: quantile(1) },
  },
  handlers: {
    total: handlers.length,
    byStatus: byHandlerStatus,
    failed: handlerFailed.length,
    inFlight: handlerInFlight.length,
    staleInFlight: handlerStale.length,
    deadPidInFlight: handlerDeadPid.length,
    completeNoSummary: completeNoSummary.length,
  },
  firedEvents: {
    total: firedEvents.length,
    byStatus: byFiredEventStatus,
    undelivered: firedEventUndelivered.length,
  },
  lifecycleAudit: {
    total: lifecycleAudit.length,
    byAction: byAuditAction,
  },
  samples: {
    timedOut: sample(timedOut, jobSample),
    activeExpired: sample(activeExpired, jobSample),
    activeStale: sample(activeStale, jobSample),
    handlerFailed: sample(handlerFailed, handlerSample),
    handlerStale: sample(handlerStale, handlerSample),
    handlerDeadPid: sample(handlerDeadPid, handlerSample),
    firedWithoutObservedDelivery: sample(firedWithoutObservedDelivery, jobSample),
    firedWithOnlyFailedHandlers: sample(firedWithOnlyFailedHandlers, jobSample),
  },
};

if (jsonOut) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  console.log(`return_on lifecycle scan (${report.scannedAt})`);
  console.log(`jobs: ${jobs.length} ${JSON.stringify(byJobStatus)}; fired=${firedJobs.length}; timedOut=${timedOut.length} (${(report.jobs.timedOutRate * 100).toFixed(1)}%)`);
  console.log(`active: expired=${activeExpired.length}, stale=${activeStale.length}, neverChecked=${activeNeverChecked.length} (stale>${formatMs(staleMs)})`);
  console.log(`handlers: ${handlers.length} ${JSON.stringify(byHandlerStatus)}; failed=${handlerFailed.length}, staleInFlight=${handlerStale.length}, deadPidInFlight=${handlerDeadPid.length}, completeNoSummary=${completeNoSummary.length}`);
  console.log(`fired events: ${firedEvents.length} ${JSON.stringify(byFiredEventStatus)}; undelivered=${firedEventUndelivered.length}`);
  console.log(`lifecycle audit: ${lifecycleAudit.length} ${JSON.stringify(byAuditAction)}`);
  console.log(`fire latency: n=${latencies.length}, p50=${formatMs(quantile(0.5))}, p90=${formatMs(quantile(0.9))}, max=${formatMs(quantile(1))}`);
  const sections = [
    ["Timed out jobs", timedOut, jobSample],
    ["Expired active jobs", activeExpired, jobSample],
    ["Stale/dead in-flight handlers", [...new Map([...handlerStale, ...handlerDeadPid].map((handler) => [handler.id, handler])).values()], handlerSample],
    ["Failed handlers", handlerFailed, handlerSample],
    ["Fired jobs with only failed handlers", firedWithOnlyFailedHandlers, jobSample],
  ];
  for (const [title, items, mapper] of sections) {
    if (!items.length) continue;
    console.log(`\n${title} (showing ${Math.min(5, items.length)}/${items.length}):`);
    for (const item of sample(items, mapper, 5)) console.log(`- ${JSON.stringify(item)}`);
  }
}
