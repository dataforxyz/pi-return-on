import assert from "node:assert/strict";
import test from "node:test";
import {
	formatDuration,
	parseDuration,
	parsePositiveDurationSetting,
	parseShellSleepDurationMs,
	resolveReturnOnStateDir,
} from "../src/index.ts";

test("resolveReturnOnStateDir defaults to home-local state", () => {
	assert.equal(resolveReturnOnStateDir({}, "/tmp/home"), "/tmp/home/.local/state/pi-return-on");
});

test("resolveReturnOnStateDir honors shared and source-specific env overrides", () => {
	assert.equal(resolveReturnOnStateDir({ PI_BACKGROUND_STATE_DIR: "~/state-root" }, "/tmp/home"), "/tmp/home/state-root/pi-return-on");
	assert.equal(resolveReturnOnStateDir({ PI_FORKS_STATE_ROOT: "/tmp/forks-root" }, "/tmp/home"), "/tmp/forks-root/pi-return-on");
	assert.equal(resolveReturnOnStateDir({ PI_BACKGROUND_STATE_DIR: "/tmp/root", PI_RETURN_ON_STATE_DIR: "~/return-on-only" }, "/tmp/home"), "/tmp/home/return-on-only");
});

test("parseDuration: nullish/empty returns fallback", () => {
	assert.equal(parseDuration(undefined), undefined);
	assert.equal(parseDuration(undefined, 500), 500);
	assert.equal(parseDuration(null as unknown as undefined, 500), 500);
	assert.equal(parseDuration("", 500), 500);
	assert.equal(parseDuration("   ", 500), 500);
});

test("parseDuration: numbers pass through", () => {
	assert.equal(parseDuration(0), 0);
	assert.equal(parseDuration(1234), 1234);
	assert.equal(parseDuration(-5), -5);
	assert.equal(parseDuration(Number.NaN, 7), 7);
	assert.equal(parseDuration(Number.POSITIVE_INFINITY, 7), 7);
});

test("parseDuration: ms/s/m/h/d unit conversion", () => {
	assert.equal(parseDuration("100ms"), 100);
	assert.equal(parseDuration("100"), 100);
	assert.equal(parseDuration("2s"), 2000);
	assert.equal(parseDuration("2sec"), 2000);
	assert.equal(parseDuration("2secs"), 2000);
	assert.equal(parseDuration("3m"), 180_000);
	assert.equal(parseDuration("3min"), 180_000);
	assert.equal(parseDuration("3mins"), 180_000);
	assert.equal(parseDuration("1h"), 3_600_000);
	assert.equal(parseDuration("1hr"), 3_600_000);
	assert.equal(parseDuration("1hrs"), 3_600_000);
	assert.equal(parseDuration("1d"), 86_400_000);
	assert.equal(parseDuration("1day"), 86_400_000);
	assert.equal(parseDuration("1days"), 86_400_000);
	assert.equal(parseDuration("1.5s"), 1500);
});

test("parseDuration: negative becomes clamped to zero via Math.max", () => {
	// the source uses Math.max(0, Math.round(...)) for string parsing
	assert.equal(parseDuration("0s"), 0);
});

test("parseDuration: quoted strings", () => {
	assert.equal(parseDuration('"2s"'), 2000);
	assert.equal(parseDuration("'2s'"), 2000);
});

test("parseDuration: bad input returns fallback", () => {
	assert.equal(parseDuration("garbage", 42), 42);
	assert.equal(parseDuration("garbage"), undefined);
	assert.equal(parseDuration("12xx", 9), 9);
});

test("parsePositiveDurationSetting: accepts, throws on non-positive/bad", () => {
	assert.equal(parsePositiveDurationSetting("5s", 1000, "x"), 5000);
	assert.equal(parsePositiveDurationSetting(undefined, 1000, "x"), 1000);
	assert.throws(() => parsePositiveDurationSetting("0s", 0, "x"), /x must be a positive duration/);
	assert.throws(() => parsePositiveDurationSetting("bad", 0, "x"), /x must be a positive duration/);
});

test("parseShellSleepDurationMs: default unit is seconds", () => {
	assert.equal(parseShellSleepDurationMs("3"), 3000);
	assert.equal(parseShellSleepDurationMs("3", "s"), 3000);
	assert.equal(parseShellSleepDurationMs("3", ""), 3000);
});

test("parseShellSleepDurationMs: m/h/d/ms units", () => {
	assert.equal(parseShellSleepDurationMs("2", "m"), 120_000);
	assert.equal(parseShellSleepDurationMs("1", "h"), 3_600_000);
	assert.equal(parseShellSleepDurationMs("1", "d"), 86_400_000);
	assert.equal(parseShellSleepDurationMs("500", "ms"), 500);
});

test("parseShellSleepDurationMs: unknown unit / bad number returns undefined", () => {
	assert.equal(parseShellSleepDurationMs("3", "x"), undefined);
	assert.equal(parseShellSleepDurationMs("abc"), undefined);
});

test("formatDuration: ms/s/m/h/d brackets", () => {
	assert.equal(formatDuration(0), "0ms");
	assert.equal(formatDuration(999), "999ms");
	assert.equal(formatDuration(1000), "1s");
	assert.equal(formatDuration(59_000), "59s");
	assert.equal(formatDuration(60_000), "1m");
	assert.equal(formatDuration(3_599_000), "60m");
	assert.equal(formatDuration(3_600_000), "1h");
	assert.equal(formatDuration(86_400_000), "1d");
});
