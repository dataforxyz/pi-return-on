import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as net from "node:net";

process.env.HOME = await fs.mkdtemp(path.join(os.tmpdir(), "pi-return-on-home-"));

const { default: extension } = await import("../src/index.ts");

type Tool = {
  execute: (toolCallId: string, params: any, signal: AbortSignal, onUpdate: (update: unknown) => void, ctx: any) => Promise<any>;
};

type WakeExpectation = {
  jobId: string;
  label: string;
  resume: string;
};

type Harness = ReturnType<typeof createHarness>;

const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-return-on-smoke-"));
const stateDir = path.join(process.env.HOME!, ".local", "state", "pi-return-on");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const allJobIds: string[] = [];

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve a local port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function createHarness(sessionName: string, options: { hasUI?: boolean; confirm?: boolean | (() => boolean | Promise<boolean>) } = {}) {
  const tools = new Map<string, Tool>();
  const events = new Map<string, Function[]>();
  const messages: any[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<{ key: string; value?: string }> = [];
  const commands = new Map<string, any>();
  const sessionFile = path.join(cwd, `${sessionName}.jsonl`);
  let confirmCalls = 0;

  const ctx: any = {
    cwd,
    hasUI: options.hasUI ?? true,
    sessionManager: { getSessionFile: () => sessionFile },
    ui: {
      confirm: async () => {
        confirmCalls += 1;
        if (typeof options.confirm === "function") return options.confirm();
        return options.confirm ?? true;
      },
      notify(message: string, level?: string) { notifications.push({ message, level }); },
      setStatus(key: string, value?: string) { statuses.push({ key, value }); },
    },
  };

  const pi: any = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
    registerMessageRenderer() {},
    appendEntry() {},
    on(event: string, handler: Function) {
      const handlers = events.get(event) ?? [];
      handlers.push(handler);
      events.set(event, handlers);
      return () => events.set(event, handlers.filter((candidate) => candidate !== handler));
    },
    sendMessage(message: unknown, options: unknown) {
      messages.push({ message, options, at: Date.now() });
    },
  };

  extension(pi);

  async function emit(event: string) {
    for (const handler of events.get(event) ?? []) await handler({}, ctx);
  }

  async function beforeAgentStart(systemPrompt = "base system prompt") {
    let current = systemPrompt;
    for (const handler of events.get("before_agent_start") ?? []) {
      const result = await handler({ prompt: "test", images: [], systemPrompt: current, systemPromptOptions: {} }, ctx);
      if (typeof result?.systemPrompt === "string") current = result.systemPrompt;
    }
    return current;
  }

  async function toolCall(toolName: string, input: any) {
    for (const handler of events.get("tool_call") ?? []) {
      const result = await handler({ toolName, toolCallId: "tool-call", input }, ctx);
      if (result?.block) return result;
    }
    return undefined;
  }

  function requireTool(name: string): Tool {
    const tool = tools.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool;
  }

  async function register(params: any) {
    const result = await requireTool("return_on").execute("call", params, new AbortController().signal, () => {}, ctx);
    if (!result?.terminate) throw new Error("return_on registration should terminate the current turn");
    const id = result.details.job.id as string;
    allJobIds.push(id);
    return id;
  }

  async function runCommand(name: string, args = "") {
    const command = commands.get(name);
    if (!command) throw new Error(`missing command ${name}`);
    await command.handler(args, ctx);
  }

  async function cancel(id: string) {
    await requireTool("return_on_cancel").execute("cancel", { id }, new AbortController().signal, () => {}, ctx);
  }

  return { beforeAgentStart, commands, ctx, emit, messages, notifications, register, cancel, runCommand, sessionFile, statuses, toolCall, tools, get confirmCalls() { return confirmCalls; } };
}

function wakeEntries(harness: Harness, jobId: string) {
  return harness.messages.filter((entry) => entry.message?.details?.id === jobId);
}

function assertWake(entry: any, expectation: WakeExpectation) {
  const content = String(entry.message?.content ?? "");
  if (entry.options?.triggerTurn !== true) throw new Error(`wake ${expectation.label} did not set triggerTurn=true`);
  if (entry.message?.customType !== "return-on") throw new Error(`wake ${expectation.label} had customType=${entry.message?.customType}`);
  if (entry.message?.details?.id !== expectation.jobId) throw new Error(`wake ${expectation.label} had wrong job id`);
  for (const required of [expectation.jobId, expectation.label, expectation.resume]) {
    if (!content.includes(required)) throw new Error(`wake ${expectation.label} missing content: ${required}`);
  }
}

async function waitForWake(harness: Harness, expectation: WakeExpectation, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entries = wakeEntries(harness, expectation.jobId);
    if (entries.length > 0) {
      if (entries.length !== 1) throw new Error(`expected exactly one wake for ${expectation.label}, saw ${entries.length}`);
      assertWake(entries[0], expectation);
      return entries[0];
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${expectation.label}. Messages: ${harness.messages.map((m) => m.message?.content).join("\n---\n")}`);
}

async function expectNoWake(harness: Harness, jobId: string, durationMs: number, reason: string) {
  await sleep(durationMs);
  const entries = wakeEntries(harness, jobId);
  if (entries.length !== 0) throw new Error(`unexpected early wake for ${jobId}: ${reason}`);
}

async function testDirectWaitPolicy(harness: Harness) {
  const systemPrompt = await harness.beforeAgentStart();
  if (!systemPrompt.includes("Direct wait policy for return_on") || !systemPrompt.includes("Do not block the conversation with direct waits")) {
    throw new Error(`direct wait guidance was not injected into the system prompt: ${systemPrompt}`);
  }

  const blockedSleep = await harness.toolCall("bash", { command: "sleep 10" });
  if (!blockedSleep?.block || !String(blockedSleep.reason).includes("return_on")) {
    throw new Error(`10 second sleep was not blocked with return_on guidance: ${JSON.stringify(blockedSleep)}`);
  }

  const longerSleep = await harness.toolCall("bash", { command: "sleep 30" });
  if (!longerSleep?.block || !String(longerSleep.reason).includes("return_on")) {
    throw new Error(`long sleep was not blocked with return_on guidance: ${JSON.stringify(longerSleep)}`);
  }

  const blockedTail = await harness.toolCall("bash", { command: "tail -f server.log" });
  if (!blockedTail?.block || !String(blockedTail.reason).includes("tail -f")) {
    throw new Error(`tail -f was not blocked: ${JSON.stringify(blockedTail)}`);
  }

  const blockedDevServer = await harness.toolCall("bash", { command: "npm run dev" });
  if (!blockedDevServer?.block || !String(blockedDevServer.reason).includes("background")) {
    throw new Error(`foreground dev server was not blocked: ${JSON.stringify(blockedDevServer)}`);
  }

  const shortSleep = await harness.toolCall("bash", { command: "sleep 9" });
  if (shortSleep?.block) throw new Error(`sleep under 10 seconds should not be blocked: ${JSON.stringify(shortSleep)}`);

  const backgrounded = await harness.toolCall("bash", { command: "mkdir -p .return-on && npm run dev > .return-on/dev.log 2>&1 & echo $! > .return-on/dev.pid" });
  if (backgrounded?.block) throw new Error(`backgrounded dev server should not be blocked: ${JSON.stringify(backgrounded)}`);

  const auditFile = path.join(stateDir, "direct-wait-audit.jsonl");
  const auditLines = (await fs.readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  if (!auditLines.some((entry) => entry.action === "blocked" && entry.detail === "sleep 10s")) {
    throw new Error(`blocked sleep was not audited: ${JSON.stringify(auditLines)}`);
  }
  if (!auditLines.some((entry) => entry.action === "allowed_short_sleep" && entry.detail === "sleep 9s")) {
    throw new Error(`allowed short sleep was not audited: ${JSON.stringify(auditLines)}`);
  }
  if (!auditLines.some((entry) => entry.action === "allowed_backgrounded" && entry.detail === "package manager dev server")) {
    throw new Error(`backgrounded direct-wait opportunity was not audited: ${JSON.stringify(auditLines)}`);
  }

  await harness.runCommand("return-on-direct-waits", "10");
  const notification = harness.notifications.at(-1)?.message ?? "";
  if (!notification.includes("Direct-wait audit") || !notification.includes("allowed_short_sleep") || !notification.includes("blocked")) {
    throw new Error(`direct wait audit command did not summarize entries: ${notification}`);
  }
}

async function testTimer(harness: Harness) {
  const label = "smoke timer";
  const resume = "timer resume";
  const jobId = await harness.register({ label, condition: { type: "timer", after: "1500ms" }, resume });
  await expectNoWake(harness, jobId, 900, "timer fired before target");
  await waitForWake(harness, { jobId, label, resume }, 2_500);
}

async function testForkDelivery(harness: Harness) {
  const fakePi = path.join(cwd, "fake-pi.mjs");
  await fs.writeFile(fakePi, `#!/usr/bin/env node\nconsole.log("fake return_on handler summary");\n`, { mode: 0o755 });
  const label = "smoke fork delivery";
  const resume = "fork delivery resume";
  const jobId = await harness.register({
    label,
    condition: { type: "timer", after: "100ms" },
    resume,
    delivery: { mode: "fork", piCommand: fakePi },
  });
  const start = Date.now();
  while (Date.now() - start < 2_500) {
    const handlerMessages = harness.messages.filter((entry) => entry.message?.customType === "return-on-handler" && entry.message?.details?.id === jobId);
    const ack = handlerMessages.find((entry) => entry.message?.details?.status === "running");
    const summary = handlerMessages.find((entry) => entry.message?.details?.status === "complete");
    if (ack && summary) {
      if (ack.options?.triggerTurn !== false) throw new Error("fork delivery ack should not trigger parent turn");
      if (summary.options?.triggerTurn !== false) throw new Error("fork delivery summary should not trigger parent turn by default");
      if (!String(summary.message?.content ?? "").includes("fake return_on handler summary")) throw new Error("fork delivery summary missed fake handler output");
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for fork delivery handler messages: ${harness.messages.map((m) => m.message?.content).join("\n---\n")}`);
}

async function testCommonShorthandAccepted(harness: Harness) {
  const tool = harness.tools.get("return_on");
  if (!tool) throw new Error("missing return_on tool");

  const timer = await tool.execute("timer-shorthand", {
    label: "timer shorthand",
    condition: { timer: "10s" },
    resume: "timer shorthand resume",
  }, new AbortController().signal, () => {}, harness.ctx);
  const timerJob = timer.details.job;
  allJobIds.push(timerJob.id);
  if (timerJob.condition.type !== "timer" || timerJob.condition.after !== "10s") throw new Error(`timer shorthand was not normalized: ${JSON.stringify(timerJob.condition)}`);
  await harness.cancel(timerJob.id);

  const duration = await tool.execute("timer-duration", {
    label: "timer duration alias",
    condition: { type: "timer", duration: "10s" },
    resume: "timer duration resume",
  }, new AbortController().signal, () => {}, harness.ctx);
  const durationJob = duration.details.job;
  allJobIds.push(durationJob.id);
  if (durationJob.condition.type !== "timer" || durationJob.condition.after !== "10s") throw new Error(`timer duration alias was not normalized: ${JSON.stringify(durationJob.condition)}`);
  await harness.cancel(durationJob.id);

  const exec = await tool.execute("exec-shorthand", {
    label: "exec shorthand",
    condition: { exec: "exit 1", failure: true, every: "2s" },
    allowExec: true,
    resume: "exec shorthand resume",
  }, new AbortController().signal, () => {}, harness.ctx);
  const execJob = exec.details.job;
  allJobIds.push(execJob.id);
  if (execJob.condition.type !== "exec" || execJob.condition.command !== "exit 1") throw new Error(`exec shorthand was not normalized: ${JSON.stringify(execJob.condition)}`);
  await harness.cancel(execJob.id);
}

async function testLogContains(harness: Harness) {
  const label = "smoke log";
  const resume = "log resume";
  const log = path.join(cwd, "server.log");
  await fs.writeFile(log, "booting\n", "utf8");
  const jobId = await harness.register({
    label,
    every: "100ms",
    condition: { type: "file", path: "server.log", contains: "READY" },
    resume,
  });
  await expectNoWake(harness, jobId, 800, "log fired before READY was appended");
  await fs.appendFile(log, "READY\n", "utf8");
  await waitForWake(harness, { jobId, label, resume }, 2_500);
}

async function testIncomingWebhookWake(harness: Harness) {
  const label = "smoke incoming webhook";
  const resume = "incoming webhook resume";
  const tool = harness.tools.get("return_on");
  if (!tool) throw new Error("missing return_on tool");
  const result = await tool.execute("incoming", {
    label,
    condition: { type: "webhook" },
    resume,
  }, new AbortController().signal, () => {}, harness.ctx);
  if (!result?.terminate) throw new Error("incoming webhook registration should terminate");
  const jobId = result.details.job.id as string;
  allJobIds.push(jobId);
  const url = result.details.incomingWebhooks?.[0]?.url;
  if (!url) throw new Error("incoming webhook registration did not return a URL");
  const response = await fetch(url, { method: "POST", body: JSON.stringify({ ready: true }) });
  if (response.status !== 202) throw new Error(`incoming webhook returned ${response.status}: ${await response.text()}`);
  await waitForWake(harness, { jobId, label, resume }, 2_500);
}

async function testWebhookOnFire(harness: Harness) {
  const label = "smoke webhook";
  const resume = "webhook resume";
  const received: any[] = [];
  const server = net.createServer((socket) => {
    let raw = "";
    socket.on("data", (chunk) => {
      raw += chunk.toString();
      const headerEnd = raw.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headers = raw.slice(0, headerEnd);
      const lengthMatch = headers.match(/content-length:\s*(\d+)/i);
      const contentLength = lengthMatch ? Number(lengthMatch[1]) : 0;
      const body = raw.slice(headerEnd + 4);
      if (Buffer.byteLength(body) < contentLength) return;
      received.push(JSON.parse(body));
      socket.end("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("webhook test server did not bind");
  const jobId = await harness.register({
    label,
    condition: { type: "timer", after: "200ms" },
    webhook: { url: `http://127.0.0.1:${address.port}/hook`, headers: { "x-test": "return-on" }, timeout: "2s" },
    resume,
  });
  await waitForWake(harness, { jobId, label, resume }, 2_500);
  const start = Date.now();
  while (received.length === 0 && Date.now() - start < 2_500) await sleep(50);
  server.close();
  if (received.length !== 1) throw new Error(`expected one webhook delivery, saw ${received.length}`);
  if (received[0].event !== "return_on.fired" || received[0].id !== jobId || received[0].label !== label || received[0].resume !== resume) {
    throw new Error(`webhook payload had wrong content: ${JSON.stringify(received[0])}`);
  }
}

async function testFileWatchImmediate(harness: Harness) {
  const label = "smoke file event";
  const resume = "file event resume";
  const log = path.join(cwd, "event.log");
  await fs.writeFile(log, "booting\n", "utf8");
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "event.log", contains: "EVENT_READY", every: "1h" },
    resume,
  });
  await sleep(1_300); // let polling observe the missing text; without fs.watch, the 1h interval would now suppress re-checks.
  await fs.appendFile(log, "EVENT_READY\n", "utf8");
  await waitForWake(harness, { jobId, label, resume }, 1_500);
}

async function testFileStable(harness: Harness) {
  const label = "smoke stable file";
  const resume = "stable file resume";
  const file = path.join(cwd, "out.mp4");
  await fs.writeFile(file, "partial", "utf8");
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "out.mp4", stableFor: "2500ms", every: "100ms" },
    resume,
  });
  await sleep(1200); // let the first poll observe the file
  await fs.appendFile(file, " later", "utf8");
  await expectNoWake(harness, jobId, 1800, "stableFor did not reset after observed modification");
  await waitForWake(harness, { jobId, label, resume }, 4_000);
}

async function testProcessGone(harness: Harness) {
  const label = "smoke process gone";
  const resume = "process gone resume";
  const child = spawn("sleep", ["2"], { stdio: "ignore" });
  const jobId = await harness.register({
    label,
    condition: { type: "process", pid: child.pid, exited: true, every: "2s" },
    resume,
  });
  await expectNoWake(harness, jobId, 1_000, "process watcher fired while process was alive");
  await waitForWake(harness, { jobId, label, resume }, 6_000);
}

async function testPortOpen(harness: Harness) {
  const label = "smoke port open";
  const resume = "port open resume";
  const serverScript = path.join(cwd, "server.mjs");
  const port = await getFreePort();
  await fs.writeFile(serverScript, `
    import http from 'node:http';
    setTimeout(() => {
      const server = http.createServer((_req, res) => res.end('ok'));
      server.listen(${port}, '127.0.0.1');
      setTimeout(() => server.close(() => process.exit(0)), 4000);
    }, 1200);
  `, "utf8");
  const server = spawn("node", [serverScript], { cwd, stdio: "ignore" });
  const jobId = await harness.register({
    label,
    condition: { type: "port", host: "127.0.0.1", port, open: true, every: "2s", timeout: "1s" },
    resume,
  });
  await expectNoWake(harness, jobId, 800, "port watcher fired before server started");
  await waitForWake(harness, { jobId, label, resume }, 6_000);
  server.kill("SIGTERM");
}

async function testUrlReady(harness: Harness) {
  const label = "smoke url ready";
  const resume = "url ready resume";
  const serverScript = path.join(cwd, "url-server.mjs");
  const port = await getFreePort();
  await fs.writeFile(serverScript, `
    import http from 'node:http';
    setTimeout(() => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('healthy');
      });
      server.listen(${port}, '127.0.0.1');
      setTimeout(() => server.close(() => process.exit(0)), 4000);
    }, 1200);
  `, "utf8");
  const server = spawn("node", [serverScript], { cwd, stdio: "ignore" });
  const jobId = await harness.register({
    label,
    condition: { type: "url", url: `http://127.0.0.1:${port}/health`, status: 200, bodyContains: "healthy", every: "2s", timeout: "1s" },
    resume,
  });
  await expectNoWake(harness, jobId, 800, "url watcher fired before server started");
  await waitForWake(harness, { jobId, label, resume }, 6_000);
  server.kill("SIGTERM");
}

async function testFileExistsFalse(harness: Harness) {
  const label = "smoke exists false";
  const resume = "exists false resume";
  const file = path.join(cwd, "temporary.flag");
  await fs.writeFile(file, "present", "utf8");
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "temporary.flag", exists: false, every: "100ms" },
    resume,
  });
  await expectNoWake(harness, jobId, 1_200, "exists:false fired while file existed");
  await fs.unlink(file);
  await waitForWake(harness, { jobId, label, resume }, 2_500);
}

async function testNotConditionAfterDelete(harness: Harness) {
  const label = "smoke not after delete";
  const resume = "not resume";
  const file = path.join(cwd, "not-flag.txt");
  await fs.writeFile(file, "present", "utf8");
  const jobId = await harness.register({
    label,
    condition: { not: { type: "file", path: "not-flag.txt", exists: true, every: "2s" } },
    resume,
  });
  await expectNoWake(harness, jobId, 2_500, "not condition fired while child was true or between polls");
  await fs.unlink(file);
  await waitForWake(harness, { jobId, label, resume }, 4_000);
}

async function testNotExecAfterDelete(harness: Harness) {
  const label = "smoke not exec after delete";
  const resume = "not exec resume";
  const file = path.join(cwd, "not-exec-flag.txt");
  await fs.writeFile(file, "present", "utf8");
  const jobId = await harness.register({
    label,
    allowExec: true,
    condition: { not: { type: "exec", runner: "sh", command: "test -f not-exec-flag.txt", success: true, every: "2s" } },
    resume,
  });
  await expectNoWake(harness, jobId, 2_500, "not exec condition fired while command was still succeeding or between polls");
  await fs.unlink(file);
  await waitForWake(harness, { jobId, label, resume }, 4_000);
}

async function testEmptyGroupRejected(harness: Harness) {
  for (const [label, condition] of [
    ["empty all", { all: [] }],
    ["empty any", { any: [] }],
  ] as const) {
    let rejected = false;
    try {
      await harness.register({ label, condition, resume: "should reject" });
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("requires children");
    }
    if (!rejected) throw new Error(`${label} was not rejected`);
  }
}

async function testBooleanTree(harness: Harness) {
  const label = "smoke boolean tree";
  const resume = "boolean resume";
  const jobId = await harness.register({
    label,
    allowExec: true,
    condition: {
      all: [
        { type: "timer", after: "1500ms" },
        { any: [
          { type: "file", path: "never-created.txt", exists: true, every: "100ms" },
          { type: "exec", runner: "sh", command: "exit 0", success: true, every: "2s" }
        ] }
      ]
    },
    resume,
  });
  await expectNoWake(harness, jobId, 1_000, "boolean tree fired before timer leaf latched");
  await waitForWake(harness, { jobId, label, resume }, 5_000);
}

async function testCancelBeforeFire(harness: Harness) {
  const label = "smoke cancel";
  const resume = "cancel resume";
  const jobId = await harness.register({ label, condition: { type: "timer", after: "2500ms" }, resume });
  await harness.cancel(jobId);
  await expectNoWake(harness, jobId, 3_000, "cancelled timer fired");
}

async function testTimeoutWake(harness: Harness) {
  const label = "smoke timeout";
  const resume = "timeout resume";
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "never-timeout.txt", exists: true, every: "100ms" },
    timeout: "1500ms",
    resume,
  });
  await expectNoWake(harness, jobId, 900, "timeout fired too early");
  const entry = await waitForWake(harness, { jobId, label, resume }, 3_000);
  if (!String(entry.message.content).includes("Reason: timeout")) throw new Error("timeout wake did not include timeout reason");
}

async function testExecConfirmationAndValidation() {
  const noUi = createHarness("no-ui-exec", { hasUI: false });
  await noUi.emit("session_start");
  let rejected = false;
  try {
    await noUi.register({ label: "no ui exec", condition: { type: "exec", command: "exit 0" }, resume: "no ui resume" });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("allowExec=true");
  }
  if (!rejected) throw new Error("exec watcher without allowExec was not rejected when UI was unavailable");
  await noUi.emit("session_shutdown");

  const invalidRunner = createHarness("invalid-runner");
  await invalidRunner.emit("session_start");
  rejected = false;
  try {
    await invalidRunner.register({ label: "bad runner", allowExec: true, condition: { type: "exec", runner: "ruby", command: "exit 0" }, resume: "bad runner resume" });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("unsupported exec runner");
  }
  if (!rejected) throw new Error("unsupported exec runner was not rejected");
  await invalidRunner.emit("session_shutdown");

  const confirmed = createHarness("confirmed-exec", { confirm: true });
  await confirmed.emit("session_start");
  const label = "confirmed exec";
  const resume = "confirmed exec resume";
  const jobId = await confirmed.register({ label, condition: { type: "exec", runner: "sh", command: "exit 0", success: true, every: "2s" }, resume });
  if (confirmed.confirmCalls !== 1) throw new Error(`expected one exec confirmation, saw ${confirmed.confirmCalls}`);
  await waitForWake(confirmed, { jobId, label, resume }, 3_500);
  await confirmed.emit("session_shutdown");
}

async function testListToolAndCommands() {
  const harness = createHarness("list-and-commands");
  await harness.emit("session_start");
  const activeId = await harness.register({ label: "list active", condition: { type: "timer", after: "10s" }, resume: "list active resume" });
  const statusAfterActive = harness.statuses.at(-1)?.value ?? "";
  if (!statusAfterActive.includes("list active") || !statusAfterActive.includes("timer")) {
    throw new Error(`status tag did not show active wait label and condition: ${statusAfterActive}`);
  }
  const cancelId = await harness.register({ label: "list cancel", condition: { type: "timer", after: "10s" }, resume: "list cancel resume" });
  await harness.cancel(cancelId);

  const listTool = harness.tools.get("return_on_list");
  if (!listTool) throw new Error("missing return_on_list tool");
  const active = await listTool.execute("list", { status: "active" }, new AbortController().signal, () => {}, harness.ctx);
  const cancelled = await listTool.execute("list", { status: "cancelled" }, new AbortController().signal, () => {}, harness.ctx);
  const activeText = String(active.content?.[0]?.text ?? "");
  const cancelledText = String(cancelled.content?.[0]?.text ?? "");
  if (!activeText.includes(activeId) || activeText.includes(cancelId) || !activeText.includes("waiting:") || !activeText.includes("condition:")) throw new Error(`active list had wrong jobs or missing wait detail: ${activeText}`);
  if (!cancelledText.includes(cancelId) || cancelledText.includes(activeId) || !cancelledText.includes("waiting:")) throw new Error(`cancelled list had wrong jobs or missing wait detail: ${cancelledText}`);

  await harness.commands.get("return-on-status")?.handler(cancelId, harness.ctx);
  if (!harness.notifications.some((entry) => entry.message.includes(cancelId) && entry.message.includes("cancelled") && entry.message.includes("Condition tree:") && entry.message.includes("Leaf checks:"))) {
    throw new Error("return-on-status command did not notify rich cancelled job details");
  }
  await harness.commands.get("return-on-list")?.handler("", harness.ctx);
  if (!harness.notifications.some((entry) => entry.message.includes(activeId) && entry.message.includes(cancelId))) {
    throw new Error("return-on-list command did not notify session jobs");
  }

  await harness.cancel(activeId);
  await harness.emit("session_shutdown");
}

async function testRestartResume() {
  const label = "smoke restart";
  const resume = "restart resume";
  const first = createHarness("restart-session");
  await first.emit("session_start");
  const jobId = await first.register({ label, condition: { type: "timer", after: "1800ms" }, resume });
  await first.emit("session_shutdown");

  const second = createHarness("restart-session");
  await second.emit("session_start");
  await waitForWake(second, { jobId, label, resume }, 3_500);
  await second.emit("session_shutdown");
}

async function testPendingFiredEventDelivery() {
  const label = "pending fired event";
  const resume = "pending fired resume";
  const reason = "simulated worker fired";
  const first = createHarness("pending-fired-event");
  await first.emit("session_start");
  const jobId = await first.register({ label, condition: { type: "timer", after: "1h" }, resume });
  await first.emit("session_shutdown");

  const jobsPath = path.join(stateDir, "jobs.json");
  const jobsState = JSON.parse(await fs.readFile(jobsPath, "utf8"));
  const job = jobsState.jobs.find((candidate: any) => candidate.id === jobId);
  if (!job) throw new Error(`missing saved job ${jobId}`);
  const firedAt = Date.now();
  const firedJob = { ...job, status: "fired", firedAt, updatedAt: firedAt, fireReason: reason };
  const firedDir = path.join(stateDir, "fired");
  await fs.mkdir(firedDir, { recursive: true });
  const firedPath = path.join(firedDir, `${jobId}.json`);
  await fs.writeFile(firedPath, JSON.stringify({
    version: 1,
    event: "return_on.fired",
    id: jobId,
    jobId,
    label,
    reason,
    createdAt: job.createdAt,
    firedAt,
    cwd,
    sessionFile: first.sessionFile,
    resume,
    job: firedJob,
    deliveryStatus: "pending",
  }, null, 2), "utf8");

  const second = createHarness("pending-fired-event");
  await second.emit("session_start");
  const entries = wakeEntries(second, jobId);
  if (entries.length !== 1) throw new Error(`pending fired event was not delivered exactly once: ${entries.length}`);
  assertWake(entries[0], { jobId, label, resume });
  const delivered = JSON.parse(await fs.readFile(firedPath, "utf8"));
  if (delivered.deliveryStatus !== "wake-sent" || !delivered.deliveredAt) {
    throw new Error(`pending fired event was not marked delivered: ${JSON.stringify(delivered)}`);
  }
  await second.emit("session_shutdown");
}

async function testSessionIsolation() {
  const label = "smoke session isolation";
  const resume = "session isolation resume";
  const sessionA = createHarness("session-a");
  await sessionA.emit("session_start");
  const jobId = await sessionA.register({ label, condition: { type: "timer", after: "1500ms" }, resume });
  await sessionA.emit("session_shutdown");

  const sessionB = createHarness("session-b");
  await sessionB.emit("session_start");
  await expectNoWake(sessionB, jobId, 2_300, "session B woke session A job");
  await sessionB.emit("session_shutdown");

  const sessionAAgain = createHarness("session-a");
  await sessionAAgain.emit("session_start");
  await waitForWake(sessionAAgain, { jobId, label, resume }, 2_000);
  await sessionAAgain.emit("session_shutdown");
}

const harness = createHarness("main-session");
await harness.emit("session_start");

await testDirectWaitPolicy(harness);
await testCommonShorthandAccepted(harness);
await testTimer(harness);
await testForkDelivery(harness);
await testIncomingWebhookWake(harness);
await testWebhookOnFire(harness);
await testLogContains(harness);
await testFileWatchImmediate(harness);
await testFileStable(harness);
await testProcessGone(harness);
await testPortOpen(harness);
await testUrlReady(harness);
await testFileExistsFalse(harness);
await testNotConditionAfterDelete(harness);
await testNotExecAfterDelete(harness);
await testEmptyGroupRejected(harness);
await testBooleanTree(harness);
await testCancelBeforeFire(harness);
await testTimeoutWake(harness);
await harness.emit("session_shutdown");
await testExecConfirmationAndValidation();
await testListToolAndCommands();
await testRestartResume();
await testPendingFiredEventDelivery();
await testSessionIsolation();

const duplicateIds = allJobIds.filter((id, index) => allJobIds.indexOf(id) !== index);
if (duplicateIds.length > 0) throw new Error(`duplicate job ids: ${duplicateIds.join(", ")}`);

console.log(`smoke ok: ${allJobIds.length} jobs tested, cwd=${cwd}, home=${process.env.HOME}`);
