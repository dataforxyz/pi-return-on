import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as net from "node:net";

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

process.env.HOME = await fs.mkdtemp(path.join(os.tmpdir(), "pi-return-on-home-"));
process.env.PI_RETURN_ON_WEBHOOK_PORT ??= String(await getFreePort());

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
const projectSettingsDir = path.join(cwd, ".pi");
const projectSettingsPath = path.join(projectSettingsDir, "settings.json");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const allJobIds: string[] = [];

async function withUserAgentSettings(settings: unknown, fn: () => Promise<void>): Promise<void> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-return-on-agent-dir-"));
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
  await withEnv({ PI_CODING_AGENT_DIR: agentDir }, fn);
  await fs.rm(agentDir, { recursive: true, force: true });
}

async function withTildeUserAgentSettings(settings: unknown, fn: () => Promise<void>): Promise<void> {
  const agentName = `pi-return-on-agent-dir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const agentDir = path.join(os.homedir(), agentName);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
  try {
    await withEnv({ PI_CODING_AGENT_DIR: `~/${agentName}` }, fn);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

async function withProjectSettings(settings: unknown, fn: () => Promise<void>): Promise<void> {
  let previous: string | undefined;
  try {
    previous = await fs.readFile(projectSettingsPath, "utf8");
  } catch {
    previous = undefined;
  }
  await fs.mkdir(projectSettingsDir, { recursive: true });
  await fs.writeFile(projectSettingsPath, JSON.stringify(settings, null, 2), "utf8");
  try {
    await fn();
  } finally {
    if (previous === undefined) await fs.rm(projectSettingsPath, { force: true });
    else await fs.writeFile(projectSettingsPath, previous, "utf8");
  }
}

async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function createHarness(sessionName: string, options: { hasUI?: boolean; confirm?: boolean | (() => boolean | Promise<boolean>); failSendMessage?: boolean; isIdle?: () => boolean; hasPendingMessages?: () => boolean; signal?: () => AbortSignal | undefined } = {}) {
  const tools = new Map<string, Tool>();
  const events = new Map<string, Function[]>();
  const messages: any[] = [];
  const entries: any[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<{ key: string; value?: string }> = [];
  const commands = new Map<string, any>();
  const sessionFile = path.join(cwd, `${sessionName}.jsonl`);
  let confirmCalls = 0;

  const ctx: any = {
    cwd,
    hasUI: options.hasUI ?? true,
    isIdle: options.isIdle ?? (() => true),
    get signal() { return options.signal?.(); },
    hasPendingMessages: options.hasPendingMessages ?? (() => false),
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
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    on(event: string, handler: Function) {
      const handlers = events.get(event) ?? [];
      handlers.push(handler);
      events.set(event, handlers);
      return () => events.set(event, handlers.filter((candidate) => candidate !== handler));
    },
    sendMessage(message: unknown, sendOptions: unknown) {
      if (options.failSendMessage) throw new Error("simulated sendMessage failure");
      messages.push({ message, options: sendOptions, at: Date.now() });
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

  async function callTool(name: string, params: any) {
    return requireTool(name).execute("call", params, new AbortController().signal, () => {}, ctx);
  }

  async function register(params: any) {
    const result = await callTool("return_on", params);
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

  return { beforeAgentStart, callTool, commands, ctx, emit, entries, messages, notifications, register, cancel, runCommand, sessionFile, statuses, toolCall, tools, get confirmCalls() { return confirmCalls; } };
}

function wakeEntries(harness: Harness, jobId: string) {
  return harness.messages.filter((entry) => entry.message?.details?.id === jobId);
}

function checkInEntries(harness: Harness, jobId: string) {
  return wakeEntries(harness, jobId).filter((entry) => entry.message?.details?.checkIn === true);
}

function finalWakeEntries(harness: Harness, jobId: string) {
  return wakeEntries(harness, jobId).filter((entry) => entry.message?.details?.checkIn !== true);
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
    const entries = finalWakeEntries(harness, expectation.jobId);
    if (entries.length > 0) {
      if (entries.length !== 1) throw new Error(`expected exactly one wake for ${expectation.label}, saw ${entries.length}`);
      assertWake(entries[0], expectation);
      return entries[0];
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${expectation.label}. Messages: ${harness.messages.map((m) => m.message?.content).join("\n---\n")}`);
}

async function waitForWakeCount(harness: Harness, expectation: WakeExpectation, expectedCount: number, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entries = finalWakeEntries(harness, expectation.jobId);
    if (entries.length >= expectedCount) {
      for (const entry of entries) assertWake(entry, expectation);
      return entries;
    }
    await sleep(100);
  }
  const entries = finalWakeEntries(harness, expectation.jobId);
  throw new Error(`timed out waiting for ${expectedCount} wakes of ${expectation.label}, saw ${entries.length}`);
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
  await harness.emit("agent_end");

  const blockedSleep = await harness.toolCall("bash", { command: "sleep 10" });
  if (!blockedSleep?.block || !String(blockedSleep.reason).includes("return_on")) {
    throw new Error(`10 second sleep was not blocked with return_on guidance: ${JSON.stringify(blockedSleep)}`);
  }

  const longerSleep = await harness.toolCall("bash", { command: "sleep 30" });
  if (!longerSleep?.block || !String(longerSleep.reason).includes("return_on")) {
    throw new Error(`long sleep was not blocked with return_on guidance: ${JSON.stringify(longerSleep)}`);
  }
  if (!String(longerSleep.reason).includes("type:\"timer\"") || !String(longerSleep.reason).includes("30s")) {
    throw new Error(`long sleep block did not suggest a timer watcher: ${JSON.stringify(longerSleep)}`);
  }

  const blockedTail = await harness.toolCall("bash", { command: "tail -f server.log" });
  if (!blockedTail?.block || !String(blockedTail.reason).includes("tail -f")) {
    throw new Error(`tail -f was not blocked: ${JSON.stringify(blockedTail)}`);
  }
  if (!String(blockedTail.reason).includes("type:\"file\"")) {
    throw new Error(`tail block did not suggest a file watcher: ${JSON.stringify(blockedTail)}`);
  }

  const blockedDevServer = await harness.toolCall("bash", { command: "npm run dev" });
  if (!blockedDevServer?.block || !String(blockedDevServer.reason).includes("background")) {
    throw new Error(`foreground dev server was not blocked: ${JSON.stringify(blockedDevServer)}`);
  }
  if (!String(blockedDevServer.reason).includes("type:\"port\"")) {
    throw new Error(`dev server block did not suggest a port watcher: ${JSON.stringify(blockedDevServer)}`);
  }

  const shortSleep = await harness.toolCall("bash", { command: "sleep 9" });
  if (shortSleep?.block) throw new Error(`sleep under 10 seconds should not be blocked: ${JSON.stringify(shortSleep)}`);

  const backgrounded = await harness.toolCall("bash", { command: "mkdir -p .return-on && npm run dev > .return-on/dev.log 2>&1 & echo $! > .return-on/dev.pid" });
  if (backgrounded?.block) throw new Error(`backgrounded dev server should not be blocked: ${JSON.stringify(backgrounded)}`);

  const longTimeout = await harness.toolCall("bash", { command: "timeout 900 uv run pytest tests/" });
  if (!longTimeout?.block || !String(longTimeout.reason).includes("timeout-bounded command")) {
    throw new Error(`long timeout-bounded command was not blocked: ${JSON.stringify(longTimeout)}`);
  }
  if (!String(longTimeout.reason).includes("type:\"process\"") || !String(longTimeout.reason).includes("pidFile")) {
    throw new Error(`timeout-bounded block did not suggest a process/pidFile watcher: ${JSON.stringify(longTimeout)}`);
  }

  const shortTimeout = await harness.toolCall("bash", { command: "timeout 60 make check" });
  if (shortTimeout?.block) {
    throw new Error(`60s timeout-bounded command should not be blocked: ${JSON.stringify(shortTimeout)}`);
  }

  const ghRunWatch = await harness.toolCall("bash", { command: "gh run watch 12345 --exit-status" });
  if (!ghRunWatch?.block || !String(ghRunWatch.reason).includes("gh run watch") || !String(ghRunWatch.reason).includes("type:\"exec\"")) {
    throw new Error(`gh run watch was not blocked with exec-watcher guidance: ${JSON.stringify(ghRunWatch)}`);
  }
  const ghChecksWatchFalse = await harness.toolCall("bash", { command: "gh pr checks 99 --watch=false" });
  if (ghChecksWatchFalse?.block) {
    throw new Error(`gh pr checks --watch=false should not be blocked: ${JSON.stringify(ghChecksWatchFalse)}`);
  }

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
  if (!auditLines.some((entry) => entry.action === "blocked" && entry.kind === "timeout-bounded command" && entry.detail === "timeout 900s")) {
    throw new Error(`long timeout-bounded command was not audited: ${JSON.stringify(auditLines)}`);
  }
  if (!auditLines.some((entry) => entry.action === "allowed_short_timeout" && entry.detail === "timeout 60s")) {
    throw new Error(`short timeout-bounded command was not audited: ${JSON.stringify(auditLines)}`);
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

async function testRegisterWithoutEndingTurn(harness: Harness) {
  const result = await harness.callTool("return_on", {
    label: "smoke continue registration",
    condition: { type: "timer", after: "50ms" },
    resume: "continue registration resume",
    endTurn: false,
  });
  if (result.terminate !== false) throw new Error("endTurn:false should not terminate the current turn");
  if (result.details.job.endTurn !== false) throw new Error("endTurn:false should be persisted on the job");
  if (!String(result.content?.[0]?.text ?? "").includes("Continuing this turn")) throw new Error("endTurn:false response did not explain continuing");
  const jobId = result.details.job.id;
  allJobIds.push(jobId);
  await waitForWake(harness, { jobId, label: "smoke continue registration", resume: "continue registration resume" }, 1_500);
}

async function testDuplicateWatcherRegistrationDedupes(harness: Harness) {
  const label = "smoke duplicate watcher";
  const condition = { type: "timer", after: "10m" };
  const first = await harness.callTool("return_on", { label, condition, resume: "first resume", endTurn: false });
  const second = await harness.callTool("return_on", { label, condition, resume: "second resume from sibling handler", parent: "main", endTurn: false });
  const firstId = first.details.job.id;
  const secondId = second.details.job.id;
  allJobIds.push(firstId);
  if (first.details.duplicate) throw new Error("first duplicate watcher registration was unexpectedly deduped");
  if (!second.details.duplicate) throw new Error("second duplicate watcher registration was not marked duplicate");
  if (secondId !== firstId) throw new Error(`duplicate watcher returned different id: ${firstId} vs ${secondId}`);
  const text = String(second.content?.[0]?.text ?? "");
  if (!text.includes("already waiting") || !text.includes("no duplicate watcher was registered")) throw new Error(`duplicate response was unclear: ${text}`);
  const registeredEntries = harness.entries.filter((entry) => entry.type === "return-on-registered" && entry.data?.label === label);
  const dedupedEntries = harness.entries.filter((entry) => entry.type === "return-on-deduped" && entry.data?.label === label);
  if (registeredEntries.length !== 1) throw new Error(`expected one registered entry, saw ${registeredEntries.length}`);
  if (dedupedEntries.length !== 1) throw new Error(`expected one deduped entry, saw ${dedupedEntries.length}`);
  await harness.cancel(firstId);

  const forkLabel = "smoke duplicate watcher from fork";
  const parent = await harness.callTool("return_on", { label: forkLabel, condition, resume: "parent resume", endTurn: false });
  const parentId = parent.details.job.id;
  allJobIds.push(parentId);
  const forkHarness = createHarness("dedupe-fork-session");
  await withEnv({ PI_RETURN_ON_PARENT_SESSION_FILE: harness.sessionFile, PI_RETURN_ON_PARENT_SESSION_NAME: "main-session" }, async () => {
    const fork = await forkHarness.callTool("return_on", { label: forkLabel, condition, resume: "fork handler follow-up resume", parent: "main", endTurn: false });
    if (!fork.details.duplicate) throw new Error("fork-routed duplicate watcher registration was not marked duplicate");
    if (fork.details.job.id !== parentId) throw new Error(`fork duplicate watcher returned different id: ${parentId} vs ${fork.details.job.id}`);
  });
  await harness.cancel(parentId);
}

async function testForkDelivery(harness: Harness) {
  const fakePi = path.join(cwd, "fake-pi.mjs");
  const fakePiArgs = path.join(cwd, "fake-pi-args.json");
  process.env.PI_RETURN_ON_FAKE_PI_ARGS = fakePiArgs;
  await fs.writeFile(fakePi, `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(process.env.PI_RETURN_ON_FAKE_PI_ARGS, JSON.stringify(process.argv.slice(2)));\nconsole.log("fake return_on handler summary");\n`, { mode: 0o755 });
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
    if (summary) {
      if (ack) throw new Error("fork delivery should default to summary-only without a launch ack");
      if (summary.options?.triggerTurn !== true) throw new Error("fork delivery summary should trigger parent turn by default");
      const summaryContent = String(summary.message?.content ?? "");
      if (!summaryContent.includes("fake return_on handler summary")) throw new Error("fork delivery summary missed fake handler output");
      if (!summaryContent.includes("Output:") || !summaryContent.includes("Errors: none")) throw new Error("fork delivery summary missed log pointers");
      const args = JSON.parse(await fs.readFile(fakePiArgs, "utf8"));
      if (!args.includes("--fork")) throw new Error(`fork delivery should fork the parent transcript when safe: ${JSON.stringify(args)}`);
      const systemPromptIndex = args.indexOf("--append-system-prompt");
      if (systemPromptIndex === -1) throw new Error("fork delivery did not pass a handler system prompt");
      const handlerSystemPrompt = String(args[systemPromptIndex + 1] ?? "");
      if (!handlerSystemPrompt.includes("intercom.send")) throw new Error("handler system prompt missed intercom policy");
      if (!handlerSystemPrompt.includes("delegated authority")) throw new Error("handler system prompt missed delegated authority policy");
      const promptArg = args.find((arg: string) => arg.startsWith("@"));
      if (!promptArg) throw new Error("fork delivery did not pass a prompt file");
      const prompt = await fs.readFile(promptArg.slice(1), "utf8");
      if (!prompt.includes("intercom.send") || !prompt.includes("intercom.ask")) throw new Error("handler prompt missed intercom policy");
      if (!prompt.includes("delegated") || !prompt.includes("low confidence")) throw new Error("handler prompt missed delegated authority boundaries");
      if (harness.entries.some((entry) => entry.type === "return-on-fired" && entry.data?.id === jobId)) {
        throw new Error("fork delivery should not also append a parent return-on-fired wake entry");
      }
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for fork delivery handler messages: ${harness.messages.map((m) => m.message?.content).join("\n---\n")}`);
}

async function testForkDeliverySkipsEmptyParentSession(harness: Harness) {
  const fakePi = path.join(cwd, "fake-empty-parent-session-pi.mjs");
  const fakePiArgs = path.join(cwd, "fake-empty-parent-session-args.json");
  process.env.PI_RETURN_ON_FAKE_EMPTY_PARENT_ARGS = fakePiArgs;
  await fs.writeFile(harness.sessionFile, "", "utf8");
  await fs.writeFile(fakePi, `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(process.env.PI_RETURN_ON_FAKE_EMPTY_PARENT_ARGS, JSON.stringify(process.argv.slice(2)));\nconsole.log("empty parent fallback summary");\n`, { mode: 0o755 });
  const label = "smoke empty parent session fork delivery";
  const jobId = await harness.register({
    label,
    condition: { type: "timer", after: "100ms" },
    resume: "empty parent session resume",
    delivery: { mode: "fork", piCommand: fakePi },
  });
  const start = Date.now();
  while (Date.now() - start < 2_500) {
    const summary = harness.messages.find((entry) => entry.message?.customType === "return-on-handler" && entry.message?.details?.id === jobId && entry.message?.details?.status === "complete");
    if (summary) {
      const args = JSON.parse(await fs.readFile(fakePiArgs, "utf8"));
      if (args.includes("--fork")) throw new Error(`fork delivery should skip empty parent transcript: ${JSON.stringify(args)}`);
      if (!String(summary.message?.content ?? "").includes("empty parent fallback summary")) throw new Error("empty parent session summary missed handler output");
      return;
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for empty parent session fork handler summary");
}

async function testDefaultPiCommandFallsBackToHomeBin(harness: Harness) {
  const homeBin = path.join(os.homedir(), ".local", "bin");
  const fakePi = path.join(homeBin, "pi");
  const fakePiArgs = path.join(cwd, "fake-home-bin-pi-args.json");
  await fs.mkdir(homeBin, { recursive: true });
  await fs.writeFile(fakePi, `#!/bin/sh\nprintf '%s\n' "$@" > ${JSON.stringify(fakePiArgs)}\necho "home bin pi summary"\n`, { mode: 0o755 });
  try {
    await withEnv({ PATH: "", PI_RETURN_ON_PI_BIN: undefined }, async () => {
      const label = "smoke home bin pi fallback";
      const jobId = await harness.register({
        label,
        condition: { type: "timer", after: "100ms" },
        resume: "home bin pi fallback resume",
        delivery: { mode: "fork" },
      });
      const start = Date.now();
      while (Date.now() - start < 2_500) {
        const summary = harness.messages.find((entry) => entry.message?.customType === "return-on-handler" && entry.message?.details?.id === jobId && entry.message?.details?.status === "complete");
        if (summary) {
          if (!String(summary.message?.content ?? "").includes("home bin pi summary")) throw new Error("home bin pi fallback missed handler output");
          await fs.readFile(fakePiArgs, "utf8");
          return;
        }
        await sleep(50);
      }
      throw new Error("timed out waiting for home bin pi fallback handler summary");
    });
  } finally {
    await fs.rm(fakePi, { force: true });
  }
}

async function testAutoDeliveryWakesIdleParent(harness: Harness) {
  const fakePi = path.join(cwd, "fake-auto-idle-pi.mjs");
  const fakePiMarker = path.join(cwd, "fake-auto-idle-launched");
  await fs.writeFile(fakePi, `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(fakePiMarker)}, "launched");\n`, { mode: 0o755 });
  const label = "smoke auto idle delivery";
  const resume = "auto idle resume";
  const jobId = await harness.register({
    label,
    condition: { type: "timer", after: "100ms" },
    resume,
    delivery: { mode: "auto", piCommand: fakePi },
  });
  await waitForWake(harness, { jobId, label, resume }, 2_500);
  const markerExists = await fs.access(fakePiMarker).then(() => true, () => false);
  if (markerExists) throw new Error("auto delivery forked even though the parent was idle");
}

async function testAutoDeliveryForksBusyParent(harness: Harness) {
  const fakePi = path.join(cwd, "fake-auto-busy-pi.mjs");
  await fs.writeFile(fakePi, `#!/usr/bin/env node\nconsole.log("auto busy fork summary");\n`, { mode: 0o755 });
  const label = "smoke auto busy delivery";
  const jobId = await harness.register({
    label,
    condition: { type: "timer", after: "100ms" },
    resume: "auto busy resume",
    delivery: { mode: "auto", piCommand: fakePi },
  });
  const start = Date.now();
  while (Date.now() - start < 2_500) {
    const summary = harness.messages.find((entry) => entry.message?.customType === "return-on-handler" && entry.message?.details?.id === jobId && entry.message?.details?.status === "complete");
    if (summary) {
      if (!String(summary.message?.content ?? "").includes("auto busy fork summary")) throw new Error("auto busy fork summary missed handler output");
      return;
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for auto busy fork handler summary");
}

async function testEmptyForkHandlerSummaryFallback(harness: Harness) {
  const fakePi = path.join(cwd, "fake-empty-handler-pi.mjs");
  await fs.writeFile(fakePi, `#!/usr/bin/env node\n`, { mode: 0o755 });
  const label = "smoke empty fork summary";
  const jobId = await harness.register({
    label,
    condition: { type: "timer", after: "100ms" },
    resume: "empty handler summary resume",
    delivery: { mode: "fork", piCommand: fakePi, notify: "summary", triggerParentOnSummary: true },
  });
  const start = Date.now();
  while (Date.now() - start < 2_500) {
    const handlerMessages = harness.messages.filter((entry) => entry.message?.customType === "return-on-handler" && entry.message?.details?.id === jobId);
    const summary = handlerMessages.find((entry) => entry.message?.details?.status === "complete");
    if (summary) {
      const content = String(summary.message?.content ?? "");
      if (!content.includes("Handler exited without a final response")) throw new Error(`empty handler summary missed fallback: ${content}`);
      if (content.includes("(no handler output)")) throw new Error(`empty handler summary used old placeholder: ${content}`);
      return;
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for empty fork handler summary");
}

async function testCancelledForkHandlerSuppressesSummary(harness: Harness) {
  const fakePi = path.join(cwd, "fake-cancelled-handler-pi.mjs");
  await fs.writeFile(fakePi, `#!/usr/bin/env node\nawait new Promise((resolve) => setTimeout(resolve, 350));\nconsole.log("cancelled handler should not notify");\n`, { mode: 0o755 });
  const label = "smoke cancelled fork summary";
  const resume = "cancelled fork summary resume";
  const jobId = await harness.register({
    label,
    condition: { type: "timer", after: "100ms" },
    resume,
    delivery: { mode: "fork", piCommand: fakePi, notify: "summary", triggerParentOnSummary: true },
  });

  const handlersPath = path.join(stateDir, "handlers.json");
  let runId: string | undefined;
  const start = Date.now();
  while (Date.now() - start < 2_500) {
    const handlers = await fs.readFile(handlersPath, "utf8").then((text) => JSON.parse(text).handlers as any[], () => []);
    const run = handlers.find((candidate) => candidate.jobId === jobId);
    if (run?.id) {
      runId = run.id;
      break;
    }
    await sleep(50);
  }
  if (!runId) throw new Error("cancelled fork handler was not launched");

  await harness.cancel(jobId);

  const doneStart = Date.now();
  while (Date.now() - doneStart < 2_500) {
    const handlers = await fs.readFile(handlersPath, "utf8").then((text) => JSON.parse(text).handlers as any[], () => []);
    const run = handlers.find((candidate) => candidate.id === runId);
    if (run?.status === "complete") break;
    await sleep(50);
  }
  const handlerMessages = harness.messages.filter((entry) => entry.message?.customType === "return-on-handler" && entry.message?.details?.id === jobId);
  const summary = handlerMessages.find((entry) => entry.message?.details?.status === "complete");
  if (summary) throw new Error(`cancelled fork handler emitted stale summary: ${summary.message?.content}`);
}

async function testForkLaunchFailureFallsBackToWake(harness: Harness) {
  const label = "smoke fork launch fallback";
  const resume = "fork launch fallback resume";
  const missingPi = path.join(cwd, "missing-return-on-pi-command");
  const jobId = await harness.register({
    label,
    condition: { type: "timer", after: "100ms" },
    resume,
    delivery: { mode: "fork", piCommand: missingPi },
  });
  const wake = await waitForWake(harness, { jobId, label, resume }, 2_500);
  if (wake.message?.customType !== "return-on") throw new Error(`fork launch fallback did not wake parent: ${JSON.stringify(wake.message)}`);
  const handlersPath = path.join(stateDir, "handlers.json");
  const handlers = await fs.readFile(handlersPath, "utf8").then((text) => JSON.parse(text).handlers as any[]);
  const handler = handlers.find((candidate) => candidate.jobId === jobId);
  if (handler?.status !== "failed" || !String(handler.error ?? "").includes("ENOENT")) {
    throw new Error(`fork launch failure was not recorded: ${JSON.stringify(handler)}`);
  }
}

async function testAgentArtifactForkDelivery(harness: Harness) {
  const fakePi = path.join(cwd, "fake-agent-pi.mjs");
  const fakePiArgs = path.join(cwd, "fake-agent-pi-args.json");
  await fs.writeFile(fakePi, `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(fakePiArgs)}, JSON.stringify(process.argv.slice(2)));\nconsole.log("agent result triaged");\n`, { mode: 0o755 });
  const resultPath = path.join(cwd, "review-result.json");
  const label = "smoke subagent result ready";
  const resume = "A review subagent result file is ready. Read it, extract blockers, and summarize only the relevant completion triage.";
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "review-result.json", exists: true },
    resume,
    delivery: { mode: "fork", piCommand: fakePi },
  });
  await sleep(100);
  await fs.writeFile(resultPath, JSON.stringify({ status: "complete", summary: "review ok" }), "utf8");
  const start = Date.now();
  while (Date.now() - start < 2_500) {
    const handlerMessages = harness.messages.filter((entry) => entry.message?.customType === "return-on-handler" && entry.message?.details?.id === jobId);
    const summary = handlerMessages.find((entry) => entry.message?.details?.status === "complete");
    if (summary) {
      if (!String(summary.message?.content ?? "").includes("agent result triaged")) throw new Error("agent artifact fork summary missed fake handler output");
      const args = JSON.parse(await fs.readFile(fakePiArgs, "utf8"));
      const promptArg = args.find((arg: string) => arg.startsWith("@"));
      if (!promptArg) throw new Error("agent artifact fork did not pass a prompt file");
      const prompt = await fs.readFile(promptArg.slice(1), "utf8");
      if (!prompt.includes("review subagent result file is ready") || !prompt.includes("completion triage")) throw new Error("agent artifact prompt missed subagent triage instruction");
      if (!prompt.includes("delegated")) throw new Error("agent artifact prompt missed delegated authority guidance");
      return;
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for agent artifact fork handler");
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

  const timerString = await tool.execute("timer-string-condition", {
    label: "timer string condition",
    condition: "10s",
    timeout: JSON.stringify("30s"),
    resume: "timer string condition resume",
  }, new AbortController().signal, () => {}, harness.ctx);
  const timerStringJob = timerString.details.job;
  allJobIds.push(timerStringJob.id);
  if (timerStringJob.condition.type !== "timer" || timerStringJob.condition.after !== "10s") throw new Error(`timer string condition was not normalized: ${JSON.stringify(timerStringJob.condition)}`);
  const timeoutMs = timerStringJob.timeoutAt - timerStringJob.createdAt;
  if (Math.abs(timeoutMs - 30_000) > 1_000) throw new Error(`JSON-encoded timeout string was not parsed as 30s: ${timeoutMs}`);
  await harness.cancel(timerStringJob.id);

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

  const execCmdAlias = await tool.execute("exec-cmd-alias", {
    label: "exec cmd alias",
    condition: { type: "exec", cmd: "exit 0", success: true, every: "2s" },
    allowExec: true,
    resume: "exec cmd alias resume",
  }, new AbortController().signal, () => {}, harness.ctx);
  const execCmdAliasJob = execCmdAlias.details.job;
  allJobIds.push(execCmdAliasJob.id);
  if (execCmdAliasJob.condition.type !== "exec" || execCmdAliasJob.condition.command !== "exit 0" || "cmd" in execCmdAliasJob.condition) throw new Error(`exec cmd alias was not normalized: ${JSON.stringify(execCmdAliasJob.condition)}`);
  await harness.cancel(execCmdAliasJob.id);

  const wrapped = await tool.execute("wrapped-leaves", {
    label: "wrapped leaves",
    condition: {
      op: "or",
      children: [
        { file: { path: "wrapped-ready.json", exists: true }, every: "5s" },
        { file: "string-file.log", contains: "READY" },
        { process: { pidFile: "wrapped.pid", status: "exited" } },
        { port: 9, host: "127.0.0.1" },
      ],
    },
    resume: "wrapped leaves resume",
  }, new AbortController().signal, () => {}, harness.ctx);
  const wrappedJob = wrapped.details.job;
  allJobIds.push(wrappedJob.id);
  const [fileLeaf, fileStringLeaf, processLeaf, portLeaf] = wrappedJob.condition.children;
  if (fileLeaf.type !== "file" || fileLeaf.path !== "wrapped-ready.json" || fileLeaf.every !== "5s") throw new Error(`file wrapper was not normalized: ${JSON.stringify(fileLeaf)}`);
  if (fileStringLeaf.type !== "file" || fileStringLeaf.path !== "string-file.log" || fileStringLeaf.contains !== "READY") throw new Error(`file string shorthand was not normalized: ${JSON.stringify(fileStringLeaf)}`);
  if (processLeaf.type !== "process" || processLeaf.pidFile !== "wrapped.pid" || processLeaf.state !== "exited") throw new Error(`process wrapper/status was not normalized: ${JSON.stringify(processLeaf)}`);
  if (portLeaf.type !== "port" || portLeaf.port !== 9 || portLeaf.host !== "127.0.0.1") throw new Error(`port shorthand was not normalized: ${JSON.stringify(portLeaf)}`);
  await harness.cancel(wrappedJob.id);
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

async function testIncomingWebhookServerStartupFailure(harness: Harness) {
  const label = "failed incoming webhook startup";
  const webhookPort = Number(process.env.PI_RETURN_ON_WEBHOOK_PORT);
  if (!Number.isInteger(webhookPort) || webhookPort <= 0) throw new Error(`invalid smoke webhook port: ${process.env.PI_RETURN_ON_WEBHOOK_PORT}`);
  const jobsPath = path.join(stateDir, "jobs.json");
  const beforeJobs = await fs.readFile(jobsPath, "utf8").then((text) => JSON.parse(text).jobs as any[], () => []);
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(webhookPort, "127.0.0.1", () => resolve());
  });
  try {
    let rejected = false;
    try {
      await harness.callTool("return_on", {
        label,
        condition: { type: "webhook" },
        resume: "should not persist",
      });
    } catch (error) {
      rejected = /EADDRINUSE|listen/i.test(String(error));
    }
    if (!rejected) throw new Error("incoming webhook registration did not fail when the webhook server port was occupied");
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
  const afterJobs = await fs.readFile(jobsPath, "utf8").then((text) => JSON.parse(text).jobs as any[], () => []);
  if (afterJobs.length !== beforeJobs.length || afterJobs.some((job) => job.label === label)) {
    throw new Error(`failed incoming webhook registration persisted a job: before=${beforeJobs.length} after=${afterJobs.length}`);
  }
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
  const wake = await waitForWake(harness, { jobId, label, resume }, 1_500);
  const latch = wake.message?.details?.latches?.root;
  const matchedLines = latch?.details?.matchedLines;
  if (!Array.isArray(matchedLines) || matchedLines[0]?.text !== "EVENT_READY" || matchedLines[0]?.line !== 2) {
    throw new Error(`file marker latch did not include matched line details: ${JSON.stringify(latch)}`);
  }
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

async function testProcessPidFile(harness: Harness) {
  const label = "smoke process pidFile";
  const resume = "process pidFile resume";
  const child = spawn("sleep", ["3"], { stdio: "ignore" });
  const pidFile = path.join(cwd, "pidfile.pid");
  await fs.writeFile(pidFile, `${child.pid}\n`, "utf8");
  const jobId = await harness.register({
    label,
    condition: { type: "process", pidFile: "pidfile.pid", exited: true, every: "500ms" },
    resume,
  });
  await expectNoWake(harness, jobId, 1_500, "pidFile watcher fired while process was alive");
  await waitForWake(harness, { jobId, label, resume }, 6_000);

  const missingLabel = "smoke process pidFile missing";
  const missingResume = "process pidFile missing resume";
  const missingJobId = await harness.register({
    label: missingLabel,
    condition: { type: "process", pidFile: "absent.pid", exited: true, every: "500ms" },
    resume: missingResume,
  });
  await waitForWake(harness, { jobId: missingJobId, label: missingLabel, resume: missingResume }, 4_000);
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

async function testMaxFiresTimerOnlyRejected(harness: Harness) {
  const cases: Array<{ label: string; condition: any }> = [
    { label: "timer leaf", condition: { type: "timer", after: "500ms" } },
    { label: "all of timers", condition: { all: [ { type: "timer", after: "500ms" }, { type: "timer", after: "1s" } ] } },
  ];
  for (const { label, condition } of cases) {
    let message = "";
    try {
      await harness.register({ label: `smoke maxFires timer-only ${label}`, condition, resume: "should reject", maxFires: 3 } as any);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!/maxFires > 1 requires a re-armable condition/.test(message)) {
      throw new Error(`${label}: timer-only maxFires was not rejected: ${message}`);
    }
  }
}

async function testMaxFiresMulti(harness: Harness) {
  const label = "smoke maxFires multi";
  const resume = "multi fire resume";
  const file = path.join(cwd, "multi-fire.flag");
  try { await fs.unlink(file); } catch {}
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "multi-fire.flag", exists: true, every: "100ms" },
    resume,
    maxFires: 3,
  });
  await expectNoWake(harness, jobId, 800, "multi-fire fired before file appeared");
  for (let i = 0; i < 3; i++) {
    await fs.writeFile(file, `present-${i}`, "utf8");
    await waitForWakeCount(harness, { jobId, label, resume }, i + 1, 4_000);
    await fs.unlink(file);
    // wait long enough for the tick (1s) to observe false and clear rearmPending
    await sleep(1_500);
  }
  // After maxFires=3 the job should be retired: writing the file again must not produce a 4th wake.
  await fs.writeFile(file, "extra", "utf8");
  await sleep(2_500);
  await fs.unlink(file).catch(() => {});
  const entries = wakeEntries(harness, jobId);
  if (entries.length !== 3) throw new Error(`expected exactly 3 wakes after maxFires=3, saw ${entries.length}`);
}

async function testMaxFiresEdgeTriggered(harness: Harness) {
  const label = "smoke maxFires edge";
  const resume = "edge resume";
  const file = path.join(cwd, "edge-fire.flag");
  await fs.writeFile(file, "present", "utf8");
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "edge-fire.flag", exists: true, every: "100ms" },
    resume,
    maxFires: 5,
  });
  // First wake should arrive; without an edge transition no further wakes should follow.
  await waitForWakeCount(harness, { jobId, label, resume }, 1, 4_000);
  await sleep(2_500);
  await fs.unlink(file).catch(() => {});
  const entries = wakeEntries(harness, jobId);
  if (entries.length !== 1) throw new Error(`edge-triggered watcher produced ${entries.length} wakes, expected 1`);
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

async function testConditionShapeErrors(harness: Harness) {
  const cases: Array<{ label: string; condition: unknown; match: RegExp }> = [
    {
      label: "ambiguous multiple wrapper leaves",
      condition: { file: { path: "/x", exists: true }, process: { pidFile: "job.pid" } },
      match: /multiple leaf wrappers: file, process/,
    },
    {
      label: "missing type with present keys",
      condition: { path: "/x", exists: true },
      match: /no 'type' field \(got keys: path, exists\)/,
    },
    {
      label: "non-JSON string",
      condition: "not-an-object",
      match: /condition must be an object/,
    },
    {
      label: "invalid JSON string",
      condition: "{not json}",
      match: /condition was a string but not valid JSON/,
    },
  ];
  for (const { label, condition, match } of cases) {
    let message = "";
    try {
      await harness.register({ label, condition: condition as any, resume: "should reject" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!message) throw new Error(`${label} was not rejected`);
    if (!match.test(message)) throw new Error(`${label} error message did not match ${match}: ${message}`);
  }
}

async function testConditionJsonString(harness: Harness) {
  const label = "smoke condition json string";
  const resume = "json string resume";
  const jobId = await harness.register({
    label,
    condition: JSON.stringify({ type: "timer", after: "500ms" }) as any,
    resume,
  });
  await waitForWake(harness, { jobId, label, resume }, 3_000);
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

async function waitForCheckIn(harness: Harness, jobId: string, expectedCount: number, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entries = checkInEntries(harness, jobId);
    if (entries.length >= expectedCount) return entries;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${expectedCount} check-ins of ${jobId}, saw ${checkInEntries(harness, jobId).length}`);
}

async function testCheckInStartupClearsPendingWake() {
  const harness = createHarness("checkin-startup-clear-session");
  await harness.emit("session_start");
  const label = "smoke startup clear check-in";
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "never-startup-clear-check-in.txt", exists: true, every: "100ms" },
    timeout: "5s",
    checkInEvery: "1s",
    resume: "startup clear check-in resume",
  });
  await waitForCheckIn(harness, jobId, 1, 1_800);
  await sleep(1_400);
  if (checkInEntries(harness, jobId).length !== 1) throw new Error("pending check-in wake was queued more than once before startup cleanup");
  const jobsPath = path.join(stateDir, "jobs.json");
  const state = JSON.parse(await fs.readFile(jobsPath, "utf8"));
  const currentJob = state.jobs.find((job: any) => job.id === jobId);
  const otherJobId = `${jobId}_other`;
  state.jobs.push({ ...currentJob, id: otherJobId, label: "other session pending check-in", sessionFile: path.join(cwd, "other-session.jsonl"), checkInWakePending: true });
  await fs.writeFile(jobsPath, JSON.stringify(state, null, 2), "utf8");
  await harness.emit("session_start");
  const afterStartup = JSON.parse(await fs.readFile(jobsPath, "utf8"));
  const otherJob = afterStartup.jobs.find((job: any) => job.id === otherJobId);
  if (otherJob?.checkInWakePending !== true) throw new Error("startup cleanup cleared pending check-in for another session");
  await waitForCheckIn(harness, jobId, 2, 2_000);
  await harness.cancel(jobId);
  await harness.emit("session_shutdown");
}

async function testCheckInSkipsBusyParent() {
  let pending = true;
  const harness = createHarness("checkin-busy-session", { hasPendingMessages: () => pending });
  await harness.emit("session_start");
  const label = "smoke busy check-in";
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "never-busy-check-in.txt", exists: true, every: "100ms" },
    timeout: "5s",
    checkInEvery: "1s",
    resume: "busy check-in resume",
  });
  await expectNoWake(harness, jobId, 1_700, "busy parent should not queue periodic check-ins");
  pending = false;
  await waitForCheckIn(harness, jobId, 1, 2_000);
  await harness.cancel(jobId);
  await harness.emit("session_shutdown");
}

async function testCheckInSkipsBeforeAgentStartTurn() {
  const harness = createHarness("checkin-before-start-session");
  await harness.emit("session_start");
  await harness.beforeAgentStart();
  const label = "smoke before-start check-in";
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "never-before-start-check-in.txt", exists: true, every: "100ms" },
    timeout: "5s",
    checkInEvery: "1s",
    resume: "before-start check-in resume",
  });
  await expectNoWake(harness, jobId, 1_700, "before_agent_start turn should not queue periodic check-ins");
  await harness.emit("agent_end");
  await waitForCheckIn(harness, jobId, 1, 2_000);
  await harness.cancel(jobId);
  await harness.emit("session_shutdown");
}

async function testCheckInSkipsActiveSignal() {
  const controller = new AbortController();
  let signal: AbortSignal | undefined = controller.signal;
  const harness = createHarness("checkin-active-signal-session", { signal: () => signal });
  await harness.emit("session_start");
  const label = "smoke active-signal check-in";
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "never-active-signal-check-in.txt", exists: true, every: "100ms" },
    timeout: "5s",
    checkInEvery: "1s",
    resume: "active-signal check-in resume",
  });
  await expectNoWake(harness, jobId, 1_700, "active agent signal should not queue periodic check-ins");
  signal = undefined;
  await waitForCheckIn(harness, jobId, 1, 2_000);
  await harness.cancel(jobId);
  await harness.emit("session_shutdown");
}

async function testCheckInSkipsActiveAgentTurn() {
  const harness = createHarness("checkin-active-turn-session");
  await harness.emit("session_start");
  await harness.emit("agent_start");
  const label = "smoke active-turn check-in";
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "never-active-turn-check-in.txt", exists: true, every: "100ms" },
    timeout: "5s",
    checkInEvery: "1s",
    resume: "active-turn check-in resume",
  });
  await expectNoWake(harness, jobId, 1_700, "active agent turn should not queue periodic check-ins");
  await harness.emit("agent_end");
  await waitForCheckIn(harness, jobId, 1, 2_000);
  await harness.cancel(jobId);
  await harness.emit("session_shutdown");
}

async function testCheckInEvery(harness: Harness) {
  const label = "smoke check-in";
  const resume = "check-in resume";
  const result = await harness.callTool("return_on", {
    label,
    condition: { type: "file", path: "never-check-in.txt", exists: true, every: "100ms" },
    timeout: "3500ms",
    checkInEvery: "1s",
    resume,
  });
  const jobId = result.details.job.id as string;
  allJobIds.push(jobId);
  const receipt = String(result.content?.[0]?.text ?? "");
  if (!receipt.includes("Check-ins: every 1s")) throw new Error(`registration did not display check-in cadence: ${receipt}`);

  const checkIns = await waitForCheckIn(harness, jobId, 1, 2_800);
  if (checkIns[0].options?.deliverAs !== "followUp" || checkIns[0].options?.triggerTurn !== true) {
    throw new Error(`check-in wake was not queued as followUp: ${JSON.stringify(checkIns[0].options)}`);
  }
  const checkInText = String(checkIns[0].message?.content ?? "");
  if (!checkInText.includes("return_on check-in") || !checkInText.includes("Still waiting") || !checkInText.includes(resume)) {
    throw new Error(`check-in wake content was incomplete: ${checkInText}`);
  }
  if (finalWakeEntries(harness, jobId).length !== 0) throw new Error("check-in incorrectly fired the watcher");

  const entry = await waitForWake(harness, { jobId, label, resume }, 4_000);
  if (!String(entry.message.content).includes("Reason: timeout")) throw new Error("check-in watcher did not eventually timeout");
  if (checkInEntries(harness, jobId).length < 1) throw new Error("check-in entry disappeared after timeout");
  await harness.emit("agent_end");

  let rejected: string | undefined;
  try {
    await harness.callTool("return_on", {
      label: "bad check-in",
      condition: { type: "timer", after: "1s" },
      timeout: "2s",
      checkInEvery: "500ms",
      resume: "should reject",
    });
  } catch (error) {
    rejected = String(error);
  }
  if (!rejected || !rejected.includes("checkInEvery must be at least 1s")) throw new Error(`short check-in interval was not rejected: ${rejected ?? "accepted"}`);
}

async function testDefaultMaxTimeoutIsTwoHours(harness: Harness) {
  let rejected: string | undefined;
  try {
    await harness.callTool("return_on", {
      label: "smoke 3h over default cap",
      condition: { type: "timer", after: "3h" },
      timeout: "3h",
      resume: "should reject",
    });
  } catch (error) {
    rejected = String(error);
  }
  if (!rejected || !/exceeds max 2h/i.test(rejected)) {
    throw new Error(`default max timeout no longer 2h: ${rejected ?? "accepted"}`);
  }
  const ok = await harness.callTool("return_on", {
    label: "smoke 90m within default cap",
    condition: { type: "file", path: "never-90m-default-cap.txt", exists: true, every: "500ms" },
    timeout: "90m",
    resume: "90m default cap resume",
  });
  const jobId = ok.details.job.id as string;
  allJobIds.push(jobId);
  await harness.cancel(jobId);
}

async function testDefaultTimeoutAndMax(harness: Harness) {
  await withProjectSettings({ returnOn: { defaultTimeout: "700ms", maxTimeout: "1s" } }, async () => {
    const label = "smoke default timeout";
    const resume = "default timeout resume";
    const result = await harness.callTool("return_on", {
      label,
      condition: { type: "file", path: "never-default-timeout.txt", exists: true, every: "100ms" },
      resume,
    });
    const jobId = result.details.job.id as string;
    allJobIds.push(jobId);
    if (typeof result.details.job.timeoutAt !== "number") throw new Error("default timeout did not set timeoutAt");
    if (!String(result.content?.[0]?.text ?? "").includes("Timeout: in 700ms")) throw new Error("registration did not display effective default timeout");
    const entry = await waitForWake(harness, { jobId, label, resume }, 2_500);
    if (!String(entry.message.content).includes("Reason: timeout")) throw new Error("default timeout wake did not include timeout reason");

    const jobsPath = path.join(stateDir, "jobs.json");
    const beforeJobs = await fs.readFile(jobsPath, "utf8").then((text) => JSON.parse(text).jobs as any[], () => []);
    let rejected = false;
    try {
      await harness.callTool("return_on", {
        label: "too long timeout",
        condition: { type: "timer", after: "10s" },
        timeout: "2s",
        resume: "should reject",
      });
    } catch (error) {
      rejected = /exceeds max/i.test(String(error));
    }
    if (!rejected) throw new Error("return_on accepted a timeout above configured max");
    const afterJobs = await fs.readFile(jobsPath, "utf8").then((text) => JSON.parse(text).jobs as any[], () => []);
    if (afterJobs.length !== beforeJobs.length || afterJobs.some((job) => job.label === "too long timeout")) {
      throw new Error("rejected over-max timeout persisted a job");
    }
  });
}

async function testDefaultDeliverySettings(harness: Harness) {
  await withEnv({ PI_RETURN_ON_DELIVERY_MODE: undefined, PI_RETURN_ON_DELIVERY_NOTIFY: undefined, PI_RETURN_ON_TRIGGER_PARENT_ON_SUMMARY: undefined }, async () => {
    const explicitForkResult = await harness.callTool("return_on", {
      label: "smoke explicit fork default notify",
      condition: { type: "timer", after: "1h" },
      timeout: "5s",
      delivery: { mode: "fork" },
      resume: "explicit fork default notify resume",
    });
    const explicitForkJob = explicitForkResult.details.job;
    allJobIds.push(explicitForkJob.id as string);
    if (explicitForkJob.delivery?.mode !== "fork" || explicitForkJob.delivery?.notify !== "summary" || explicitForkJob.delivery?.triggerParentOnSummary !== true) {
      throw new Error(`explicit fork delivery did not default to summary with parent wake: ${JSON.stringify(explicitForkJob.delivery)}`);
    }
    await harness.cancel(explicitForkJob.id as string);

    await withUserAgentSettings({ returnOn: { defaultDeliveryMode: "fork", defaultDeliveryNotify: "none", triggerParentOnSummary: true } }, async () => {
      const result = await harness.callTool("return_on", {
        label: "smoke isolated agent dir fork delivery",
        condition: { type: "timer", after: "1h" },
        timeout: "5s",
        resume: "isolated agent dir fork delivery resume",
      });
      const job = result.details.job;
      allJobIds.push(job.id as string);
      if (job.delivery?.mode !== "fork" || job.delivery?.notify !== "none" || job.delivery?.triggerParentOnSummary !== true) {
        throw new Error(`PI_CODING_AGENT_DIR settings default delivery was not applied: ${JSON.stringify(job.delivery)}`);
      }
      await harness.cancel(job.id as string);
    });

    await withTildeUserAgentSettings({ returnOn: { defaultDeliveryMode: "fork", defaultDeliveryNotify: "none", triggerParentOnSummary: true } }, async () => {
      const result = await harness.callTool("return_on", {
        label: "smoke tilde agent dir fork delivery",
        condition: { type: "timer", after: "1h" },
        timeout: "5s",
        resume: "tilde agent dir fork delivery resume",
      });
      const job = result.details.job;
      allJobIds.push(job.id as string);
      if (job.delivery?.mode !== "fork" || job.delivery?.notify !== "none" || job.delivery?.triggerParentOnSummary !== true) {
        throw new Error(`PI_CODING_AGENT_DIR tilde settings default delivery was not applied: ${JSON.stringify(job.delivery)}`);
      }
      await harness.cancel(job.id as string);
    });

    await withProjectSettings({ returnOn: { defaultDeliveryMode: "fork", defaultDeliveryNotify: "summary", triggerParentOnSummary: true } }, async () => {
      const result = await harness.callTool("return_on", {
        label: "smoke default fork delivery",
        condition: { type: "timer", after: "1h" },
        timeout: "5s",
        resume: "default fork delivery resume",
      });
      const job = result.details.job;
      allJobIds.push(job.id as string);
      if (job.delivery?.mode !== "fork" || job.delivery?.notify !== "summary" || job.delivery?.triggerParentOnSummary !== true) {
        throw new Error(`settings default delivery was not applied: ${JSON.stringify(job.delivery)}`);
      }
      await harness.cancel(job.id as string);
    });
  });
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
  if (!statusAfterActive.includes("⏰") || !statusAfterActive.includes("1") || !statusAfterActive.includes("Ctrl+Alt+W") || statusAfterActive.includes("list active")) {
    throw new Error(`status tag did not show compact active wait count and shortcut: ${statusAfterActive}`);
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

  const statusTool = harness.tools.get("return_on_status");
  if (!statusTool) throw new Error("missing return_on_status tool");
  const status = await statusTool.execute("status", { id: cancelId }, new AbortController().signal, () => {}, harness.ctx);
  const statusText = String(status.content?.[0]?.text ?? "");
  if (!statusText.includes(cancelId) || !statusText.includes("Condition tree:") || !statusText.includes("Leaf checks:")) {
    throw new Error(`return_on_status tool did not return rich job details: ${statusText}`);
  }

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
  await second.commands.get("return-on-fired-events")?.handler("delivered 5", second.ctx);
  const firedNotification = second.notifications.at(-1)?.message ?? "";
  if (!firedNotification.includes(jobId) || !firedNotification.includes("wake-sent")) {
    throw new Error(`return-on-fired-events command did not show delivered event: ${firedNotification}`);
  }
  const firedTool = second.tools.get("return_on_fired_events");
  if (!firedTool) throw new Error("missing return_on_fired_events tool");
  const firedResult = await firedTool.execute("fired", { status: "delivered", limit: 5 }, new AbortController().signal, () => {}, second.ctx);
  const firedText = String(firedResult.content?.[0]?.text ?? "");
  if (!firedText.includes(jobId) || !firedText.includes("wake-sent")) {
    throw new Error(`return_on_fired_events tool did not show delivered event: ${firedText}`);
  }
  await second.emit("session_shutdown");
}

async function testRetentionPrune() {
  const harness = createHarness("retention-prune");
  await harness.emit("session_start");
  const now = Date.now();
  const old = now - 40 * 86_400_000;
  const recent = now - 60_000;
  const activeJob = { id: "prune_active", label: "active", cwd, sessionFile: harness.sessionFile, createdAt: old, updatedAt: old, status: "active", condition: { type: "timer", after: "1h" }, resume: "active resume", latches: {}, leafState: {} };
  const oldCancelled = { id: "prune_old_cancelled", label: "old cancelled", cwd, sessionFile: harness.sessionFile, createdAt: old, updatedAt: old, status: "cancelled", condition: { type: "timer", after: "1h" }, resume: "old resume", cancelledAt: old, latches: {}, leafState: {} };
  const recentFired = { id: "prune_recent_fired", label: "recent fired", cwd, sessionFile: harness.sessionFile, createdAt: recent, updatedAt: recent, status: "fired", condition: { type: "timer", after: "1h" }, resume: "recent resume", firedAt: recent, latches: {}, leafState: {} };
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, "jobs.json"), JSON.stringify({ version: 1, jobs: [activeJob, oldCancelled, recentFired] }, null, 2), "utf8");

  const firedDir = path.join(stateDir, "fired");
  await fs.mkdir(firedDir, { recursive: true });
  const eventFor = (id: string, deliveryStatus: string, firedAt: number, deliveredAt?: number) => ({
    version: 1,
    event: "return_on.fired",
    id,
    jobId: id,
    label: id,
    reason: "test",
    createdAt: firedAt,
    firedAt,
    cwd,
    sessionFile: harness.sessionFile,
    resume: "resume",
    job: { ...recentFired, id, label: id, firedAt, updatedAt: firedAt },
    deliveryStatus,
    ...(deliveredAt ? { deliveredAt } : {}),
  });
  await fs.writeFile(path.join(firedDir, "old-delivered.json"), JSON.stringify(eventFor("old-delivered", "wake-sent", old, old), null, 2), "utf8");
  await fs.writeFile(path.join(firedDir, "recent-delivered.json"), JSON.stringify(eventFor("recent-delivered", "wake-sent", recent, recent), null, 2), "utf8");
  await fs.writeFile(path.join(firedDir, "old-pending.json"), JSON.stringify(eventFor("old-pending", "pending", old), null, 2), "utf8");
  await fs.writeFile(path.join(firedDir, "old-failed.json"), JSON.stringify(eventFor("old-failed", "failed", old, old), null, 2), "utf8");

  const handlersDir = path.join(stateDir, "handlers");
  const oldHandlerDir = path.join(handlersDir, "old-handler");
  const runningHandlerDir = path.join(handlersDir, "running-handler");
  const unsafeHandlerDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-return-on-unsafe-handler-"));
  await fs.mkdir(oldHandlerDir, { recursive: true });
  await fs.mkdir(runningHandlerDir, { recursive: true });
  await fs.writeFile(path.join(oldHandlerDir, "stdout.log"), "old", "utf8");
  await fs.writeFile(path.join(unsafeHandlerDir, "sentinel"), "do not remove", "utf8");
  const handlerBase = { jobId: "job", label: "handler", cwd, parentSessionFile: harness.sessionFile, pid: 123, eventPath: "event.json", promptPath: "prompt.md", stdoutPath: "stdout.log", stderrPath: "stderr.log", sessionDir: "session" };
  await fs.writeFile(path.join(stateDir, "handlers.json"), JSON.stringify({ version: 1, handlers: [
    { ...handlerBase, id: "old-handler", status: "complete", startedAt: old, endedAt: old, dir: oldHandlerDir },
    { ...handlerBase, id: "unsafe-handler", status: "complete", startedAt: old, endedAt: old, dir: unsafeHandlerDir },
    { ...handlerBase, id: "running-handler", status: "running", startedAt: old, dir: runningHandlerDir },
  ] }, null, 2), "utf8");

  const auditPath = path.join(stateDir, "direct-wait-audit.jsonl");
  const auditEntry = (timestamp: number, command: string) => JSON.stringify({ version: 1, event: "direct_wait", timestamp, cwd, sessionFile: harness.sessionFile, toolName: "bash", command, thresholdMs: 10_000, action: "blocked", kind: "long sleep", detail: command });
  await fs.writeFile(auditPath, [auditEntry(old, "sleep 10"), auditEntry(old, "sleep 11"), auditEntry(recent, "sleep 12"), auditEntry(recent + 1, "sleep 13"), auditEntry(recent + 2, "sleep 14")].join("\n") + "\n", "utf8");

  await harness.runCommand("return-on-prune", "--days=1junk");
  const invalidText = harness.notifications.at(-1)?.message ?? "";
  if (!invalidText.includes("--days must be a non-negative number")) throw new Error(`invalid prune arg did not warn: ${invalidText}`);
  await harness.runCommand("return-on-prune", "dry-run --days=1 --audit-max=2");
  const dryRunText = harness.notifications.at(-1)?.message ?? "";
  if (!dryRunText.includes("dry run") || !dryRunText.includes("Jobs pruned: 1") || !dryRunText.includes("Fired events pruned: 1") || !dryRunText.includes("Handlers pruned: 2; handler dirs pruned: 1")) {
    throw new Error(`prune dry-run summary was wrong: ${dryRunText}`);
  }
  if (!(await fs.stat(path.join(firedDir, "old-delivered.json")).then(() => true, () => false))) throw new Error("dry-run removed old fired event");

  const pruneTool = harness.tools.get("return_on_prune");
  if (!pruneTool) throw new Error("missing return_on_prune tool");
  const result = await pruneTool.execute("prune", { retentionDays: 1, auditMaxEntries: 2 }, new AbortController().signal, () => {}, harness.ctx);
  const text = String(result.content?.[0]?.text ?? "");
  if (!text.includes("prune complete") || !text.includes("Jobs pruned: 1") || !text.includes("Fired events pruned: 1") || !text.includes("Handlers pruned: 2; handler dirs pruned: 1") || !text.includes("Direct-wait audit entries pruned: 3")) {
    throw new Error(`prune summary was wrong: ${text}`);
  }
  const jobsState = JSON.parse(await fs.readFile(path.join(stateDir, "jobs.json"), "utf8"));
  if (jobsState.jobs.some((job: any) => job.id === "prune_old_cancelled") || !jobsState.jobs.some((job: any) => job.id === "prune_active")) {
    throw new Error(`prune kept/removed wrong jobs: ${JSON.stringify(jobsState)}`);
  }
  if (await fs.stat(path.join(firedDir, "old-delivered.json")).then(() => true, () => false)) throw new Error("old delivered fired event was not pruned");
  for (const name of ["recent-delivered.json", "old-pending.json", "old-failed.json"]) {
    if (!(await fs.stat(path.join(firedDir, name)).then(() => true, () => false))) throw new Error(`prune removed protected fired event ${name}`);
  }
  if (await fs.stat(oldHandlerDir).then(() => true, () => false)) throw new Error("old handler dir was not pruned");
  if (!(await fs.stat(path.join(unsafeHandlerDir, "sentinel")).then(() => true, () => false))) throw new Error("unsafe handler dir outside state was pruned");
  if (!(await fs.stat(runningHandlerDir).then(() => true, () => false))) throw new Error("running handler dir was pruned");
  const auditLines = (await fs.readFile(auditPath, "utf8")).trim().split("\n");
  if (auditLines.length !== 2 || !auditLines[0].includes("sleep 13") || !auditLines[1].includes("sleep 14")) throw new Error(`audit prune kept wrong lines: ${auditLines.join(" | ")}`);
  await harness.emit("session_shutdown");
}

async function testHandlerStartupReconciliation() {
  const session = createHarness("handler-reconcile");
  const now = Date.now();
  const jobId = "reconcile_job";
  const runId = "reconcile_handler";
  const label = "reconcile handler label";
  const resume = "reconcile handler resume";
  const dir = path.join(stateDir, "handlers", runId);
  const stdoutPath = path.join(dir, "stdout.log");
  const stderrPath = path.join(dir, "stderr.log");
  const job = {
    id: jobId,
    label,
    cwd,
    sessionFile: session.sessionFile,
    createdAt: now,
    updatedAt: now,
    status: "fired",
    condition: { type: "timer", after: "1ms" },
    resume,
    firedAt: now,
    delivery: { mode: "fork", notify: "summary", triggerParentOnSummary: true },
    latches: {},
    leafState: {},
  };
  const run = {
    id: runId,
    jobId,
    label,
    cwd,
    parentSessionFile: session.sessionFile,
    status: "running",
    pid: 999_999_999,
    startedAt: now - 1_000,
    dir,
    eventPath: path.join(dir, "event.json"),
    promptPath: path.join(dir, "prompt.md"),
    stdoutPath,
    stderrPath,
    sessionDir: path.join(dir, "sessions"),
    notify: "summary",
    triggerParentOnSummary: true,
  };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(stdoutPath, "recovered handler summary\n", "utf8");
  await fs.writeFile(stderrPath, "", "utf8");
  await fs.writeFile(path.join(stateDir, "jobs.json"), JSON.stringify({ version: 1, jobs: [job] }, null, 2), "utf8");
  await fs.writeFile(path.join(stateDir, "handlers.json"), JSON.stringify({ version: 1, handlers: [run] }, null, 2), "utf8");

  await session.emit("session_start");
  const summary = session.messages.find((entry) => entry.message?.customType === "return-on-handler" && entry.message?.details?.handlerRunId === runId);
  if (!summary) throw new Error("startup reconciliation did not emit missed handler summary");
  if (summary.options?.triggerTurn !== true || summary.message?.details?.status !== "complete" || summary.message?.details?.reconciled !== true) {
    throw new Error(`reconciled summary metadata was wrong: ${JSON.stringify(summary)}`);
  }
  if (!String(summary.message?.content ?? "").includes("recovered handler summary")) {
    throw new Error(`reconciled summary missed stdout: ${summary.message?.content}`);
  }
  const saved = JSON.parse(await fs.readFile(path.join(stateDir, "handlers.json"), "utf8"));
  const savedRun = saved.handlers.find((candidate: any) => candidate.id === runId);
  if (savedRun?.status !== "complete" || !savedRun.endedAt || savedRun.exitCode !== null) {
    throw new Error(`handler run was not reconciled in ledger: ${JSON.stringify(savedRun)}`);
  }
  await session.emit("session_shutdown");
}

async function testFailedFiredEventRetries() {
  const jobId = "pending_retry_job";
  const label = "pending retry label";
  const resume = "pending retry resume";
  const session = createHarness("pending-retry");
  const now = Date.now();
  const job = { id: jobId, label, cwd, sessionFile: session.sessionFile, createdAt: now, updatedAt: now, status: "fired", condition: { type: "timer", after: "1ms" }, resume, firedAt: now, latches: {}, leafState: {} };
  await fs.mkdir(path.join(stateDir, "fired"), { recursive: true });
  await fs.writeFile(path.join(stateDir, "jobs.json"), JSON.stringify({ version: 1, jobs: [job] }, null, 2), "utf8");
  const firedPath = path.join(stateDir, "fired", `${jobId}.json`);
  await fs.writeFile(firedPath, JSON.stringify({
    version: 1,
    event: "return_on.fired",
    id: jobId,
    jobId,
    label,
    reason: "retry test",
    createdAt: now,
    firedAt: now,
    cwd,
    sessionFile: session.sessionFile,
    resume,
    job,
    deliveryStatus: "pending",
  }, null, 2), "utf8");

  const failing = createHarness("pending-retry", { failSendMessage: true });
  await failing.emit("session_start");
  const failed = JSON.parse(await fs.readFile(firedPath, "utf8"));
  if (failed.deliveryStatus !== "failed" || failed.deliveredAt || !failed.lastAttemptAt || !String(failed.error ?? "").includes("simulated sendMessage failure")) {
    throw new Error(`failed fired event was not left retryable: ${JSON.stringify(failed)}`);
  }
  await failing.emit("session_shutdown");

  const retrying = createHarness("pending-retry");
  await retrying.emit("session_start");
  const entries = wakeEntries(retrying, jobId);
  if (entries.length !== 1) throw new Error(`failed fired event did not retry exactly once: ${entries.length}`);
  assertWake(entries[0], { jobId, label, resume });
  const delivered = JSON.parse(await fs.readFile(firedPath, "utf8"));
  if (delivered.deliveryStatus !== "wake-sent" || !delivered.deliveredAt) {
    throw new Error(`retried fired event was not marked delivered: ${JSON.stringify(delivered)}`);
  }
  await retrying.emit("session_shutdown");
}

async function testStatusCancelSessionIsolation() {
  const sessionA = createHarness("status-cancel-a");
  await sessionA.emit("session_start");
  const statusJob = await sessionA.register({ label: "private status", condition: { type: "timer", after: "1h" }, resume: "private status resume" });
  const cancelJob = await sessionA.register({ label: "private cancel", condition: { type: "timer", after: "1h" }, resume: "private cancel resume" });
  await sessionA.emit("session_shutdown");

  const sessionB = createHarness("status-cancel-b");
  await sessionB.emit("session_start");
  await sessionB.runCommand("return-on-status", statusJob);
  const statusText = sessionB.notifications.at(-1)?.message ?? "";
  if (!statusText.includes("No return_on job found") || statusText.includes("private status resume")) {
    throw new Error(`cross-session status command leaked job details: ${statusText}`);
  }
  await sessionB.runCommand("return-on-cancel", cancelJob);
  const cancelText = sessionB.notifications.at(-1)?.message ?? "";
  if (!cancelText.includes("No return_on job found")) throw new Error(`cross-session cancel command unexpectedly found job: ${cancelText}`);
  try {
    await sessionB.callTool("return_on_cancel", { id: cancelJob });
    throw new Error("cross-session cancel tool unexpectedly succeeded");
  } catch (error) {
    if (!String(error).includes("No return_on job found")) throw error;
  }
  await sessionB.emit("session_shutdown");

  const sessionAAgain = createHarness("status-cancel-a");
  await sessionAAgain.emit("session_start");
  const result = await sessionAAgain.callTool("return_on_status", { id: cancelJob });
  const text = String(result.content?.[0]?.text ?? "");
  if (!text.includes("private cancel") || text.includes("[cancelled]")) throw new Error(`owner session could not see uncancelled job: ${text}`);
  await sessionAAgain.cancel(statusJob);
  await sessionAAgain.cancel(cancelJob);
  await sessionAAgain.emit("session_shutdown");
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
await testRegisterWithoutEndingTurn(harness);
await testDuplicateWatcherRegistrationDedupes(harness);
await testForkDelivery(harness);
await testForkDeliverySkipsEmptyParentSession(harness);
await testDefaultPiCommandFallsBackToHomeBin(harness);
await testAutoDeliveryWakesIdleParent(harness);
const busyHarness = createHarness("busy-session", { isIdle: () => false });
await busyHarness.emit("session_start");
await testAutoDeliveryForksBusyParent(busyHarness);
await busyHarness.emit("session_shutdown");
await testEmptyForkHandlerSummaryFallback(harness);
await testCancelledForkHandlerSuppressesSummary(harness);
await testForkLaunchFailureFallsBackToWake(harness);
await testAgentArtifactForkDelivery(harness);
await testIncomingWebhookServerStartupFailure(harness);
await testIncomingWebhookWake(harness);
await testWebhookOnFire(harness);
await testLogContains(harness);
await testFileWatchImmediate(harness);
await testFileStable(harness);
await testProcessGone(harness);
await testProcessPidFile(harness);
await testPortOpen(harness);
await testUrlReady(harness);
await testFileExistsFalse(harness);
await testMaxFiresMulti(harness);
await testMaxFiresEdgeTriggered(harness);
await testMaxFiresTimerOnlyRejected(harness);
await testNotConditionAfterDelete(harness);
await testNotExecAfterDelete(harness);
await testEmptyGroupRejected(harness);
await testConditionShapeErrors(harness);
await testConditionJsonString(harness);
await testBooleanTree(harness);
await testCancelBeforeFire(harness);
await testTimeoutWake(harness);
await testCheckInEvery(harness);
await testCheckInStartupClearsPendingWake();
await testCheckInSkipsBusyParent();
await testCheckInSkipsBeforeAgentStartTurn();
await testCheckInSkipsActiveSignal();
await testCheckInSkipsActiveAgentTurn();
await testDefaultMaxTimeoutIsTwoHours(harness);
await testDefaultTimeoutAndMax(harness);
await testDefaultDeliverySettings(harness);
await harness.emit("session_shutdown");
await testExecConfirmationAndValidation();
await testListToolAndCommands();
await testRestartResume();
await testPendingFiredEventDelivery();
await testHandlerStartupReconciliation();
await testFailedFiredEventRetries();
await testSessionIsolation();
await testStatusCancelSessionIsolation();
await testRetentionPrune();

const duplicateIds = allJobIds.filter((id, index) => allJobIds.indexOf(id) !== index);
if (duplicateIds.length > 0) throw new Error(`duplicate job ids: ${duplicateIds.join(", ")}`);

console.log(`smoke ok: ${allJobIds.length} jobs tested, cwd=${cwd}, home=${process.env.HOME}`);
