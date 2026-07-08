import assert from "node:assert/strict";
import test from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildForkHandlerEnv,
	buildForkIntercomIdentity,
	buildForkRunPaths,
	buildPiForkArgs,
	forkHandlerKind,
	getForkHandlerIdentity,
	getForkStateDir,
	getForkStateRoot,
	truncateText,
} from "../src/fork-runtime-fallback.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
	const old: Record<string, string | undefined> = {};
	for (const key of Object.keys(vars)) old[key] = process.env[key];
	try {
		for (const [key, value] of Object.entries(vars)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fn();
	} finally {
		for (const [key, value] of Object.entries(old)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("forkHandlerKind maps return_on to return-on display kind", () => {
	assert.equal(forkHandlerKind("intercom"), "intercom");
	assert.equal(forkHandlerKind("return_on"), "return-on");
	assert.equal(forkHandlerKind("subagents"), "subagent");
});

test("buildForkIntercomIdentity normalizes session names and status tags", () => {
	const identity = buildForkIntercomIdentity("return_on", "roh_abc-123_extra");
	assert.equal(identity.kind, "return-on");
	assert.equal(identity.runId, "roh_abc-123_extra");
	assert.equal(identity.statusTag, "fork-handler:return-on:roh_abc-123_extra");
	assert.equal(identity.sessionName, "fork-return-on-abc-123");
});

test("getForkHandlerIdentity reads source-specific handler environment", () => {
	assert.deepEqual(getForkHandlerIdentity({ PI_RETURN_ON_HANDLER: "1", PI_RETURN_ON_HANDLER_RUN_ID: "roh_abc" }), buildForkIntercomIdentity("return_on", "roh_abc"));
	assert.equal(getForkHandlerIdentity({ PI_RETURN_ON_HANDLER: "0", PI_RETURN_ON_HANDLER_RUN_ID: "roh_abc" }), undefined);
});

test("buildForkHandlerEnv adds handler flag and run id while preserving extras", () => {
	const env = buildForkHandlerEnv("subagents", "sbf_123", { KEEP: "yes" });
	assert.equal(env.KEEP, "yes");
	assert.equal(env.PI_SUBAGENT_BACKGROUND_HANDLER, "1");
	assert.equal(env.PI_SUBAGENT_BACKGROUND_HANDLER_RUN_ID, "sbf_123");
});

test("fork state dir honors shared root and source-specific override", () => {
	withEnv({ PI_FORKS_STATE_ROOT: "~/fork-root", PI_BACKGROUND_STATE_DIR: undefined, PI_RETURN_ON_STATE_DIR: undefined }, () => {
		assert.equal(getForkStateRoot("/home/tester"), path.join("/home/tester", "fork-root"));
		assert.equal(getForkStateDir("return_on", "/home/tester"), path.join("/home/tester", "fork-root", "pi-return-on"));
	});
	withEnv({ PI_RETURN_ON_STATE_DIR: "~/return-state" }, () => {
		assert.equal(getForkStateDir("return_on", "/home/tester"), path.join("/home/tester", "return-state"));
	});
});

test("buildForkRunPaths builds all handler paths under source handlers dir", () => {
	withEnv({ PI_FORKS_STATE_ROOT: undefined, PI_BACKGROUND_STATE_DIR: undefined, PI_RETURN_ON_STATE_DIR: undefined }, () => {
		const paths = buildForkRunPaths("return_on", "roh_1", "/home/tester");
		const base = path.join("/home/tester", ".local", "state", "pi-return-on", "handlers", "roh_1");
		assert.equal(paths.dir, base);
		assert.equal(paths.eventPath, path.join(base, "event.json"));
		assert.equal(paths.sessionDir, path.join(base, "sessions"));
	});
});

test("buildPiForkArgs includes optional fork file before prompt reference", () => {
	const args = buildPiForkArgs({ sessionDir: "/sessions", systemPrompt: "sys", promptPath: "/prompt.md", forkFile: "/fork.json" });
	assert.deepEqual(args, ["-p", "--session-dir", "/sessions", "--append-system-prompt", "sys", "--fork", "/fork.json", "@/prompt.md"]);
});

test("truncateText truncates by bytes", () => {
	const text = truncateText("abcdef", 3);
	assert.match(text, /^abc\n\[truncated 3 bytes\]$/);
	assert.equal(truncateText("abc", 3), "abc");
});
