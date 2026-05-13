#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

const scannerVersion = 1;
const home = os.homedir();
const stateDir = path.join(home, ".local", "state", "pi-return-on");
const defaultSessionsRoot = path.join(home, ".pi", "agent", "sessions");
const defaultOutput = path.join(stateDir, "direct-wait-examples.jsonl");
const maxFileBytes = 20 * 1024 * 1024;
const sleepThresholdMs = 10_000;
const returnOnLookaheadEntries = 80;
const returnOnLookaheadMs = 30 * 60 * 1000;

const args = process.argv.slice(2);
const paths = [];
let output = defaultOutput;
let stdout = false;
let dryRun = false;
let jsonSummary = false;
let includeAllBash = false;
let help = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") help = true;
  else if (arg === "--stdout") stdout = true;
  else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--json") jsonSummary = true;
  else if (arg === "--include-all-bash") includeAllBash = true;
  else if (arg === "--output") output = path.resolve(args[++i] ?? "");
  else if (arg.startsWith("--output=")) output = path.resolve(arg.slice("--output=".length));
  else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
  else paths.push(path.resolve(arg));
}

if (help) {
  console.log(`Usage: node scripts/collect-direct-wait-examples.mjs [options] [session-jsonl-or-dir...]

Read Pi session JSONL structurally and extract actual bash tool calls that look
like direct waits, plus nearby return_on registrations. This does not mutate
session logs and does not attempt auto-conversion.

Options:
  --output <file>       Corpus output path (default: ${defaultOutput})
  --stdout             Write JSONL examples to stdout instead of a file
  --dry-run            Print summary only; do not write corpus
  --json               Print machine-readable summary
  --include-all-bash   Include non-wait bash tool calls as no_match examples
  -h, --help           Show this help

Default input root:
  ${defaultSessionsRoot}
`);
  process.exit(0);
}

function parseDurationMs(value, unit = "s") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const normalized = String(unit || "s").toLowerCase();
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

function normalizeCommand(command) {
  return command.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function previewCommand(command, max = 300) {
  const normalized = normalizeCommand(redactCommand(command)).replace(/\n/g, "\\n");
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function redactCommand(command) {
  return command
    .replace(/(api[_-]?key|token|password|passwd|secret)(\s*=\s*|\s+)([^\s'"`]+)/gi, "$1$2[REDACTED]")
    .replace(/(Authorization:\s*Bearer\s+)([^\s'"`]+)/gi, "$1[REDACTED]")
    .replace(/(--(?:api-key|token|password|secret)(?:=|\s+))([^\s'"`]+)/gi, "$1[REDACTED]");
}

function commandHash(command) {
  return createHash("sha256").update(normalizeCommand(redactCommand(command))).digest("hex");
}

function stableHash(value, length = 20) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function isBackgrounded(text) {
  return /(^|\s)(nohup|setsid)\s+/.test(text)
    || /(^|[;\s])disown(\s|;|$)/.test(text)
    || /(^|[^&])&(\s*(echo\s+\$!|disown|$|[;]))/.test(text);
}

function addMatch(matches, match) {
  matches.push({
    ...match,
    backgrounded: match.backgrounded ?? false,
    severity: match.severity ?? "candidate",
  });
}

function detectWaitMatches(command) {
  const text = normalizeCommand(command).replace(/\n/g, " ; ");
  const matches = [];
  const backgrounded = isBackgrounded(text);

  for (const match of text.matchAll(/(?:^|[;&|]\s*)(?:rtk\s+run\s+)?sleep\s+(\d+(?:\.\d+)?)(ms|s|m|h|d)?\b/g)) {
    const durationMs = parseDurationMs(match[1], match[2] ?? "s");
    if (durationMs === undefined) continue;
    addMatch(matches, {
      kind: durationMs >= sleepThresholdMs ? "long sleep" : "short sleep",
      detail: `sleep ${match[1]}${match[2] ?? "s"}`,
      durationMs,
      backgrounded,
      severity: durationMs >= sleepThresholdMs && !backgrounded ? "direct_wait" : "allowed_or_backgrounded",
    });
  }

  const checks = [
    [/(?:^|[;&|]\s*)tail\b[^;&|]*(?:\s-f\b|\s--follow(?:=\S+)?\b)/g, "streaming log wait", "tail -f/--follow"],
    [/(?:^|[;&|]\s*)journalctl\b[^;&|]*(?:\s-f\b|\s--follow\b)/g, "streaming log wait", "journalctl -f/--follow"],
    [/(?:^|[;&|]\s*)kubectl\s+logs\b[^;&|]*(?:\s-f\b|\s--follow\b)/g, "streaming log wait", "kubectl logs -f/--follow"],
    [/(?:^|[;&|]\s*)watch\s+[^;&|]+/g, "repeated polling", "watch"],
    [/\bwhile\s+(?:true|:)\s*;\s*do\b/g, "infinite loop", "while true/while :"],
    [/\bfor\s*\(\(\s*;\s*;\s*\)\)\s*;\s*do\b/g, "infinite loop", "for ((;;))"],
    [/(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev\b/g, "foreground dev server", "package manager dev server"],
    [/(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+start\b/g, "foreground server", "package manager start server"],
    [/(?:^|[;&|]\s*)(?:next|vite|astro|webpack-dev-server)\s+(?:dev|serve)?\b/g, "foreground dev server", "dev server command"],
    [/(?:^|[;&|]\s*)python(?:3)?\s+-m\s+http\.server\b/g, "foreground server", "python -m http.server"],
  ];
  for (const [regex, kind, detail] of checks) {
    for (const _ of text.matchAll(regex)) {
      addMatch(matches, {
        kind,
        detail,
        backgrounded,
        severity: backgrounded ? "allowed_or_backgrounded" : "direct_wait",
      });
    }
  }
  if (matches.length === 0 && backgrounded && /\.return-on\//.test(text) && /\$!|\.pid\b/.test(text)) {
    addMatch(matches, {
      kind: "background process",
      detail: "background command with pid/log artifact",
      backgrounded: true,
      severity: "allowed_or_backgrounded",
    });
  }
  return matches;
}

function extractArtifacts(command) {
  const artifacts = new Set();
  for (const match of command.matchAll(/(?:^|[\s"'])(\.return-on\/[A-Za-z0-9._/@-]+|[^\s"']+\.(?:pid|log|jsonl|json))(?:$|[\s"'])/g)) {
    artifacts.add(match[1]);
  }
  return [...artifacts].slice(0, 20);
}

function contentText(content) {
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

function toolNameMatches(name, expected) {
  return name === expected || name === `functions.${expected}`;
}

function collectToolCalls(entry, order) {
  const message = entry.message ?? {};
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls = [];
  for (const item of message.content) {
    if (item?.type !== "toolCall") continue;
    calls.push({
      order,
      timestamp: Date.parse(entry.timestamp ?? "") || message.timestamp || undefined,
      entryId: entry.id,
      parentId: entry.parentId,
      toolCallId: item.id,
      toolName: item.name,
      arguments: item.arguments ?? {},
    });
  }
  return calls;
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
    if (target.endsWith(".jsonl") && stat.size <= maxFileBytes) yield target;
    return;
  }
  if (!stat.isDirectory()) return;
  const basename = path.basename(target);
  if ([".git", "node_modules", "dist", "build"].includes(basename)) return;
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    yield* walk(path.join(target, entry.name));
  }
}

async function readJsonl(file) {
  const entries = [];
  const raw = await fs.readFile(file, "utf8");
  let lineNo = 0;
  for (const line of raw.split("\n")) {
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      entries.push({ ...JSON.parse(line), __line: lineNo });
    } catch {
      // Ignore partial/corrupt session lines.
    }
  }
  return entries;
}

function findNearbyReturnOn(call, returnOnCalls, registrations) {
  const callTime = call.timestamp ?? 0;
  const nearbyToolCalls = returnOnCalls.filter((candidate) => {
    if (candidate.order <= call.order) return false;
    if (candidate.order - call.order <= returnOnLookaheadEntries) return true;
    if (callTime && candidate.timestamp && candidate.timestamp - callTime <= returnOnLookaheadMs) return true;
    return false;
  }).slice(0, 5);
  const nearbyRegistrations = registrations.filter((candidate) => {
    if (candidate.order <= call.order) return false;
    if (candidate.order - call.order <= returnOnLookaheadEntries) return true;
    if (callTime && candidate.timestamp && candidate.timestamp - callTime <= returnOnLookaheadMs) return true;
    return false;
  }).slice(0, 5);
  return { toolCalls: nearbyToolCalls, registrations: nearbyRegistrations };
}

function classifyExample(matches, audit, nearbyReturnOn, artifacts) {
  if (audit?.action === "blocked") return "direct_wait_blocked";
  if (audit?.action === "allowed_short_sleep") return "short_sleep";
  if (matches.length === 0) return "no_match";
  if (matches.every((match) => match.kind === "short sleep")) return "short_sleep";
  const hasReturnOn = nearbyReturnOn.toolCalls.length > 0 || nearbyReturnOn.registrations.length > 0;
  const hasBackground = matches.some((match) => match.backgrounded) || artifacts.length > 0;
  if (hasBackground && hasReturnOn) return "backgrounded_with_return_on";
  if (hasBackground) return "backgrounded_no_return_on";
  if (hasReturnOn) return "direct_wait_then_return_on";
  return "missed_candidate";
}

function dedupeKey(sessionDate, cwd, command, matches) {
  const matchKey = matches.map((match) => `${match.kind}:${match.detail}`).sort().join("|");
  return stableHash(`${sessionDate}\n${cwd ?? ""}\n${normalizeCommand(redactCommand(command))}\n${matchKey}`, 24);
}

async function scanSession(file) {
  const entries = await readJsonl(file);
  const sessionEntry = entries.find((entry) => entry.type === "session") ?? {};
  const sessionId = sessionEntry.id;
  const cwd = sessionEntry.cwd;
  const sessionDate = String(sessionEntry.timestamp ?? entries[0]?.timestamp ?? "").slice(0, 10);
  const toolResults = new Map();
  const bashCalls = [];
  const returnOnCalls = [];
  const directWaitAudits = [];
  const registrations = [];

  entries.forEach((entry, order) => {
    for (const call of collectToolCalls(entry, order)) {
      if (toolNameMatches(call.toolName, "bash")) {
        bashCalls.push(call);
      } else if (toolNameMatches(call.toolName, "return_on")) {
        returnOnCalls.push(call);
      }
    }
    const message = entry.message ?? {};
    if (message.role === "toolResult" && message.toolCallId) {
      toolResults.set(message.toolCallId, {
        order,
        timestamp: Date.parse(entry.timestamp ?? "") || message.timestamp || undefined,
        entryId: entry.id,
        isError: message.isError === true,
        toolName: message.toolName,
        text: contentText(message.content).slice(0, 800),
      });
    }
    if (entry.type === "custom" && entry.customType === "return-on-direct-wait") {
      directWaitAudits.push({ order, timestamp: Date.parse(entry.timestamp ?? "") || entry.data?.timestamp, entryId: entry.id, data: entry.data });
    }
    if (entry.type === "custom" && entry.customType === "return-on-registered") {
      registrations.push({ order, timestamp: Date.parse(entry.timestamp ?? "") || entry.data?.createdAt, entryId: entry.id, id: entry.data?.id, label: entry.data?.label, condition: entry.data?.condition });
    }
  });

  const examples = [];
  for (const call of bashCalls) {
    const command = typeof call.arguments.command === "string" ? call.arguments.command : "";
    if (!command) continue;
    const matches = detectWaitMatches(command);
    if (!includeAllBash && matches.length === 0) continue;
    const hash = commandHash(command);
    const result = toolResults.get(call.toolCallId);
    const nearbyReturnOn = findNearbyReturnOn(call, returnOnCalls, registrations);
    const artifacts = extractArtifacts(command);
    const audit = directWaitAudits.find((candidate) => {
      const auditCommand = candidate.data?.command;
      if (typeof auditCommand === "string" && normalizeCommand(auditCommand) === normalizeCommand(redactCommand(command))) return true;
      const delta = Math.abs((candidate.timestamp ?? 0) - (call.timestamp ?? 0));
      return delta < 2000 && candidate.data?.toolName === "bash";
    });
    const classification = classifyExample(matches, audit?.data, nearbyReturnOn, artifacts);
    const firstKind = matches[0]?.kind ?? "none";
    const exampleId = `dwe_${stableHash(`${file}\n${call.toolCallId}\n${hash}`, 18)}`;
    examples.push({
      version: scannerVersion,
      exampleId,
      dedupeKey: dedupeKey(sessionDate, cwd, command, matches),
      classification,
      reviewStatus: "unreviewed",
      source: {
        sessionFile: file,
        sessionId,
        cwd,
        sessionDate,
        entryId: call.entryId,
        parentId: call.parentId,
        toolCallId: call.toolCallId,
        order: call.order,
        timestamp: call.timestamp,
      },
      bash: {
        command: redactCommand(command),
        commandPreview: previewCommand(command),
        commandHash: hash,
        timeout: call.arguments.timeout,
        artifacts,
        result: result ? { isError: result.isError, entryId: result.entryId, timestamp: result.timestamp, textPreview: result.text } : undefined,
      },
      detection: {
        primaryKind: firstKind,
        matches,
        audit: audit ? { entryId: audit.entryId, action: audit.data?.action, kind: audit.data?.kind, detail: audit.data?.detail } : undefined,
      },
      nearbyReturnOn: {
        toolCalls: nearbyReturnOn.toolCalls.map((candidate) => ({
          entryId: candidate.entryId,
          toolCallId: candidate.toolCallId,
          timestamp: candidate.timestamp,
          label: candidate.arguments?.label,
          condition: candidate.arguments?.condition,
          endTurn: candidate.arguments?.endTurn,
          delivery: candidate.arguments?.delivery,
        })),
        registrations: nearbyReturnOn.registrations,
      },
    });
  }
  return examples;
}

const inputRoots = paths.length > 0 ? paths : [defaultSessionsRoot];
const files = [];
for (const root of inputRoots) {
  if (!(await exists(root))) continue;
  for await (const file of walk(root)) files.push(file);
}
files.sort();

const examples = [];
for (const file of files) {
  try {
    examples.push(...await scanSession(file));
  } catch (error) {
    console.error(`Skipping ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const seen = new Set();
const deduped = [];
for (const example of examples) {
  if (seen.has(example.dedupeKey)) continue;
  seen.add(example.dedupeKey);
  deduped.push(example);
}

const byClassification = {};
const byKind = {};
for (const example of examples) {
  byClassification[example.classification] = (byClassification[example.classification] ?? 0) + 1;
  byKind[example.detection.primaryKind] = (byKind[example.detection.primaryKind] ?? 0) + 1;
}

const lines = examples.map((example) => JSON.stringify(example));
if (stdout) {
  process.stdout.write(`${lines.join("\n")}${lines.length ? "\n" : ""}`);
} else if (!dryRun) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
}

const summary = {
  scannerVersion,
  scannedFiles: files.length,
  rawExamples: examples.length,
  dedupedExamples: deduped.length,
  output: stdout || dryRun ? undefined : output,
  byClassification,
  byKind,
};

if (jsonSummary) {
  console.log(JSON.stringify(summary, null, 2));
} else if (!stdout) {
  console.log(`Scanned ${summary.scannedFiles} session file(s).`);
  console.log(`Collected ${summary.rawExamples} direct-wait example(s), ${summary.dedupedExamples} deduped.`);
  console.log(`By classification: ${JSON.stringify(summary.byClassification)}`);
  console.log(`By kind: ${JSON.stringify(summary.byKind)}`);
  if (summary.output) console.log(`Wrote ${summary.output}`);
}
