import * as fallback from "./fork-runtime-fallback.ts";

const runtimeModule = "pi-forks/runtime";
const runtime = await import(runtimeModule)
	.then((module) => module as typeof fallback)
	.catch(() => fallback);

export const buildForkHandlerEnv = runtime.buildForkHandlerEnv;
export const buildForkRunPaths = runtime.buildForkRunPaths;
export const launchDetachedFork = runtime.launchDetachedFork;
