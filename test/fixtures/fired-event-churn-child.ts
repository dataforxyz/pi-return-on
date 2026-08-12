import * as path from "node:path";

const stateDir = process.env.PI_RETURN_ON_STATE_DIR;
const jobId = process.env.RETURN_ON_CHURN_JOB_ID;
if (!stateDir) throw new Error("PI_RETURN_ON_STATE_DIR is required");
if (!jobId) throw new Error("RETURN_ON_CHURN_JOB_ID is required");

const { patchFiredEvent } = await import("../../src/index.ts");
const eventPath = path.join(stateDir, "fired", `${jobId}.json`);
let stopping = false;
process.stdin.once("data", () => {
	stopping = true;
	process.stdin.destroy();
});
process.stdin.resume();
process.stdout.write("READY\n");

while (!stopping) {
	await patchFiredEvent(eventPath, { lastAttemptAt: Date.now() });
	await new Promise<void>((resolve) => setImmediate(resolve));
}

process.stdout.write("DONE\n");
