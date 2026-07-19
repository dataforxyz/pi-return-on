import * as path from "node:path";

const stateDir = process.env.PI_RETURN_ON_STATE_DIR;
const writerId = process.env.RETURN_ON_WRITER_ID ?? `${process.pid}`;
const mode = process.env.RETURN_ON_WRITER_MODE ?? "register";
if (!stateDir) throw new Error("PI_RETURN_ON_STATE_DIR is required");

const { default: extension } = await import("../../src/index.ts");
const tools = new Map<string, any>();
const events = new Map<string, Function[]>();
const sessionFile = path.join(stateDir, `${writerId}.jsonl`);
const ctx: any = {
	cwd: stateDir,
	hasUI: false,
	isIdle: () => true,
	hasPendingMessages: () => false,
	sessionManager: {
		getSessionFile: () => sessionFile,
		getSessionId: () => writerId,
	},
	ui: {
		confirm: async () => true,
		notify() {},
		setStatus() {},
	},
};
const pi: any = {
	registerTool(tool: any) { tools.set(tool.name, tool); },
	registerCommand() {},
	registerMessageRenderer() {},
	appendEntry() {},
	on(event: string, handler: Function) {
		const handlers = events.get(event) ?? [];
		handlers.push(handler);
		events.set(event, handlers);
		return () => events.set(event, handlers.filter((candidate) => candidate !== handler));
	},
	sendMessage() {},
	getSessionName: () => writerId,
};

extension(pi);

async function emit(event: string): Promise<void> {
	for (const handler of events.get(event) ?? []) await handler({}, ctx);
}

async function register(suffix = ""): Promise<void> {
	const tool = tools.get("return_on");
	if (!tool) throw new Error("return_on tool was not registered");
	await tool.execute("child-register", {
		label: `writer ${writerId}${suffix}`,
		condition: { type: "timer", after: "1h" },
		resume: `resume ${writerId}${suffix}`,
		endTurn: false,
	}, new AbortController().signal, () => {}, ctx);
}

await emit("session_start");
if (mode === "stale-writer") {
	process.stdout.write("READY\n");
	await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
	process.stdin.destroy();
	await register();
} else if (mode === "retry-after-lock-timeout") {
	try {
		await register(" first");
		throw new Error("first save unexpectedly succeeded while lock was held");
	} catch (error) {
		if (!String(error).includes("Timed out acquiring")) throw error;
		process.stdout.write("SAVE_FAILED_PENDING\n");
	}
	await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
	process.stdin.destroy();
	await register(" first");
} else {
	await register();
}
await emit("session_shutdown");
process.stdout.write("DONE\n");
