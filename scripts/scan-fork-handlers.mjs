#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_STALE_MS = 10 * 60 * 1000;
const DEFAULT_SINCE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_STATE_ROOT = join(homedir(), ".local", "state");
const SOURCES = [
  { name: "pi-intercom", file: join(DEFAULT_STATE_ROOT, "pi-intercom", "handlers.json"), arrayKey: "runs" },
  { name: "pi-subagents", file: join(DEFAULT_STATE_ROOT, "pi-subagents", "handlers.json"), arrayKey: "handlers" },
  { name: "pi-return-on", file: join(DEFAULT_STATE_ROOT, "pi-return-on", "handlers.json"), arrayKey: "handlers" },
];

function usage() {
  console.log(`Usage: scan-fork-handlers [--json] [--days N|--since ISO|duration] [--stale-min N] [--state-root DIR] [--source NAME] [--include-sessions]\n\nScans fork-handler state/logs for pi-intercom, pi-subagents, and pi-return-on.\n\nFinds failed/stale/dead handlers, spawn/fork launch failures, non-empty stderr, empty summaries, and (with --include-sessions) direct-wait shell commands inside handler session logs.\n`);
}

function parseDuration(raw) {
  if (!raw) return undefined;
  const value = String(raw).trim();
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const mult = unit === "d" ? 86400000 : unit === "h" ? 3600000 : unit === "m" ? 60000 : unit === "s" ? 1000 : 1;
  return n * mult;
}

function parseArgs(argv) {
  const opts = { json: false, sinceMs: Date.now() - DEFAULT_SINCE_MS, staleMs: DEFAULT_STALE_MS, stateRoot: DEFAULT_STATE_ROOT, sources: [], includeSessions: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--all") opts.sinceMs = undefined;
    else if (arg === "--include-sessions") opts.includeSessions = true;
    else if (arg === "--days") opts.sinceMs = Date.now() - Number(argv[++i]) * 86400000;
    else if (arg === "--since") {
      const raw = argv[++i];
      const dur = parseDuration(raw);
      const iso = Date.parse(raw);
      opts.sinceMs = dur !== undefined ? Date.now() - dur : Number.isFinite(iso) ? iso : undefined;
      if (opts.sinceMs === undefined) throw new Error(`invalid --since value: ${raw}`);
    }
    else if (arg === "--stale-min") opts.staleMs = Number(argv[++i]) * 60000;
    else if (arg === "--state-root") opts.stateRoot = argv[++i];
    else if (arg === "--source") opts.sources.push(argv[++i]);
    else if (arg === "-h" || arg === "--help") { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(opts.staleMs) || opts.staleMs < 0) throw new Error("--stale-min must be a non-negative number");
  return opts;
}

function sourceDefs(stateRoot) {
  return [
    { name: "pi-intercom", file: join(stateRoot, "pi-intercom", "handlers.json"), arrayKey: "runs" },
    { name: "pi-subagents", file: join(stateRoot, "pi-subagents", "handlers.json"), arrayKey: "handlers" },
    { name: "pi-return-on", file: join(stateRoot, "pi-return-on", "handlers.json"), arrayKey: "handlers" },
  ];
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function readText(file) {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

function fileSize(file) {
  try { return statSync(file).size; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return undefined;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM" ? true : false; }
}

function ageMs(at, now = Date.now()) {
  return typeof at === "number" ? Math.max(0, now - at) : undefined;
}

function formatMs(ms) {
  if (ms === undefined) return undefined;
  if (ms >= 86400000) return `${(ms / 86400000).toFixed(1)}d`;
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)}h`;
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function inRange(handler, sinceMs) {
  if (sinceMs === undefined) return true;
  return (handler.startedAt ?? 0) >= sinceMs || (handler.endedAt ?? 0) >= sinceMs;
}

function truncate(value, max = 500) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function sampleFor(source, handler, extra = {}) {
  return {
    source,
    id: handler.id,
    jobId: handler.jobId,
    messageId: handler.messageId,
    label: handler.label,
    from: handler.from,
    status: handler.status,
    pid: handler.pid,
    pidAlive: pidAlive(handler.pid),
    exitCode: handler.exitCode,
    signal: handler.signal,
    age: formatMs(ageMs(handler.startedAt)),
    error: truncate(handler.error),
    stdoutPath: handler.stdoutPath,
    stderrPath: handler.stderrPath,
    sessionDir: handler.sessionDir,
    ...extra,
  };
}

function addIssue(issues, key, severity, title, sample) {
  const issue = issues.get(key) ?? { key, severity, title, count: 0, samples: [] };
  issue.count += 1;
  if (issue.samples.length < 5) issue.samples.push(sample);
  issues.set(key, issue);
}

function stripHereDocBodies(text) {
  const lines = String(text ?? "").split(/\n/);
  const kept = [];
  let terminator;
  for (const line of lines) {
    if (terminator) {
      if (line.trim() === terminator) terminator = undefined;
      continue;
    }
    kept.push(line);
    const match = line.match(/<<[-]?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (match) terminator = match[1];
  }
  return kept.join("\n");
}

function classifyDirectWait(command) {
  const text = stripHereDocBodies(command);
  const sleep = text.match(/(?:^|[;&|\s])sleep\s+(\d+(?:\.\d+)?)([smhd]?)/);
  if (sleep) {
    const value = Number(sleep[1]);
    const unit = sleep[2] || "s";
    const ms = value * (unit === "d" ? 86400000 : unit === "h" ? 3600000 : unit === "m" ? 60000 : 1000);
    if (ms >= 10000) return "long sleep";
  }
  if (/(^|\n|[;&|]\s*)tail\s+-f\b/.test(text)) return "tail -f";
  if (/(^|\n|[;&|]\s*)watch\s+/.test(text)) return "watch command";
  if (/\bgh\s+(run\s+watch|pr\s+checks\b[^\n]*--watch)/.test(text)) return "gh watch";
  if (/\btea\s+.*\s--watch\b/.test(text)) return "tea watch";
  return undefined;
}

function scanSessionDirectWaits(sessionDir, handler, source, issues) {
  if (!sessionDir || !existsSync(sessionDir)) return;
  let files = [];
  try { files = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")).slice(-5); }
  catch { return; }
  for (const name of files) {
    const file = join(sessionDir, name);
    const lines = readText(file).split(/\n/);
    for (const line of lines) {
      if (!line.includes('"toolCall"') || !line.includes('"bash"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (item?.type !== "toolCall" || item?.name !== "bash") continue;
        const command = item?.arguments?.command;
        const reason = classifyDirectWait(command);
        if (reason) {
          addIssue(issues, `${source}:handler_session_direct_wait`, "medium", "Handler session ran a direct-wait shell command", sampleFor(source, handler, { sessionFile: file, reason, command: truncate(command, 700) }));
        }
      }
    }
  }
}

function scanHandler(source, handler, opts, issues) {
  const status = handler.status ?? "<missing>";
  const stderrSize = handler.stderrPath ? fileSize(handler.stderrPath) : null;
  const stderr = stderrSize && stderrSize > 0 ? readText(handler.stderrPath).trim() : "";
  const inFlight = status === "running" || status === "starting";
  const alive = pidAlive(handler.pid);
  const age = ageMs(handler.startedAt);

  if (status === "failed" || (typeof handler.exitCode === "number" && handler.exitCode !== 0)) {
    addIssue(issues, `${source}:handler_failed`, "high", "Fork handler failed", sampleFor(source, handler, { stderr: truncate(stderr) }));
  }
  if (inFlight && alive === false) {
    addIssue(issues, `${source}:handler_dead_pid`, "high", "Fork handler is in-flight but pid is dead", sampleFor(source, handler));
  }
  if (inFlight && age !== undefined && age >= opts.staleMs) {
    addIssue(issues, `${source}:handler_stale`, "medium", "Fork handler has been in-flight beyond stale threshold", sampleFor(source, handler));
  }
  if (stderr) {
    addIssue(issues, `${source}:stderr_nonempty`, status === "complete" ? "medium" : "high", "Fork handler stderr is non-empty", sampleFor(source, handler, { stderr: truncate(stderr) }));
  }
  const stdoutSize = handler.stdoutPath ? fileSize(handler.stdoutPath) : null;
  const hasCapturedOutput = (stdoutSize ?? 0) > 0 || (stderrSize ?? 0) > 0;
  const summary = String(handler.summary ?? "").trim();
  if (status === "complete" && handler.notify !== "none" && !summary && !hasCapturedOutput) {
    addIssue(issues, `${source}:complete_no_summary`, "medium", "Fork handler completed without a summary or captured output", sampleFor(source, handler));
  }
  const errorText = `${handler.error ?? ""}\n${stderr}`;
  if (/spawn\s+pi\s+ENOENT/.test(errorText)) {
    addIssue(issues, `${source}:spawn_pi_enoent`, "high", "Fork handler could not spawn pi", sampleFor(source, handler, { stderr: truncate(stderr) }));
  }
  if (/Cannot fork: source session file is empty or invalid/.test(errorText)) {
    addIssue(issues, `${source}:invalid_parent_fork_session`, "high", "Fork handler could not fork an empty/invalid parent session", sampleFor(source, handler, { stderr: truncate(stderr) }));
  }
  if (opts.includeSessions) scanSessionDirectWaits(handler.sessionDir, handler, source, issues);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const selected = new Set(opts.sources);
  const issues = new Map();
  const sources = [];
  for (const source of sourceDefs(opts.stateRoot)) {
    if (selected.size && !selected.has(source.name)) continue;
    const state = readJson(source.file, {});
    const allHandlers = Array.isArray(state[source.arrayKey]) ? state[source.arrayKey] : [];
    const handlers = allHandlers.filter((handler) => inRange(handler, opts.sinceMs));
    for (const handler of handlers) scanHandler(source.name, handler, opts, issues);
    const byStatus = {};
    for (const handler of handlers) byStatus[handler.status ?? "<missing>"] = (byStatus[handler.status ?? "<missing>"] ?? 0) + 1;
    sources.push({ name: source.name, file: source.file, totalAll: allHandlers.length, scanned: handlers.length, byStatus });
  }
  const findings = [...issues.values()].sort((a, b) => {
    const sev = { high: 0, medium: 1, low: 2 };
    return (sev[a.severity] ?? 9) - (sev[b.severity] ?? 9) || b.count - a.count || a.key.localeCompare(b.key);
  });
  const report = { scannedAt: new Date().toISOString(), since: opts.sinceMs ? new Date(opts.sinceMs).toISOString() : null, staleThresholdMs: opts.staleMs, stateRoot: opts.stateRoot, includeSessions: opts.includeSessions, sources, findings, issueCount: findings.reduce((sum, f) => sum + f.count, 0) };
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`fork-handler scan (${report.scannedAt})`);
  for (const source of sources) console.log(`${source.name}: scanned ${source.scanned}/${source.totalAll} ${JSON.stringify(source.byStatus)}`);
  console.log(`Issues: ${report.issueCount}`);
  for (const finding of findings) {
    console.log(`\n[${finding.severity}] ${finding.key} x${finding.count}\n  ${finding.title}`);
    for (const sample of finding.samples) console.log(`  - ${sample.id}${sample.error ? ` error=${sample.error}` : ""}${sample.stderrPath ? ` stderr=${sample.stderrPath}` : ""}`);
  }
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
