#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/collect-direct-wait-examples.mjs");

async function writeJsonl(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function sessionEntry() {
  return { type: "session", version: 3, id: "session-test", timestamp: "2026-05-12T00:00:00.000Z", cwd: "/tmp/project" };
}

function assistantTool(id, name, args, timestamp = "2026-05-12T00:00:01.000Z") {
  return {
    type: "message",
    id: `${id}-entry`,
    parentId: "parent",
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: args }],
      timestamp: Date.parse(timestamp),
    },
  };
}

function toolResult(toolCallId, toolName, timestamp = "2026-05-12T00:00:02.000Z") {
  return {
    type: "message",
    id: `${toolCallId}-result`,
    parentId: `${toolCallId}-entry`,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      isError: false,
      content: [{ type: "text", text: "ok" }],
      timestamp: Date.parse(timestamp),
    },
  };
}

test("collector extracts actual bash waits and nearby return_on calls, not prose", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-return-on-collector-"));
  const sessionFile = path.join(dir, "session.jsonl");
  const output = path.join(dir, "examples.jsonl");
  await writeJsonl(sessionFile, [
    sessionEntry(),
    { type: "message", id: "user", timestamp: "2026-05-12T00:00:00.500Z", message: { role: "user", content: [{ type: "text", text: "Please do not count this prose: sleep 99" }] } },
    assistantTool("bash-1", "bash", { command: "mkdir -p .return-on && npm test > .return-on/test.log 2>&1 & echo $! > .return-on/test.pid", timeout: 30 }),
    toolResult("bash-1", "bash"),
    assistantTool("return-1", "return_on", { label: "tests done", condition: { type: "process", pid: 123, state: "exited" }, resume: "Summarize tests", endTurn: false }, "2026-05-12T00:00:03.000Z"),
    { type: "custom", customType: "return-on-registered", id: "registered", timestamp: "2026-05-12T00:00:03.100Z", data: { id: "ro_test", label: "tests done", createdAt: Date.parse("2026-05-12T00:00:03.100Z"), condition: { type: "process", pid: 123, state: "exited" } } },
  ]);

  const { stdout } = await execFileAsync(process.execPath, [script, "--output", output, sessionFile], { cwd: path.resolve(".") });
  assert.match(stdout, /Collected 1 direct-wait example/);
  const examples = (await fs.readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(examples.length, 1);
  assert.equal(examples[0].classification, "backgrounded_with_return_on");
  assert.equal(examples[0].nearbyReturnOn.toolCalls.length, 1);
  assert.equal(examples[0].nearbyReturnOn.registrations.length, 1);
  assert.match(examples[0].bash.command, /\.return-on\/test\.pid/);
});

test("collector records multiple wait matches from one bash command", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-return-on-collector-"));
  const sessionFile = path.join(dir, "session.jsonl");
  const output = path.join(dir, "examples.jsonl");
  await writeJsonl(sessionFile, [
    sessionEntry(),
    assistantTool("bash-2", "bash", { command: "sleep 12; watch date" }),
    toolResult("bash-2", "bash"),
  ]);

  await execFileAsync(process.execPath, [script, "--output", output, sessionFile], { cwd: path.resolve(".") });
  const [example] = (await fs.readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(example.classification, "missed_candidate");
  assert.equal(example.detection.matches.length, 2);
  assert.deepEqual(example.detection.matches.map((match) => match.kind), ["long sleep", "repeated polling"]);
});

test("collector records long bash runtimes from session timestamps", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-return-on-collector-"));
  const sessionFile = path.join(dir, "session.jsonl");
  const output = path.join(dir, "examples.jsonl");
  await writeJsonl(sessionFile, [
    sessionEntry(),
    assistantTool("bash-3", "bash", { command: "npm test", timeout: 1800 }, "2026-05-12T00:00:01.000Z"),
    toolResult("bash-3", "bash", "2026-05-12T00:22:52.600Z"),
  ]);

  await execFileAsync(process.execPath, [script, "--output", output, sessionFile], { cwd: path.resolve(".") });
  const [example] = (await fs.readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(example.classification, "missed_candidate");
  assert.equal(example.detection.primaryKind, "long tool runtime");
  assert.equal(example.detection.matches[0].durationMs, 1_371_600);
  assert.match(example.detection.matches[0].detail, /bash took 1371\.6s/);
});
