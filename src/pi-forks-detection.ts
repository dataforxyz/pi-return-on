import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function expandHome(input: string, homeDir = os.homedir()): string {
	return input === "~" || input.startsWith("~/") ? path.join(homeDir, input.slice(2)) : input;
}

export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	return configured ? path.resolve(expandHome(configured, homeDir)) : path.join(homeDir, ".pi", "agent");
}

export function installedPiForksFile(relativePath: string, env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string | undefined {
	const filePath = path.join(resolvePiAgentDir(env, homeDir), "git", "github.com", "dataforxyz", "pi-forks", relativePath);
	return fs.existsSync(filePath) ? filePath : undefined;
}

function parseBooleanOverride(value: string | undefined): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
	if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
	return undefined;
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function findProjectSettingsPath(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(dir, ".pi", "settings.json");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function packageSource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && !Array.isArray(entry)) {
		const source = (entry as Record<string, unknown>).source;
		return typeof source === "string" ? source : undefined;
	}
	return undefined;
}

function isPiForksPackageSource(source: string | undefined): boolean {
	if (!source) return false;
	const normalized = source.replace(/\\/g, "/").toLowerCase();
	if (/^(?:npm:)?pi-forks(?:@|$)/.test(normalized)) return true;
	if (/(?:^|[:/])github\.com\/dataforxyz\/pi-forks(?:\.git)?(?:@|$|\/)/.test(normalized)) return true;
	return /(?:^|\/)pi-forks(?:\/)?$/.test(normalized) || /(?:^|\/)pi-forks\/(?:package\.json|src\/index\.ts)$/.test(normalized);
}

function packageIdentity(entry: unknown): string | undefined {
	const source = packageSource(entry);
	if (!source) return undefined;
	return isPiForksPackageSource(source) ? "pi-forks" : source;
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

function packageLoadsPiForksExtension(entry: unknown): boolean {
	if (!isPiForksPackageSource(packageSource(entry))) return false;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
	const filters = stringList((entry as Record<string, unknown>).extensions);
	if (!filters) return true;
	if (filters.length === 0) return false;
	const normalized = filters.map((filter) => filter.replace(/\\/g, "/"));
	if (normalized.some((filter) => filter === "-src/index.ts" || filter === "!src/index.ts" || filter === "-./src/index.ts" || filter === "!./src/index.ts")) return false;
	return true;
}

function settingsExtensionsIncludePiForks(extensions: string[]): boolean {
	return extensions.some((entry) => {
		if (entry.startsWith("!") || entry.startsWith("-")) return false;
		return isPiForksPackageSource(entry);
	});
}

// Pi merges global and project settings per-key with `deepMergeSettings`, where
// array-valued keys (`packages`, `extensions`) are replaced wholesale by the
// project value when the project defines them, rather than concatenated. Mirror
// that here so a project settings file that omits pi-forks disables the global
// entry (and vice versa) instead of accumulating entries across both files.
function effectiveArraySetting(global: unknown, project: unknown): unknown[] {
	if (Array.isArray(project)) return project;
	if (Array.isArray(global)) return global;
	return [];
}

export function isPiForksExtensionEnabledFromSettings(options: { cwd?: string; env?: NodeJS.ProcessEnv; homeDir?: string } = {}): boolean {
	const env = options.env ?? process.env;
	const override = parseBooleanOverride(env.PI_RETURN_ON_PI_FORKS_ENABLED ?? env.PI_FORKS_ENABLED);
	if (override !== undefined) return override;
	const homeDir = options.homeDir ?? os.homedir();
	const cwd = options.cwd ?? process.cwd();
	const globalSettings = readJsonObject(path.join(resolvePiAgentDir(env, homeDir), "settings.json"));
	const projectSettingsPath = findProjectSettingsPath(cwd);
	const projectSettings = projectSettingsPath ? readJsonObject(projectSettingsPath) : undefined;

	const packages = effectiveArraySetting(globalSettings?.packages, projectSettings?.packages);
	const extensions = effectiveArraySetting(globalSettings?.extensions, projectSettings?.extensions)
		.filter((entry): entry is string => typeof entry === "string");

	if (settingsExtensionsIncludePiForks(extensions)) return true;

	let piForksPackageEntry: unknown;
	let piForksPackageSeen = false;
	for (const entry of packages) {
		if (packageIdentity(entry) !== "pi-forks") continue;
		piForksPackageSeen = true;
		piForksPackageEntry = entry;
	}
	return piForksPackageSeen && packageLoadsPiForksExtension(piForksPackageEntry);
}
