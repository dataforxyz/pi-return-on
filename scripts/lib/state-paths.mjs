import * as path from "node:path";
import * as os from "node:os";

export function getStateDir() {
  return path.join(os.homedir(), ".local", "state", "pi-return-on");
}

export function getJobsPath(stateDir = getStateDir()) {
  return path.join(stateDir, "jobs.json");
}

export function getHandlersPath(stateDir = getStateDir()) {
  return path.join(stateDir, "handlers.json");
}

export function getFiredDir(stateDir = getStateDir()) {
  return path.join(stateDir, "fired");
}

export function getAuditFile(stateDir = getStateDir()) {
  return path.join(stateDir, "direct-wait-audit.jsonl");
}

export function getLifecycleAuditFile(stateDir = getStateDir()) {
  return path.join(stateDir, "lifecycle-audit.jsonl");
}
