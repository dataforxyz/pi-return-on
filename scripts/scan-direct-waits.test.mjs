#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const scanner = path.join(repoRoot, "scripts", "scan-direct-waits.mjs");

async function runScanner(args, env = {}) {
  const { stdout } = await execFileAsync(process.execPath, [scanner, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
  return stdout;
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-return-on-scan-direct-waits-"));
try {
  const home = path.join(tmp, "home");
  await fs.mkdir(home, { recursive: true });
  const auditPath = path.join(tmp, "custom-audit.jsonl");
  await fs.writeFile(auditPath, [
    JSON.stringify({ event: "direct_wait", action: "blocked", kind: "long sleep", command: "sleep 10" }),
    JSON.stringify({ event: "direct_wait", action: "allowed_short_sleep", kind: "short sleep", command: "sleep 1" }),
    "not json",
    "",
  ].join("\n"), "utf8");

  const auditOnly = JSON.parse(await runScanner(["--json", "--audit-only", auditPath], { HOME: home }));
  assert.equal(auditOnly.auditEntries, 2);
  assert.equal(auditOnly.auditByAction.blocked, 1);
  assert.equal(auditOnly.auditByAction.allowed_short_sleep, 1);
  assert.equal(auditOnly.auditByKind["long sleep"], 1);
  assert.ok(auditOnly.auditFiles.includes(path.resolve(auditPath)));
  assert.equal(auditOnly.scanHits, 0);

  const scan = JSON.parse(await runScanner(["--json", auditPath], { HOME: home }));
  assert.equal(scan.auditEntries, 2);
  assert.equal(scan.scanHits, 0, "explicit audit JSONL should not be double-counted as text scan hits");

  const sessionPath = path.join(tmp, "session.jsonl");
  await fs.writeFile(sessionPath, [
    JSON.stringify({ type: "session", id: "session-test", timestamp: "2026-05-12T00:00:00.000Z", cwd: "/tmp/project" }),
    JSON.stringify({
      type: "message",
      id: "assistant-call",
      timestamp: "2026-05-12T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "bash-long", name: "bash", arguments: { command: "npm test", timeout: 1800 } }] },
    }),
    JSON.stringify({
      type: "message",
      id: "bash-long-result",
      parentId: "assistant-call",
      timestamp: "2026-05-12T00:22:52.600Z",
      message: { role: "toolResult", toolCallId: "bash-long", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] },
    }),
  ].join("\n") + "\n", "utf8");
  const runtimeScan = JSON.parse(await runScanner(["--json", sessionPath], { HOME: home }));
  assert.equal(runtimeScan.scanByAction.long_runtime_candidate, 1);
  assert.equal(runtimeScan.scanByKind["long tool runtime"], 1);
  assert.match(runtimeScan.sampleHits[0].detail, /bash took 1371\.6s/);
  assert.equal(runtimeScan.sampleHits[0].toolCallId, "bash-long");
  assert.equal(runtimeScan.longRuntimeGroups[0].signature, "npm test");
  assert.equal(runtimeScan.longRuntimeGroups[0].count, 1);
  assert.match(runtimeScan.longRuntimeGroups[0].recommendation, /background/);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
