#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function entry(id, parentId, message, timestamp = "2026-05-18T00:00:00.000Z") {
  return { id, parentId, timestamp, message };
}

function runScan(root, extra = []) {
  const out = execFileSync(process.execPath, ["scripts/scan-return-on-errors.mjs", "--json", ...extra, root], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return JSON.parse(out);
}

test("scan-return-on-errors suppresses errors fixed by current condition compatibility", () => {
  const root = mkdtempSync(join(tmpdir(), "return-on-error-scan-"));
  mkdirSync(join(root, "sessions"));
  const file = join(root, "sessions", "session.jsonl");
  const parent = entry("a1", undefined, {
    role: "assistant",
    content: [
      { type: "toolCall", name: "return_on", arguments: { condition: { file: { path: "done", exists: true } }, resume: "done" } },
    ],
  });
  const result = entry("r1", "a1", {
    role: "toolResult",
    toolName: "return_on",
    isError: true,
    content: [{ type: "text", text: "condition leaf uses wrapper shape '{file:{...}}'; use flat '{type:\"file\", ...}' instead" }],
  });
  writeFileSync(file, `${JSON.stringify(parent)}\n${JSON.stringify(result)}\n`);

  const scan = runScan(root);
  assert.equal(scan.totalAll, 1);
  assert.equal(scan.resolvedTotal, 1);
  assert.equal(scan.total, 0);
  assert.equal(scan.resolvedErrors[0].reason, "supported_by_current_condition_compat");

  const all = runScan(root, ["--include-resolved"]);
  assert.equal(all.total, 1);
  assert.equal(all.errors[0].resolved, true);
});

test("scan-return-on-errors marks old 10m timeout cap errors as fixed by current 2h default", () => {
  const root = mkdtempSync(join(tmpdir(), "return-on-error-scan-"));
  const file = join(root, "session.jsonl");
  const parent = entry("a2", undefined, {
    role: "assistant",
    content: [
      { type: "toolCall", name: "return_on", arguments: { condition: { type: "timer", after: "1s" }, timeout: "30m", resume: "later" } },
    ],
  });
  const result = entry("r2", "a2", {
    role: "toolResult",
    toolName: "return_on",
    isError: true,
    content: [{ type: "text", text: "return_on timeout 30m exceeds max 10m. Configure returnOn.maxTimeout in pi settings if a longer watcher is required." }],
  });
  writeFileSync(file, `${JSON.stringify(parent)}\n${JSON.stringify(result)}\n`);

  const scan = runScan(root);
  assert.equal(scan.totalAll, 1);
  assert.equal(scan.resolvedTotal, 1);
  assert.equal(scan.total, 0);
  assert.equal(scan.resolvedErrors[0].reason, "covered_by_current_default_max_timeout");
});

test("scan-return-on-errors suppresses exec cmd alias errors fixed by current compatibility", () => {
  const root = mkdtempSync(join(tmpdir(), "return-on-error-scan-"));
  const file = join(root, "session.jsonl");
  const parent = entry("a3", undefined, {
    role: "assistant",
    content: [
      { type: "toolCall", name: "return_on", arguments: { condition: { type: "exec", cmd: "gh run view 123" }, allowExec: true, resume: "later" } },
    ],
  });
  const result = entry("r3", "a3", {
    role: "toolResult",
    toolName: "return_on",
    isError: true,
    content: [{ type: "text", text: "exec condition requires command or code" }],
  });
  writeFileSync(file, `${JSON.stringify(parent)}\n${JSON.stringify(result)}\n`);

  const scan = runScan(root);
  assert.equal(scan.totalAll, 1);
  assert.equal(scan.resolvedTotal, 1);
  assert.equal(scan.total, 0);
  assert.equal(scan.resolvedErrors[0].reason, "supported_by_current_exec_cmd_alias");
});
