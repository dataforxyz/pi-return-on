import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension from "../src/index.ts";

type Tool = {
  execute: (toolCallId: string, params: any, signal: AbortSignal, onUpdate: (update: unknown) => void, ctx: any) => Promise<any>;
};

const tools = new Map<string, Tool>();
const events = new Map<string, Function[]>();
const messages: any[] = [];
const commands = new Map<string, unknown>();
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-return-on-smoke-"));
const sessionFile = path.join(cwd, "session.jsonl");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  return result.details.job.id as string;
}

async function waitForMessage(label: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = messages.find((entry) => String(entry.message?.content ?? "").includes(label));
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}. Messages: ${messages.map((m) => m.message?.content).join("\n---\n")}`);
}

async function testTimer() {
  const label = "smoke timer";
  await register({ label, condition: { type: "timer", after: "100ms" }, resume: "timer resume" });
  await waitForMessage(label, 2_500);
}

async function testLogContains() {
  const label = "smoke log";
  const log = path.join(cwd, "server.log");
  await fs.writeFile(log, "booting\n", "utf8");
  await register({
    label,
    condition: { type: "file", path: "server.log", contains: "READY", every: "100ms" },
    resume: "log resume",
  });
  setTimeout(() => void fs.appendFile(log, "READY\n", "utf8"), 300).unref();
  await waitForMessage(label, 2_500);
}

async function testFileStable() {
  const label = "smoke stable file";
  const file = path.join(cwd, "out.mp4");
  await register({
    label,
    condition: { type: "file", path: "out.mp4", stableFor: "300ms", every: "100ms" },
    resume: "stable file resume",
  });
  setTimeout(() => void fs.writeFile(file, "partial", "utf8"), 100).unref();
  setTimeout(() => void fs.appendFile(file, " done", "utf8"), 300).unref();
  await waitForMessage(label, 3_000);
}

async function testProcessGone() {
  const label = "smoke process gone";
  const child = spawn("sleep", ["1"], { stdio: "ignore" });
  await register({
    label,
    allowExec: true,
    condition: { type: "exec", runner: "sh", command: `kill -0 ${child.pid}`, failure: true, every: "2s", timeout: "1s" },
    resume: "process gone resume",
  });
  await waitForMessage(label, 5_000);
}

async function testPortOpen() {
  const label = "smoke port open";
  const serverScript = path.join(cwd, "server.mjs");
  const port = 40_000 + Math.floor(Math.random() * 10_000);
  await fs.writeFile(serverScript, `
    import http from 'node:http';
    setTimeout(() => {
      const server = http.createServer((_req, res) => res.end('ok'));
      server.listen(${port}, '127.0.0.1');
      setTimeout(() => server.close(() => process.exit(0)), 4000);
    }, 500);
  `, "utf8");
  const server = spawn("node", [serverScript], { cwd, stdio: "ignore" });
  await register({
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
    resume: "port open resume",
  });
  await waitForMessage(label, 5_000);
  server.kill("SIGTERM");
}

async function testBooleanTree() {
  const label = "smoke boolean tree";
  await register({
    label,
    allowExec: true,
    condition: {
      all: [
        { type: "timer", after: "100ms" },
        { any: [
          { type: "file", path: "never-created.txt", exists: true, every: "100ms" },
          { type: "exec", runner: "sh", command: "exit 0", success: true, every: "2s" }
        ] }
      ]
    },
    resume: "boolean resume",
  });
  await waitForMessage(label, 4_000);
}

extension(pi);
await emit("session_start");

await testTimer();
await testLogContains();
await testFileStable();
await testProcessGone();
await testPortOpen();
await testBooleanTree();

await emit("session_shutdown");
console.log(`smoke ok: ${messages.length} wake messages, cwd=${cwd}`);
