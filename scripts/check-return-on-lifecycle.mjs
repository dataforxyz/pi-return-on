#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
let scanArgs = ["--json"];
const thresholds = {
  activeExpired: numberFromEnv("RETURN_ON_MAX_EXPIRED_ACTIVE", 0),
  activeStale: numberFromEnv("RETURN_ON_MAX_STALE_ACTIVE", 0),
  deadPidInFlight: numberFromEnv("RETURN_ON_MAX_DEAD_HANDLER_PIDS", 0),
  staleInFlight: numberFromEnv("RETURN_ON_MAX_STALE_HANDLERS", 0),
  failedHandlers: numberFromEnv("RETURN_ON_MAX_FAILED_HANDLERS", 0),
  undeliveredEvents: numberFromEnv("RETURN_ON_MAX_UNDELIVERED_EVENTS", 0),
  firedWithoutObservedDelivery: numberFromEnv("RETURN_ON_MAX_FIRED_WITHOUT_DELIVERY", 0),
  firedWithOnlyFailedHandlers: numberFromEnv("RETURN_ON_MAX_FIRED_ONLY_FAILED_HANDLERS", 0),
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    console.log(`Usage: check-return-on-lifecycle [scanner args...]\n\nRuns scan-return-on-lifecycle and fails if lifecycle health exceeds thresholds.\nThreshold env vars/defaults:\n- RETURN_ON_MAX_EXPIRED_ACTIVE=${thresholds.activeExpired}\n- RETURN_ON_MAX_STALE_ACTIVE=${thresholds.activeStale}\n- RETURN_ON_MAX_DEAD_HANDLER_PIDS=${thresholds.deadPidInFlight}\n- RETURN_ON_MAX_STALE_HANDLERS=${thresholds.staleInFlight}\n- RETURN_ON_MAX_FAILED_HANDLERS=${thresholds.failedHandlers}\n- RETURN_ON_MAX_UNDELIVERED_EVENTS=${thresholds.undeliveredEvents}\n- RETURN_ON_MAX_FIRED_WITHOUT_DELIVERY=${thresholds.firedWithoutObservedDelivery}\n- RETURN_ON_MAX_FIRED_ONLY_FAILED_HANDLERS=${thresholds.firedWithOnlyFailedHandlers}\n\nPass normal scanner args such as --days 7 or a stateDir path after this command.`);
    process.exit(0);
  }
  scanArgs.push(arg);
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

const out = execFileSync(process.execPath, ["scripts/scan-return-on-lifecycle.mjs", ...scanArgs], { encoding: "utf8" });
const report = JSON.parse(out);
const checks = [
  ["expired active jobs", report.jobs.activeExpired, thresholds.activeExpired],
  ["stale active jobs", report.jobs.activeStale, thresholds.activeStale],
  ["dead in-flight handler pids", report.handlers.deadPidInFlight, thresholds.deadPidInFlight],
  ["stale in-flight handlers", report.handlers.staleInFlight, thresholds.staleInFlight],
  ["failed handlers", report.handlers.failed, thresholds.failedHandlers],
  ["undelivered fired events", report.firedEvents.undelivered, thresholds.undeliveredEvents],
  ["fired jobs without observed delivery", report.jobs.firedWithoutObservedDelivery, thresholds.firedWithoutObservedDelivery],
  ["fired jobs with only failed handlers", report.jobs.firedWithOnlyFailedHandlers, thresholds.firedWithOnlyFailedHandlers],
];
const failures = checks.filter(([, actual, max]) => actual > max);
if (failures.length) {
  console.error("return_on lifecycle check failed:");
  for (const [name, actual, max] of failures) console.error(`- ${name}: ${actual} > ${max}`);
  console.error("\nSamples:");
  const samples = report.samples ?? {};
  for (const key of ["activeExpired", "activeStale", "handlerDeadPid", "handlerStale", "handlerFailed", "firedWithoutObservedDelivery", "firedWithOnlyFailedHandlers"]) {
    if (samples[key]?.length) console.error(`${key}: ${JSON.stringify(samples[key].slice(0, 3), null, 2)}`);
  }
  process.exit(1);
}
console.log("return_on lifecycle check ok");
for (const [name, actual, max] of checks) console.log(`- ${name}: ${actual}/${max}`);
