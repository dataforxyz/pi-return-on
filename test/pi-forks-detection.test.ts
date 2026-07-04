import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isPiForksExtensionEnabledFromSettings } from "../src/pi-forks-detection.ts";

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("pi-forks detection is false when checkout exists but package is not enabled", async () => {
	const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-forks-detect-home-"));
	const agentDir = path.join(homeDir, ".pi", "agent");
	await fs.mkdir(path.join(agentDir, "git", "github.com", "dataforxyz", "pi-forks", "src"), { recursive: true });
	assert.equal(isPiForksExtensionEnabledFromSettings({ cwd: homeDir, homeDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } }), false);
});

test("pi-forks detection is true for enabled package settings", async () => {
	const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-forks-detect-home-"));
	const agentDir = path.join(homeDir, ".pi", "agent");
	await writeJson(path.join(agentDir, "settings.json"), { packages: ["git:github.com/dataforxyz/pi-forks"] });
	assert.equal(isPiForksExtensionEnabledFromSettings({ cwd: homeDir, homeDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } }), true);
});

test("project package filter can disable global pi-forks extension", async () => {
	const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-forks-detect-home-"));
	const cwd = path.join(homeDir, "repo", "subdir");
	const agentDir = path.join(homeDir, ".pi", "agent");
	await fs.mkdir(cwd, { recursive: true });
	await writeJson(path.join(agentDir, "settings.json"), { packages: ["git:github.com/dataforxyz/pi-forks"] });
	await writeJson(path.join(homeDir, "repo", ".pi", "settings.json"), { packages: [{ source: "git:github.com/dataforxyz/pi-forks", extensions: [] }] });
	assert.equal(isPiForksExtensionEnabledFromSettings({ cwd, homeDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } }), false);
});

test("pi-forks detection honors explicit environment override", async () => {
	const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-forks-detect-home-"));
	assert.equal(isPiForksExtensionEnabledFromSettings({ cwd: homeDir, homeDir, env: { ...process.env, PI_RETURN_ON_PI_FORKS_ENABLED: "1" } }), true);
	assert.equal(isPiForksExtensionEnabledFromSettings({ cwd: homeDir, homeDir, env: { ...process.env, PI_RETURN_ON_PI_FORKS_ENABLED: "0" } }), false);
});
