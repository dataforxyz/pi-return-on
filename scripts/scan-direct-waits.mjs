#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const home = os.homedir();
const defaultAuditFile = path.join(home, ".local", "state", "pi-return-on", "direct-wait-audit.jsonl");
const defaultRoots = [
  defaultAuditFile,
  path.join(home, ".pi", "agent", "sessions"),
];
const maxFileBytes = 5 * 1024 * 1024;
const sleepThresholdMs = 10_000;
const longRuntimeThresholdMs = 60_000;

const args = process.argv.slice(2);
const json = args.includes("--json");
const auditOnly = args.includes("--audit-only");
const help = args.includes("--help") || args.includes("-h");
const explicitPaths = args.filter((arg) => !arg.startsWith("--"));

if (help) {
  console.log(`Usage: node scripts/scan-direct-waits.mjs [--json] [--audit-only] [paths...]

Summarizes pi-return-on direct-wait audit entries and scans Pi session logs for
possible missed wait opportunities. With no paths, it scans:
- ${defaultAuditFile}
- ${path.join(home, ".pi", "agent", "sessions")}

Examples:
  npm run audit:direct-waits
  node scripts/scan-direct-waits.mjs --json ~/.pi/agent/sessions
  node scripts/scan-direct-waits.mjs --audit-only`);
  process.exit(0);
}

function parseDurationMs(value, unit = "s") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const normalized = unit.toLowerCase();
  const multiplier = normalized === "" || normalized === "s"
    ? 1000
    : normalized === "m"
      ? 60_000
      : normalized === "h"
        ? 3_600_000
        : normalized === "d"
          ? 86_400_000
          : normalized === "ms"
            ? 1
            : undefined;
  return multiplier === undefined ? undefined : Math.round(numeric * multiplier);
}

function isBackgrounded(text) {
  return /(^|\s)(nohup|setsid)\s+/.test(text)
    || /(^|[;\s])disown(\s|;|$)/.test(text)
    || /(^|[^&])&(\s*(echo\s+\$!|disown|$|[;]))/.test(text);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function textContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.content === "string") return item.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function collectToolCalls(entry) {
  const message = entry.message ?? {};
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls = [];
  for (const item of message.content) {
    if (item?.type !== "toolCall") continue;
    calls.push({
      entryId: entry.id,
      parentId: entry.parentId,
      timestamp: Date.parse(entry.timestamp ?? "") || message.timestamp || undefined,
      toolCallId: item.id,
      toolName: item.name,
      arguments: item.arguments ?? {},
    });
  }
  return calls;
}

function previewArguments(toolName, args) {
  const raw = toolName === "bash" && typeof args?.command === "string" ? args.command : JSON.stringify(args ?? {});
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function classifyLine(line) {
  const text = line.replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;

  const sleep = text.match(/(?:^|[;&|]\s*)(?:rtk\s+run\s+)?sleep\s+(\d+(?:\.\d+)?)(ms|s|m|h|d)?\b/);
  if (sleep) {
    const durationMs = parseDurationMs(sleep[1], sleep[2] ?? "s");
    if (durationMs !== undefined) {
      return {
        action: durationMs >= sleepThresholdMs && !isBackgrounded(text) ? "missed_block_candidate" : "allowed_or_backgrounded",
        kind: durationMs >= sleepThresholdMs ? "long sleep" : "short sleep",
        detail: `sleep ${sleep[1]}${sleep[2] ?? "s"}`,
        durationMs,
      };
    }
  }

  const checks = [
    [/Blocked direct wait/, "observed_block", "blocked reason"],
    [/(?:^|[;&|]\s*)tail\b[^;&|]*(?:\s-f\b|\s--follow(?:=\S+)?\b)/, "streaming log wait", "tail -f/--follow"],
    [/(?:^|[;&|]\s*)journalctl\b[^;&|]*(?:\s-f\b|\s--follow\b)/, "streaming log wait", "journalctl -f/--follow"],
    [/(?:^|[;&|]\s*)kubectl\s+logs\b[^;&|]*(?:\s-f\b|\s--follow\b)/, "streaming log wait", "kubectl logs -f/--follow"],
    [/(?:^|[;&|]\s*)watch\s+/, "repeated polling", "watch"],
    [/\bwhile\s+(?:true|:)\s*;\s*do\b/, "infinite loop", "while true/while :"],
    [/\bfor\s*\(\(\s*;\s*;\s*\)\)\s*;\s*do\b/, "infinite loop", "for ((;;))"],
    [/(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev\b/, "foreground dev server", "package manager dev server"],
    [/(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+start\b/, "foreground server", "package manager start server"],
    [/(?:^|[;&|]\s*)(?:next|vite|astro|webpack-dev-server)\s+(?:dev|serve)?\b/, "foreground dev server", "dev server command"],
    [/(?:^|[;&|]\s*)python(?:3)?\s+-m\s+http\.server\b/, "foreground server", "python -m http.server"],
  ];
  for (const [regex, kind, detail] of checks) {
    if (!regex.test(text)) continue;
    if (kind === "observed_block") return { action: "observed_block", kind, detail };
    return { action: isBackgrounded(text) ? "allowed_or_backgrounded" : "missed_block_candidate", kind, detail };
  }
  return undefined;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function* walk(target) {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (stat.size <= maxFileBytes) yield target;
    return;
  }
  if (!stat.isDirectory()) return;
  const basename = path.basename(target);
  if ([".git", "node_modules", "dist", "build"].includes(basename)) return;
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    yield* walk(path.join(target, entry.name));
  }
}

async function scanSessionLongRuntimes(file, raw) {
  const toolCalls = new Map();
  const hits = [];
  const lines = raw.split("\n");
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    for (const call of collectToolCalls(entry)) {
      if (call.toolCallId) toolCalls.set(call.toolCallId, call);
    }
    const message = entry.message ?? {};
    if (message.role !== "toolResult" || !message.toolCallId) return;
    const call = toolCalls.get(message.toolCallId);
    if (!call?.timestamp) return;
    const resultTimestamp = Date.parse(entry.timestamp ?? "") || message.timestamp || undefined;
    if (!resultTimestamp) return;
    const durationMs = resultTimestamp - call.timestamp;
    if (!Number.isFinite(durationMs) || durationMs < longRuntimeThresholdMs) return;
    const toolName = String(message.toolName ?? call.toolName ?? "unknown");
    const text = previewArguments(toolName, call.arguments) || textContent(message.content).replace(/\s+/g, " ").trim().slice(0, 240);
    hits.push({
      file,
      line: index + 1,
      text,
      action: "long_runtime_candidate",
      kind: "long tool runtime",
      detail: `${toolName} took ${formatDuration(durationMs)}`,
      durationMs,
      toolName,
      entryId: entry.id,
      toolCallId: message.toolCallId,
      callEntryId: call.entryId,
    });
  });
  return hits;
}

async function readAudit(file) {
  const entries = [];
  if (!(await exists(file))) return entries;
  const raw = await fs.readFile(file, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.event === "direct_wait") entries.push(parsed);
    } catch {
      // Ignore corrupt/partial lines.
    }
  }
  return entries;
}

function addCount(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

const roots = explicitPaths.length > 0 ? explicitPaths.map((p) => path.resolve(p)) : defaultRoots;
const auditFiles = new Set([path.resolve(defaultAuditFile)]);
for (const root of roots) {
  try {
    const stat = await fs.stat(root);
    if (!stat.isFile() || stat.size > maxFileBytes) continue;
    const entries = await readAudit(root);
    if (entries.length > 0) auditFiles.add(path.resolve(root));
  } catch {
    // Ignore missing/inaccessible explicit paths.
  }
}
const auditEntries = [];
for (const file of auditFiles) {
  auditEntries.push(...await readAudit(file));
}
const scanHits = [];

if (!auditOnly) {
  for (const root of roots) {
    if (!(await exists(root))) continue;
    for await (const file of walk(root)) {
      if (auditFiles.has(path.resolve(file))) continue;
      let raw;
      try {
        raw = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      if (file.endsWith(".jsonl")) scanHits.push(...await scanSessionLongRuntimes(file, raw));
      const lines = raw.split("\n");
      lines.forEach((line, index) => {
        const hit = classifyLine(line);
        if (!hit) return;
        scanHits.push({ file, line: index + 1, text: line.trim().slice(0, 240), ...hit });
      });
    }
  }
}

const auditByAction = new Map();
const auditByKind = new Map();
for (const entry of auditEntries) {
  addCount(auditByAction, entry.action ?? "unknown");
  addCount(auditByKind, entry.kind ?? "unknown");
}
const scanByAction = new Map();
const scanByKind = new Map();
for (const hit of scanHits) {
  addCount(scanByAction, hit.action);
  addCount(scanByKind, hit.kind);
}

function countsObject(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
}

const result = {
  auditFile: defaultAuditFile,
  auditFiles: [...auditFiles],
  auditEntries: auditEntries.length,
  auditByAction: countsObject(auditByAction),
  auditByKind: countsObject(auditByKind),
  scannedRoots: auditOnly ? [] : roots,
  scanHits: scanHits.length,
  scanByAction: countsObject(scanByAction),
  scanByKind: countsObject(scanByKind),
  recentAudit: auditEntries.slice(-20),
  sampleHits: scanHits.slice(0, 50),
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Direct-wait audit: ${result.auditEntries} entries at ${result.auditFile}`);
  console.log(`  by action: ${JSON.stringify(result.auditByAction)}`);
  console.log(`  by kind:   ${JSON.stringify(result.auditByKind)}`);
  if (!auditOnly) {
    console.log(`Scanned ${roots.length} root(s), found ${result.scanHits} possible direct-wait lines`);
    console.log(`  by action: ${JSON.stringify(result.scanByAction)}`);
    console.log(`  by kind:   ${JSON.stringify(result.scanByKind)}`);
    for (const hit of result.sampleHits.slice(0, 15)) {
      console.log(`- ${hit.action} ${hit.kind} ${hit.file}:${hit.line} ${hit.text}`);
    }
  }
}
