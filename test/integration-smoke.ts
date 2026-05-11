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

function createHarness(sessionName: string) {
  const tools = new Map<string, Tool>();
  const events = new Map<string, Function[]>();
  const messages: any[] = [];
  const commands = new Map<string, unknown>();
  const sessionFile = path.join(cwd, `${sessionName}.jsonl`);

  const ctx: any = {
    cwd,
    hasUI: true,
    sessionManager: { getSessionFile: () => sessionFile },
    ui: {
      confirm: async () => true,
      notify() {},
      setStatus() {},
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

  async function cancel(id: string) {
    await requireTool("return_on_cancel").execute("cancel", { id }, new AbortController().signal, () => {}, ctx);
  }

  return { commands, ctx, emit, messages, register, cancel, sessionFile, tools };
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

async function testTimer(harness: Harness) {
  const label = "smoke timer";
  const resume = "timer resume";
  const jobId = await harness.register({ label, condition: { type: "timer", after: "1500ms" }, resume });
  await expectNoWake(harness, jobId, 900, "timer fired before target");
  await waitForWake(harness, { jobId, label, resume }, 2_500);
}

async function testLogContains(harness: Harness) {
  const label = "smoke log";
  const resume = "log resume";
  const log = path.join(cwd, "server.log");
  await fs.writeFile(log, "booting\n", "utf8");
  const jobId = await harness.register({
    label,
    condition: { type: "file", path: "server.log", contains: "READY", every: "100ms" },
    resume,
  });
  await expectNoWake(harness, jobId, 800, "log fired before READY was appended");
  await fs.appendFile(log, "READY\n", "utf8");
  await waitForWake(harness, { jobId, label, resume }, 2_500);
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
    allowExec: true,
    condition: { type: "exec", runner: "sh", command: `kill -0 ${child.pid}`, failure: true, every: "2s", timeout: "1s" },
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
    allowExec: true,
    condition: {
      type: "exec",
      runner: "node",
      code: `const net=require('node:net'); const s=net.connect({port:${port}, host:'127.0.0.1'},()=>{s.destroy(); process.exit(0)}); s.on('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),300);`,
      success: true,
      every: "2s",
      timeout: "1s"
    },
    resume,
  });
  await expectNoWake(harness, jobId, 800, "port watcher fired before server started");
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
    condition: { not: { type: "file", path: "not-flag.txt", exists: true, every: "100ms" } },
    resume,
  });
  await expectNoWake(harness, jobId, 1_200, "not condition fired while child was true");
  await fs.unlink(file);
  await waitForWake(harness, { jobId, label, resume }, 2_500);
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

await testTimer(harness);
await testLogContains(harness);
await testFileStable(harness);
await testProcessGone(harness);
await testPortOpen(harness);
await testFileExistsFalse(harness);
await testNotConditionAfterDelete(harness);
await testEmptyGroupRejected(harness);
await testBooleanTree(harness);
await testCancelBeforeFire(harness);
await testTimeoutWake(harness);
await harness.emit("session_shutdown");
await testRestartResume();
await testSessionIsolation();

const duplicateIds = allJobIds.filter((id, index) => allJobIds.indexOf(id) !== index);
if (duplicateIds.length > 0) throw new Error(`duplicate job ids: ${duplicateIds.join(", ")}`);

console.log(`smoke ok: ${allJobIds.length} jobs tested, cwd=${cwd}, home=${process.env.HOME}`);
