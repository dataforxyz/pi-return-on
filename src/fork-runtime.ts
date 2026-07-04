import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as fallback from "./fork-runtime-fallback.ts";
import { installedPiForksFile, isPiForksExtensionEnabledFromSettings } from "./pi-forks-detection.ts";

function installedPiForksRuntime(): string | undefined {
	if (!isPiForksExtensionEnabledFromSettings()) return undefined;
	const filePath = installedPiForksFile(path.join("src", "runtime.ts"));
	return filePath ? pathToFileURL(filePath).href : undefined;
}

async function loadRuntime(): Promise<typeof fallback> {
	const defaultRuntimeModule = isPiForksExtensionEnabledFromSettings() ? ["pi-forks", "runtime"].join("/") : undefined;
	for (const specifier of [defaultRuntimeModule, installedPiForksRuntime()].filter(Boolean) as string[]) {
		try {
			return await import(specifier) as typeof fallback;
		} catch {}
	}
	return fallback;
}

const runtime = await loadRuntime();

export const buildForkHandlerEnv = runtime.buildForkHandlerEnv;
export const buildForkRunPaths = runtime.buildForkRunPaths;
export const launchDetachedFork = runtime.launchDetachedFork;
