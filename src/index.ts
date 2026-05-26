import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as net from "node:net";
import * as http from "node:http";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildForkHandlerEnv, buildForkRunPaths, launchDetachedFork } from "./fork-runtime.ts";
import { compactReturnOnHandlerMessages } from "./context-compaction.ts";
import { formatDuration, parseDuration, parsePositiveDurationSetting, parseShellSleepDurationMs } from "./time-utils.ts";
export { formatDuration, parseDuration, parsePositiveDurationSetting, parseShellSleepDurationMs } from "./time-utils.ts";

const EXTENSION_NAME = "return-on";
const HANDLER_MESSAGE_TYPE = "return-on-handler";
const RETURN_ON_SHORTCUT = Key.ctrlAlt("w");
const RETURN_ON_SHORTCUT_ALIASES = [RETURN_ON_SHORTCUT, Key.altCtrl("w")];
const RETURN_ON_SHORTCUT_LABEL = "Ctrl+Alt+W";
const RETURN_ON_MODAL_BODY_LINES = 28;
const STATE_DIR = path.join(os.homedir(), ".local", "state", "pi-return-on");
const JOBS_FILE = path.join(STATE_DIR, "jobs.json");
const FIRED_DIR = path.join(STATE_DIR, "fired");
const HANDLERS_FILE = path.join(STATE_DIR, "handlers.json");
const HANDLERS_DIR = path.join(STATE_DIR, "handlers");
const DIRECT_WAIT_AUDIT_FILE = path.join(STATE_DIR, "direct-wait-audit.jsonl");
const LIFECYCLE_AUDIT_FILE = path.join(STATE_DIR, "lifecycle-audit.jsonl");
const DEFAULT_TICK_MS = 1000;
const DEFAULT_EXEC_EVERY_MS = 5000;
const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
const DEFAULT_FILE_EVERY_MS = 1000;
const DEFAULT_PROCESS_EVERY_MS = 2000;
const DEFAULT_PORT_EVERY_MS = 2000;
const DEFAULT_URL_EVERY_MS = 5000;
const DEFAULT_PORT_TIMEOUT_MS = 1000;
const DEFAULT_URL_TIMEOUT_MS = 5000;
const DEFAULT_WEBHOOK_HOST = process.env.PI_RETURN_ON_WEBHOOK_HOST || "127.0.0.1";
const DEFAULT_WEBHOOK_PORT = Number.parseInt(process.env.PI_RETURN_ON_WEBHOOK_PORT || "0", 10) || 0;
const DEFAULT_RETURN_ON_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RETURN_ON_MAX_TIMEOUT_MS = 2 * 60 * 60_000;
const MIN_EXEC_EVERY_MS = 2000;
const OUTPUT_LIMIT_BYTES = 50 * 1024;
const DIRECT_SLEEP_BLOCK_THRESHOLD_MS = 10_000;
const DIRECT_TIMEOUT_AUDIT_THRESHOLD_MS = 30_000;
const DIRECT_TIMEOUT_BLOCK_THRESHOLD_MS = 300_000;
const HANDLER_SUMMARY_LIMIT_BYTES = 24 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_RETENTION_MS = DEFAULT_RETENTION_DAYS * 86_400_000;
const DEFAULT_AUDIT_MAX_ENTRIES = 5000;
const RETURN_ON_PARENT_SESSION_FILE_ENV = "PI_RETURN_ON_PARENT_SESSION_FILE";
const RETURN_ON_PARENT_SESSION_ID_ENV = "PI_RETURN_ON_PARENT_SESSION_ID";
const RETURN_ON_PARENT_SESSION_NAME_ENV = "PI_RETURN_ON_PARENT_SESSION_NAME";
const RETURN_ON_PARENT_INTERCOM_TARGET_ENV = "PI_RETURN_ON_PARENT_INTERCOM_TARGET";
const INTERCOM_PARENT_SESSION_FILE_ENV = "PI_INTERCOM_PARENT_SESSION_FILE";
const INTERCOM_PARENT_SESSION_ID_ENV = "PI_INTERCOM_PARENT_SESSION_ID";
const INTERCOM_PARENT_SESSION_NAME_ENV = "PI_INTERCOM_PARENT_SESSION_NAME";
const INTERCOM_PARENT_INTERCOM_TARGET_ENV = "PI_INTERCOM_PARENT_INTERCOM_TARGET";
const PARENT_SESSION_FILE_ENVS = [RETURN_ON_PARENT_SESSION_FILE_ENV, INTERCOM_PARENT_SESSION_FILE_ENV] as const;
const PARENT_SESSION_ID_ENVS = [RETURN_ON_PARENT_SESSION_ID_ENV, INTERCOM_PARENT_SESSION_ID_ENV] as const;
const PARENT_SESSION_NAME_ENVS = [RETURN_ON_PARENT_SESSION_NAME_ENV, INTERCOM_PARENT_SESSION_NAME_ENV] as const;
const PARENT_INTERCOM_TARGET_ENVS = [RETURN_ON_PARENT_INTERCOM_TARGET_ENV, INTERCOM_PARENT_INTERCOM_TARGET_ENV] as const;

const DIRECT_WAIT_SYSTEM_GUIDANCE = [
	"Direct wait policy for return_on:",
	"- Do not block the conversation with direct waits such as sleep commands of 10 seconds or longer, tail -f, watch, infinite polling loops, or foreground dev servers.",
	"- For long-running work, start the command in the background, capture logs/pid files, then register a return_on watcher for the file, process, port, URL, webhook, or timer that means it is ready/done.",
	"- Choose a timeout that covers the longest reasonable wait; the packaged default max is 2h, so do not assume older 10m caps unless project settings say otherwise.",
	"- After registering return_on, end the turn and let return_on wake the session instead of polling manually.",
].join("\n");

type GroupOp = "and" | "or" | "not";
type Runner = "sh" | "bash" | "xonsh" | "python" | "node";
type ParentRouting = "auto" | "main" | "current";

const SUPPORTED_RUNNERS = new Set<Runner>(["sh", "bash", "xonsh", "python", "node"]);

type Condition = GroupCondition | TimerCondition | FileCondition | ExecCondition | ProcessCondition | PortCondition | UrlCondition | IncomingWebhookCondition;

interface GroupCondition extends Record<string, unknown> {
	op: GroupOp;
	children: Condition[];
}

interface TimerCondition extends Record<string, unknown> {
	type: "timer";
	after?: string | number;
	at?: string | number;
}

interface FileCondition extends Record<string, unknown> {
	type: "file";
	path: string;
	exists?: boolean;
	deleted?: boolean;
	changed?: boolean;
	stableFor?: string | number;
	contains?: string;
	matches?: string;
	every?: string | number;
}

interface ExecCondition extends Record<string, unknown> {
	type: "exec";
	runner?: Runner;
	shell?: Runner;
	command?: string;
	/** Compatibility alias normalized to command. Prefer command in new calls. */
	cmd?: string;
	code?: string;
	every?: string | number;
	timeout?: string | number;
	success?: boolean;
	failure?: boolean;
	exitCode?: number;
	stdoutContains?: string;
	stderrContains?: string;
	outputContains?: string;
	stdoutMatches?: string;
	stderrMatches?: string;
	outputMatches?: string;
}

interface ProcessCondition extends Record<string, unknown> {
	type: "process";
	pid?: number;
	pidFile?: string;
	name?: string;
	commandContains?: string;
	matches?: string;
	state?: "running" | "exited";
	running?: boolean;
	exited?: boolean;
	every?: string | number;
}

interface PortCondition extends Record<string, unknown> {
	type: "port";
	port: number;
	host?: string;
	open?: boolean;
	closed?: boolean;
	timeout?: string | number;
	every?: string | number;
}

interface UrlCondition extends Record<string, unknown> {
	type: "url";
	url: string;
	method?: string;
	status?: number | number[];
	ok?: boolean;
	bodyContains?: string;
	bodyMatches?: string;
	timeout?: string | number;
	every?: string | number;
}

interface WebhookConfig {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	timeout?: string | number;
}

type DeliveryMode = "wake" | "fork";
type HandlerNotifyMode = "ack-and-summary" | "summary" | "none";

interface DeliveryConfig {
	mode: DeliveryMode;
	notify: HandlerNotifyMode;
	triggerParentOnSummary: boolean;
	piCommand?: string;
}

interface IncomingWebhookCondition extends Record<string, unknown> {
	type: "webhook";
	path?: string;
	token?: string;
	method?: string;
	bodyContains?: string;
	bodyMatches?: string;
}

interface LeafLatch {
	trueAt: number;
	summary: string;
	details?: unknown;
}

interface LeafState {
	lastCheckAt?: number;
	lastMtimeMs?: number;
	stableSince?: number;
	lastSummary?: string;
	lastValue?: boolean;
}

interface ReturnOnSettings {
	defaultTimeout?: string | number;
	defaultTimeoutMs?: number;
	maxTimeout?: string | number;
	maxTimeoutMs?: number;
	defaultDeliveryMode?: DeliveryMode;
	deliveryMode?: DeliveryMode;
	defaultDeliveryNotify?: HandlerNotifyMode;
	triggerParentOnSummary?: boolean | string | number;
}

interface ReturnOnConfig {
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
	defaultDeliveryMode: DeliveryMode;
	defaultDeliveryNotify: HandlerNotifyMode;
	triggerParentOnSummary: boolean;
}

interface ReturnOnJob {
	id: string;
	label: string;
	cwd: string;
	sessionFile?: string;
	parentSessionId?: string;
	parentSessionName?: string;
	parentIntercomTarget?: string;
	parentRouting?: ParentRouting;
	createdAt: number;
	updatedAt: number;
	status: "active" | "fired" | "cancelled";
	condition: Condition;
	resume: string;
	timeoutAt?: number;
	allowExec?: boolean;
	every?: string | number;
	webhook?: WebhookConfig;
	delivery?: DeliveryConfig;
	endTurn?: boolean;
	handlerRunId?: string;
	latches: Record<string, LeafLatch>;
	leafState: Record<string, LeafState>;
	fireReason?: string;
	firedAt?: number;
	cancelledAt?: number;
	maxFires?: number;
	fireCount?: number;
	lastFiredAt?: number;
	rearmPending?: boolean;
}

interface ReturnOnHandlerRun {
	id: string;
	jobId: string;
	label: string;
	cwd: string;
	parentSessionFile?: string;
	parentSessionId?: string;
	parentSessionName?: string;
	parentIntercomTarget?: string;
	status: "starting" | "running" | "complete" | "failed";
	pid?: number;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	dir: string;
	eventPath: string;
	promptPath: string;
	stdoutPath: string;
	stderrPath: string;
	sessionDir: string;
	notify?: HandlerNotifyMode;
	triggerParentOnSummary?: boolean;
	summary?: string;
	error?: string;
	finishSource?: "close" | "reconciled";
}

interface JobsState {
	version: 1;
	jobs: ReturnOnJob[];
}

interface HandlersState {
	version: 1;
	handlers: ReturnOnHandlerRun[];
}

type FiredEventDeliveryStatus = "pending" | "wake-sent" | "handler-launched" | "skipped-cancelled" | "failed";

interface FiredEventState {
	version: 1;
	event: "return_on.fired";
	id: string;
	jobId: string;
	label: string;
	reason: string;
	createdAt: number;
	firedAt: number;
	cwd: string;
	sessionFile?: string;
	resume: string;
	job: ReturnOnJob;
	deliveryStatus: FiredEventDeliveryStatus;
	deliveredAt?: number;
	lastAttemptAt?: number;
	handlerRunId?: string;
	error?: string;
}

interface PruneOptions {
	retentionMs?: number;
	auditMaxEntries?: number;
	dryRun?: boolean;
}

interface PruneSummary {
	dryRun: boolean;
	retentionMs: number;
	auditMaxEntries: number;
	jobsPruned: number;
	firedEventsPruned: number;
	handlersPruned: number;
	handlerDirsPruned: number;
	auditEntriesPruned: number;
}

interface EvalResult {
	value: boolean;
	summary: string;
	details?: unknown;
}

interface FileWatchTarget {
	jobId: string;
	key: string;
	filePath: string;
	dir: string;
	basename: string;
}

interface IncomingWebhookTarget {
	jobId: string;
	key: string;
	condition: IncomingWebhookCondition;
}

type LeafCondition = TimerCondition | FileCondition | ExecCondition | ProcessCondition | PortCondition | UrlCondition | IncomingWebhookCondition;

interface ConditionLeafTarget {
	key: string;
	condition: LeafCondition;
}

type DirectWaitAuditAction = "blocked" | "allowed_short_sleep" | "allowed_short_timeout" | "allowed_backgrounded";

interface DirectWaitMatch {
	kind: string;
	detail: string;
	durationMs?: number;
}

interface DirectWaitAnalysis extends DirectWaitMatch {
	action: DirectWaitAuditAction;
}

interface DirectWaitAuditEntry extends DirectWaitAnalysis {
	version: 1;
	event: "direct_wait";
	timestamp: number;
	cwd?: string;
	sessionFile?: string;
	toolName: string;
	command: string;
	thresholdMs: number;
	reason?: string;
}

let jobs: ReturnOnJob[] = [];
let handlerRuns: ReturnOnHandlerRun[] = [];
let currentSessionFile: string | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let immediateTickTimer: ReturnType<typeof setTimeout> | undefined;
let latestCtx: ExtensionContext | undefined;
let ticking = false;
let fileWatchSignature = "";
let fileWatchers = new Map<string, fs.FSWatcher>();
let incomingWebhookServer: http.Server | undefined;
let incomingWebhookServerStarting: Promise<void> | undefined;

function nowIso(ts = Date.now()): string {
	return new Date(ts).toISOString();
}

function makeId(): string {
	return `ro_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeToken(bytes = 16): string {
	return randomBytes(bytes).toString("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function getPollingInterval(job: ReturnOnJob, conditionEvery: string | number | undefined, fallbackMs: number, minMs = 0): number {
	return Math.max(parseDuration(conditionEvery ?? job.every, fallbackMs) ?? fallbackMs, minMs);
}

function expandHome(input: string): string {
	return input === "~" || input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
	try {
		const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
		return isObject(parsed) ? parsed : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function parseDeliveryModeSetting(value: unknown, fallback: DeliveryMode, name: string): DeliveryMode {
	if (value === undefined || value === null || value === "") return fallback;
	if (value === "wake" || value === "fork") return value;
	throw new Error(`${name} must be 'wake' or 'fork'`);
}

function parseNotifySetting(value: unknown, fallback: HandlerNotifyMode, name: string): HandlerNotifyMode {
	if (value === undefined || value === null || value === "") return fallback;
	if (value === "ack-and-summary" || value === "summary" || value === "none") return value;
	throw new Error(`${name} must be 'ack-and-summary', 'summary', or 'none'`);
}

function parseBooleanSetting(value: unknown, fallback: boolean, name: string): boolean {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
		if (normalized === "0" || normalized === "false" || normalized === "no") return false;
	}
	throw new Error(`${name} must be a boolean`);
}

function getPiAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR
		? path.resolve(expandHome(process.env.PI_CODING_AGENT_DIR))
		: path.join(os.homedir(), ".pi", "agent");
}

async function loadReturnOnConfig(cwd: string): Promise<ReturnOnConfig> {
	let settings: ReturnOnSettings = {};
	for (const file of [path.join(getPiAgentDir(), "settings.json"), path.join(cwd, ".pi", "settings.json")]) {
		const parsed = await readJsonObject(expandHome(file));
		if (isObject(parsed?.returnOn)) settings = { ...settings, ...parsed.returnOn };
	}
	const defaultSource = process.env.PI_RETURN_ON_DEFAULT_TIMEOUT ?? settings.defaultTimeout ?? settings.defaultTimeoutMs;
	const maxSource = process.env.PI_RETURN_ON_MAX_TIMEOUT ?? settings.maxTimeout ?? settings.maxTimeoutMs;
	const maxTimeoutMs = parsePositiveDurationSetting(maxSource, DEFAULT_RETURN_ON_MAX_TIMEOUT_MS, "returnOn.maxTimeout");
	const defaultTimeoutMs = parsePositiveDurationSetting(defaultSource, DEFAULT_RETURN_ON_TIMEOUT_MS, "returnOn.defaultTimeout");
	if (defaultTimeoutMs > maxTimeoutMs) throw new Error(`returnOn.defaultTimeout (${formatDuration(defaultTimeoutMs)}) must not exceed returnOn.maxTimeout (${formatDuration(maxTimeoutMs)})`);
	const defaultDeliveryMode = parseDeliveryModeSetting(process.env.PI_RETURN_ON_DELIVERY_MODE ?? settings.defaultDeliveryMode ?? settings.deliveryMode, "wake", "returnOn.defaultDeliveryMode");
	const defaultDeliveryNotify = parseNotifySetting(process.env.PI_RETURN_ON_DELIVERY_NOTIFY ?? settings.defaultDeliveryNotify, "summary", "returnOn.defaultDeliveryNotify");
	const triggerParentOnSummary = parseBooleanSetting(process.env.PI_RETURN_ON_TRIGGER_PARENT_ON_SUMMARY ?? settings.triggerParentOnSummary, true, "returnOn.triggerParentOnSummary");
	return { defaultTimeoutMs, maxTimeoutMs, defaultDeliveryMode, defaultDeliveryNotify, triggerParentOnSummary };
}

function parseRequestedJobTimeout(input: unknown, config: ReturnOnConfig): number {
	const timeoutMs = input === undefined ? config.defaultTimeoutMs : parseDuration(typeof input === "string" || typeof input === "number" ? input : undefined);
	if (timeoutMs === undefined || timeoutMs <= 0) throw new Error("return_on timeout must be a positive duration");
	if (timeoutMs > config.maxTimeoutMs) throw new Error(`return_on timeout ${formatDuration(timeoutMs)} exceeds max ${formatDuration(config.maxTimeoutMs)}. Configure returnOn.maxTimeout in pi settings if a longer watcher is required.`);
	return timeoutMs;
}

function parseAt(input: string | number | undefined, createdAt: number): number | undefined {
	if (input === undefined || input === null || input === "") return undefined;
	if (typeof input === "number" && Number.isFinite(input)) return input;
	if (typeof input !== "string") return undefined;
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	const timeOnly = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
	if (timeOnly) {
		const date = new Date(createdAt);
		date.setHours(Number(timeOnly[1]), Number(timeOnly[2]), Number(timeOnly[3] ?? 0), 0);
		if (date.getTime() <= createdAt) date.setDate(date.getDate() + 1);
		return date.getTime();
	}
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function formatAge(timestamp: number | undefined, now = Date.now()): string {
	if (!timestamp) return "unknown";
	const delta = now - timestamp;
	if (Math.abs(delta) < 1000) return "just now";
	return delta >= 0 ? `${formatDuration(delta)} ago` : `in ${formatDuration(-delta)}`;
}

function isExplicitlyBackgrounded(command: string): boolean {
	const normalized = command.replace(/\\\n/g, " ");
	return /(^|\s)(nohup|setsid)\s+/.test(normalized)
		|| /(^|[;\s])disown(\s|;|$)/.test(normalized)
		|| /(^|[^&])&(\s*(echo\s+\$!|disown|$|[;]))/.test(normalized);
}

function detectDirectWaitPattern(normalized: string): DirectWaitMatch | undefined {
	for (const match of normalized.matchAll(/(?:^|[;&|]\s*)(?:rtk\s+run\s+)?sleep\s+(\d+(?:\.\d+)?)(ms|s|m|h|d)?\b/g)) {
		const durationMs = parseShellSleepDurationMs(match[1], match[2] ?? "s");
		if (durationMs !== undefined) {
			return {
				kind: durationMs >= DIRECT_SLEEP_BLOCK_THRESHOLD_MS ? "long sleep" : "short sleep",
				detail: `sleep ${match[1]}${match[2] ?? "s"}`,
				durationMs,
			};
		}
	}

	// `timeout [opts] N[smhd] <cmd>` (GNU coreutils): agent is bounding a slow
	// foreground command with a hard ceiling instead of backgrounding it +
	// using return_on. Detect any timeout >= 30s; treat >= 5m as blocked.
	for (const match of normalized.matchAll(/(?:^|[;&|]\s*)timeout(?:\s+(?:--?[a-zA-Z][\w-]*(?:=\S+)?|-[a-zA-Z]\s+\S+))*\s+(\d+(?:\.\d+)?)(ms|s|m|h|d)?\s+\S/g)) {
		const durationMs = parseShellSleepDurationMs(match[1], match[2] ?? "s");
		if (durationMs !== undefined && durationMs >= DIRECT_TIMEOUT_AUDIT_THRESHOLD_MS) {
			return {
				kind: "timeout-bounded command",
				detail: `timeout ${match[1]}${match[2] ?? "s"}`,
				durationMs,
			};
		}
	}

	const checks: Array<{ regex: RegExp; kind: string; detail: string }> = [
		{ regex: /(?:^|[;&|]\s*)tail\b[^;&|]*(?:\s-f\b|\s--follow(?:=\S+)?\b)/, kind: "streaming log wait", detail: "tail -f/--follow" },
		{ regex: /(?:^|[;&|]\s*)journalctl\b[^;&|]*(?:\s-f\b|\s--follow\b)/, kind: "streaming log wait", detail: "journalctl -f/--follow" },
		{ regex: /(?:^|[;&|]\s*)kubectl\s+logs\b[^;&|]*(?:\s-f\b|\s--follow\b)/, kind: "streaming log wait", detail: "kubectl logs -f/--follow" },
		{ regex: /(?:^|[;&|]\s*)watch\s+/, kind: "repeated polling", detail: "watch" },
		{ regex: /\bwhile\s+(?:true|:)\s*;\s*do\b/, kind: "infinite loop", detail: "while true/while :" },
		{ regex: /\bfor\s*\(\(\s*;\s*;\s*\)\)\s*;\s*do\b/, kind: "infinite loop", detail: "for ((;;))" },
		{ regex: /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev\b/, kind: "foreground dev server", detail: "package manager dev server" },
		{ regex: /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+start\b/, kind: "foreground server", detail: "package manager start server" },
		{ regex: /(?:^|[;&|]\s*)(?:next|vite|astro|webpack-dev-server)\s+(?:dev|serve)?\b/, kind: "foreground dev server", detail: "dev server command" },
		{ regex: /(?:^|[;&|]\s*)python(?:3)?\s+-m\s+http\.server\b/, kind: "foreground server", detail: "python -m http.server" },
		{ regex: /(?:^|[;&|]\s*)gh\s+run\s+watch\b/, kind: "ci watch", detail: "gh run watch" },
		{ regex: /(?:^|[;&|]\s*)gh\s+pr\s+checks\b[^;&|]*\s--watch(?!=false)(?:\s|$|=true\b)/, kind: "ci watch", detail: "gh pr checks --watch" },
	];

	const found = checks.find((check) => check.regex.test(normalized));
	return found ? { kind: found.kind, detail: found.detail } : undefined;
}

function analyzeDirectWait(command: string): DirectWaitAnalysis | undefined {
	const normalized = command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	const match = detectDirectWaitPattern(normalized);
	if (!match) return undefined;
	if (isExplicitlyBackgrounded(normalized)) return { ...match, action: "allowed_backgrounded" };
	if (match.kind === "short sleep" && match.durationMs !== undefined && match.durationMs < DIRECT_SLEEP_BLOCK_THRESHOLD_MS) return { ...match, action: "allowed_short_sleep" };
	if (match.kind === "timeout-bounded command" && match.durationMs !== undefined && match.durationMs < DIRECT_TIMEOUT_BLOCK_THRESHOLD_MS) return { ...match, action: "allowed_short_timeout" };
	return { ...match, action: "blocked" };
}

function findDirectWait(command: string): DirectWaitMatch | undefined {
	const analysis = analyzeDirectWait(command);
	return analysis?.action === "blocked" ? analysis : undefined;
}

function suggestReturnOnForDirectWait(match: DirectWaitMatch): string {
	if (match.kind === "long sleep" && match.durationMs !== undefined) {
		const after = formatDuration(match.durationMs);
		return `Use a timer watcher: return_on({condition:{type:"timer", after:"${after}"}, resume:"continue"}).`;
	}
	if (match.kind === "streaming log wait") {
		return `Background the producer, then watch the log: return_on({condition:{type:"file", path:"<log>", contains:"<ready marker>", every:"2s"}, resume:"log ready"}).`;
	}
	if (match.kind === "foreground dev server" || match.kind === "foreground server") {
		return `Start the server in the background (& with pid+log capture) and watch its port: return_on({condition:{type:"port", port:<n>, host:"127.0.0.1", every:"500ms"}, resume:"server up"}).`;
	}
	if (match.kind === "repeated polling") {
		return `Replace the polling loop with a single watcher, e.g. return_on({condition:{type:"exec", command:"<check>", success:true, every:"5s"}, resume:"check passed"}).`;
	}
	if (match.kind === "infinite loop") {
		return `Replace the infinite loop with a return_on watcher (file/process/port/url/exec) so the turn can end and resume when the real condition flips.`;
	}
	if (match.kind === "timeout-bounded command") {
		return `Background the command (nohup ... > log 2>&1 & echo $! > pid) and watch the pid: return_on({condition:{type:"process", pidFile:".return-on/work.pid", state:"exited", every:"2s"}, resume:"work finished"}). The 'timeout N' cap blocks the turn for up to N; return_on lets the session end and resume on real completion.`;
	}
	if (match.kind === "ci watch") {
		return `Use an exec watcher that polls the run status: return_on({condition:{type:"exec", command:"gh run view <id> --json status --jq .status", contains:"completed", every:"30s"}, allowExec:true, resume:"ci run finished"}). 'gh run watch' / 'gh pr checks --watch' pins the turn until CI completes.`;
	}
	return `Background the work (& with pid+log capture) and call return_on on a file/process/port/url leaf for the readiness/completion signal.`;
}

function formatDirectWaitBlockReason(match: DirectWaitMatch): string {
	return [
		`Blocked direct wait (${match.kind}: ${match.detail}).`,
		"Do not keep the agent turn busy waiting.",
		suggestReturnOnForDirectWait(match),
		"Capture logs and pid under .return-on/ so the watcher can observe them.",
	].join(" ");
}

function redactCommand(command: string): string {
	return command
		.replace(/((?:token|api[_-]?key|secret|password|passwd|pwd)=)([^\s;&|]+)/gi, "$1[redacted]")
		.replace(/(Authorization:\s*Bearer\s+)[^\s'\"]+/gi, "$1[redacted]");
}

function truncateAuditText(input: string, maxLength = 500): string {
	return input.length > maxLength ? `${input.slice(0, maxLength - 1)}…` : input;
}

async function appendDirectWaitAudit(entry: DirectWaitAuditEntry): Promise<void> {
	try {
		await fsp.mkdir(STATE_DIR, { recursive: true });
		await fsp.appendFile(DIRECT_WAIT_AUDIT_FILE, `${JSON.stringify(entry)}\n`, "utf8");
	} catch (error) {
		console.error(`[${EXTENSION_NAME}] Failed to append direct wait audit entry:`, error);
	}
}

async function readDirectWaitAudit(limit = 50): Promise<DirectWaitAuditEntry[]> {
	try {
		const raw = await fsp.readFile(DIRECT_WAIT_AUDIT_FILE, "utf8");
		const lines = raw.split("\n").filter(Boolean);
		return lines.slice(-limit).flatMap((line) => {
			try {
				return [JSON.parse(line) as DirectWaitAuditEntry];
			} catch {
				return [];
			}
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`[${EXTENSION_NAME}] Failed to read direct wait audit:`, error);
		}
		return [];
	}
}

function formatDirectWaitAudit(entries: DirectWaitAuditEntry[]): string {
	if (entries.length === 0) return `No direct-wait audit entries found at ${DIRECT_WAIT_AUDIT_FILE}.`;
	const byAction = new Map<string, number>();
	const byKind = new Map<string, number>();
	for (const entry of entries) {
		byAction.set(entry.action, (byAction.get(entry.action) ?? 0) + 1);
		byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
	}
	const formatCounts = (counts: Map<string, number>) => [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key}=${count}`).join(", ");
	const recent = entries.slice(-15).map((entry) => {
		const duration = entry.durationMs !== undefined ? ` ${formatDuration(entry.durationMs)}` : "";
		return `- ${nowIso(entry.timestamp)} ${entry.action} ${entry.kind}${duration} ${entry.detail} cwd=${entry.cwd ?? "?"} cmd=${truncateAuditText(entry.command, 120)}`;
	}).join("\n");
	return [
		`Direct-wait audit (${entries.length} recent entries, file: ${DIRECT_WAIT_AUDIT_FILE})`,
		`By action: ${formatCounts(byAction)}`,
		`By kind: ${formatCounts(byKind)}`,
		"Recent:",
		recent,
	].join("\n");
}

async function loadJobs(): Promise<void> {
	try {
		const raw = await fsp.readFile(JOBS_FILE, "utf8");
		const parsed = JSON.parse(raw) as JobsState;
		jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`[${EXTENSION_NAME}] Failed to load jobs:`, error);
		}
		jobs = [];
	}
}

function atomicTempPath(target: string): string {
	return `${target}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
}

async function saveJobs(): Promise<void> {
	await fsp.mkdir(STATE_DIR, { recursive: true });
	const tmp = atomicTempPath(JOBS_FILE);
	await fsp.writeFile(tmp, JSON.stringify({ version: 1, jobs } satisfies JobsState, null, 2), "utf8");
	await fsp.rename(tmp, JOBS_FILE);
}

async function loadHandlers(): Promise<void> {
	try {
		const raw = await fsp.readFile(HANDLERS_FILE, "utf8");
		const parsed = JSON.parse(raw) as HandlersState;
		handlerRuns = Array.isArray(parsed.handlers) ? parsed.handlers : [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`[${EXTENSION_NAME}] Failed to load handler runs:`, error);
		}
		handlerRuns = [];
	}
}

async function saveHandlers(): Promise<void> {
	await fsp.mkdir(STATE_DIR, { recursive: true });
	const tmp = atomicTempPath(HANDLERS_FILE);
	await fsp.writeFile(tmp, JSON.stringify({ version: 1, handlers: handlerRuns.slice(-200) } satisfies HandlersState, null, 2), "utf8");
	await fsp.rename(tmp, HANDLERS_FILE);
}

async function appendLifecycleAudit(action: string, fields: Record<string, unknown> = {}): Promise<void> {
	try {
		await fsp.mkdir(STATE_DIR, { recursive: true });
		const entry = { version: 1, event: "return_on.lifecycle", timestamp: Date.now(), action, ...fields };
		await fsp.appendFile(LIFECYCLE_AUDIT_FILE, `${JSON.stringify(entry)}\n`, "utf8");
	} catch (error) {
		console.error(`[${EXTENSION_NAME}] Failed to append lifecycle audit:`, error);
	}
}

function firedEventPath(jobId: string, fireCount?: number): string {
	if (fireCount && fireCount > 1) return path.join(FIRED_DIR, `${jobId}.${fireCount}.json`);
	return path.join(FIRED_DIR, `${jobId}.json`);
}

async function writeFiredEvent(job: ReturnOnJob, reason: string, updates: Partial<Pick<FiredEventState, "deliveryStatus" | "deliveredAt" | "lastAttemptAt" | "handlerRunId" | "error">> = {}): Promise<string> {
	await fsp.mkdir(FIRED_DIR, { recursive: true });
	const eventPath = firedEventPath(job.id, job.fireCount);
	const event: FiredEventState = {
		version: 1,
		event: "return_on.fired",
		id: job.id,
		jobId: job.id,
		label: job.label,
		reason,
		createdAt: job.createdAt,
		firedAt: job.lastFiredAt ?? job.firedAt ?? Date.now(),
		cwd: job.cwd,
		...(job.sessionFile ? { sessionFile: job.sessionFile } : {}),
		resume: job.resume,
		job,
		deliveryStatus: updates.deliveryStatus ?? "pending",
		...(updates.deliveredAt ? { deliveredAt: updates.deliveredAt } : {}),
		...(updates.lastAttemptAt ? { lastAttemptAt: updates.lastAttemptAt } : {}),
		...(updates.handlerRunId ? { handlerRunId: updates.handlerRunId } : {}),
		...(updates.error ? { error: updates.error } : {}),
	};
	const tmp = `${eventPath}.${process.pid}.${Date.now()}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify(event, null, 2), "utf8");
	await fsp.rename(tmp, eventPath);
	return eventPath;
}

async function readFiredEventFiles(): Promise<Array<{ path: string; event: FiredEventState }>> {
	let entries: fs.Dirent[];
	try {
		entries = await fsp.readdir(FIRED_DIR, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const events: Array<{ path: string; event: FiredEventState }> = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const eventPath = path.join(FIRED_DIR, entry.name);
		try {
			const parsed = JSON.parse(await fsp.readFile(eventPath, "utf8")) as FiredEventState;
			if (parsed?.event === "return_on.fired") events.push({ path: eventPath, event: parsed });
		} catch (error) {
			console.error(`[${EXTENSION_NAME}] Failed to read fired event ${eventPath}:`, error);
		}
	}
	return events.sort((a, b) => (b.event.firedAt ?? 0) - (a.event.firedAt ?? 0));
}

async function readPendingFiredEvents(): Promise<Array<{ path: string; event: FiredEventState }>> {
	return (await readFiredEventFiles()).filter(({ event }) => !event.deliveredAt || event.deliveryStatus === "failed");
}

function terminalJobTime(job: ReturnOnJob): number | undefined {
	if (job.status === "fired") return job.firedAt ?? job.updatedAt;
	if (job.status === "cancelled") return job.cancelledAt ?? job.updatedAt;
	return undefined;
}

function parseNonNegativeNumber(value: string, name: string): number {
	if (!/^(?:\d+|\d*\.\d+)$/.test(value)) throw new Error(`${name} must be a non-negative number`);
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
	return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
	return parsed;
}

function parsePruneCommandArgs(args: string): PruneOptions {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	let dryRun = false;
	let retentionMs: number | undefined;
	let auditMaxEntries: number | undefined;
	for (const part of parts) {
		if (part === "--dry-run" || part === "dry-run" || part === "dryrun") {
			dryRun = true;
			continue;
		}
		if (part.startsWith("--days=")) {
			const days = parseNonNegativeNumber(part.slice("--days=".length), "--days");
			retentionMs = Math.round(days * 86_400_000);
			continue;
		}
		if (part.startsWith("--audit-max=")) {
			auditMaxEntries = parseNonNegativeInteger(part.slice("--audit-max=".length), "--audit-max");
			continue;
		}
		if (/^(?:\d+|\d*\.\d+)$/.test(part) && retentionMs === undefined) {
			retentionMs = Math.round(Number(part) * 86_400_000);
			continue;
		}
		throw new Error(`Unknown return_on prune argument: ${part}`);
	}
	return { dryRun, ...(retentionMs !== undefined ? { retentionMs } : {}), ...(auditMaxEntries !== undefined ? { auditMaxEntries } : {}) };
}

function formatPruneSummary(summary: PruneSummary): string {
	return [
		`return_on prune ${summary.dryRun ? "dry run" : "complete"}`,
		`Retention: ${formatDuration(summary.retentionMs)}; audit max entries: ${summary.auditMaxEntries}`,
		`Jobs pruned: ${summary.jobsPruned}`,
		`Fired events pruned: ${summary.firedEventsPruned}`,
		`Handlers pruned: ${summary.handlersPruned}; handler dirs pruned: ${summary.handlerDirsPruned}`,
		`Direct-wait audit entries pruned: ${summary.auditEntriesPruned}`,
	].join("\n");
}

async function pruneDirectWaitAudit(cutoff: number, maxEntries: number, dryRun: boolean): Promise<number> {
	let raw: string;
	try {
		raw = await fsp.readFile(DIRECT_WAIT_AUDIT_FILE, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
	const keptMalformed: string[] = [];
	const keptEntries: DirectWaitAuditEntry[] = [];
	let parsedCount = 0;
	for (const line of raw.split("\n").filter(Boolean)) {
		try {
			const entry = JSON.parse(line) as DirectWaitAuditEntry;
			parsedCount += 1;
			if (!entry.timestamp || entry.timestamp >= cutoff) keptEntries.push(entry);
		} catch {
			keptMalformed.push(line);
		}
	}
	const trimmedEntries = keptEntries.slice(-maxEntries);
	const pruned = parsedCount - trimmedEntries.length;
	if (!dryRun && pruned > 0) {
		await fsp.mkdir(STATE_DIR, { recursive: true });
		const tmp = atomicTempPath(DIRECT_WAIT_AUDIT_FILE);
		const lines = [...keptMalformed, ...trimmedEntries.map((entry) => JSON.stringify(entry))];
		await fsp.writeFile(tmp, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
		await fsp.rename(tmp, DIRECT_WAIT_AUDIT_FILE);
	}
	return pruned;
}

async function pruneState(options: PruneOptions = {}): Promise<PruneSummary> {
	const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
	const auditMaxEntries = options.auditMaxEntries ?? DEFAULT_AUDIT_MAX_ENTRIES;
	const dryRun = options.dryRun === true;
	const cutoff = Date.now() - retentionMs;
	const firedEvents = await readFiredEventFiles();
	const protectedJobIds = new Set(firedEvents.filter(({ event }) => !event.deliveredAt || event.deliveryStatus === "failed").map(({ event }) => event.jobId));

	let jobsPruned = 0;
	const keptJobs = jobs.filter((job) => {
		if (job.status === "active") return true;
		if (protectedJobIds.has(job.id)) return true;
		const terminalAt = terminalJobTime(job);
		const prune = terminalAt !== undefined && terminalAt < cutoff;
		if (prune) jobsPruned += 1;
		return !prune;
	});
	if (!dryRun && jobsPruned > 0) {
		jobs = keptJobs;
		await saveJobs();
	}

	let firedEventsPruned = 0;
	for (const { path: eventPath, event } of firedEvents) {
		const deliveredAt = event.deliveredAt;
		const prune = deliveredAt !== undefined && deliveredAt < cutoff && event.deliveryStatus !== "failed";
		if (!prune) continue;
		firedEventsPruned += 1;
		if (!dryRun) await fsp.rm(eventPath, { force: true });
	}

	let handlersPruned = 0;
	let handlerDirsPruned = 0;
	const keptHandlers = handlerRuns.filter((run) => {
		if (run.status === "starting" || run.status === "running") return true;
		const endedAt = run.endedAt ?? run.startedAt;
		const prune = endedAt < cutoff;
		if (prune) handlersPruned += 1;
		return !prune;
	});
	if (!dryRun && handlersPruned > 0) {
		const prunedRuns = handlerRuns.filter((run) => !keptHandlers.some((kept) => kept.id === run.id));
		for (const run of prunedRuns) {
			if (!isPathInside(HANDLERS_DIR, run.dir)) {
				console.error(`[${EXTENSION_NAME}] Refusing to prune handler dir outside state directory: ${run.dir}`);
				continue;
			}
			try {
				await fsp.rm(run.dir, { recursive: true, force: true });
				handlerDirsPruned += 1;
			} catch (error) {
				console.error(`[${EXTENSION_NAME}] Failed to remove handler dir ${run.dir}:`, error);
			}
		}
		handlerRuns = keptHandlers;
		await saveHandlers();
	} else if (dryRun) {
		handlerDirsPruned = handlerRuns.filter((run) => !keptHandlers.some((kept) => kept.id === run.id) && isPathInside(HANDLERS_DIR, run.dir)).length;
	}

	const auditEntriesPruned = await pruneDirectWaitAudit(cutoff, auditMaxEntries, dryRun);
	return { dryRun, retentionMs, auditMaxEntries, jobsPruned, firedEventsPruned, handlersPruned, handlerDirsPruned, auditEntriesPruned };
}

function firedEventMatchesCurrentSession(event: FiredEventState): boolean {
	const eventSession = event.sessionFile ?? event.job?.sessionFile;
	return !eventSession || !currentSessionFile || eventSession === currentSessionFile;
}

async function markFiredEventDelivered(eventPath: string, reason: string, status: FiredEventDeliveryStatus, job: ReturnOnJob, error?: unknown): Promise<void> {
	const now = Date.now();
	await writeFiredEvent(job, reason, {
		deliveryStatus: status,
		lastAttemptAt: now,
		...(status === "failed" ? {} : { deliveredAt: now }),
		...(job.handlerRunId ? { handlerRunId: job.handlerRunId } : {}),
		...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
	});
	if (eventPath !== firedEventPath(job.id)) {
		await fsp.rm(eventPath, { force: true });
	}
	await appendLifecycleAudit("delivery_marked", { jobId: job.id, label: job.label, reason, status, eventPath, handlerRunId: job.handlerRunId, error: error instanceof Error ? error.message : error ? String(error) : undefined });
}

async function deliverPendingFiredEvents(pi: ExtensionAPI): Promise<void> {
	const pending = await readPendingFiredEvents();
	for (const { path: eventPath, event } of pending) {
		if (!firedEventMatchesCurrentSession(event)) continue;
		const job = jobs.find((candidate) => candidate.id === event.jobId) ?? event.job;
		if (job.status === "cancelled") {
			await markFiredEventDelivered(eventPath, event.reason, "skipped-cancelled", job);
			continue;
		}
		let changed = false;
		if (job.status === "active") {
			job.status = "fired";
			job.firedAt = event.firedAt;
			job.updatedAt = event.firedAt;
			job.fireReason = event.reason;
			changed = true;
		}
		if (!jobs.some((candidate) => candidate.id === job.id)) {
			jobs.push(job);
			changed = true;
		}
		if (changed) await saveJobs();
		try {
			const delivery = job.delivery ?? normalizeDelivery(undefined);
			if (delivery.mode === "fork") {
				const launched = await launchReturnHandler(pi, job, event.reason, delivery);
				if (launched) {
					await markFiredEventDelivered(eventPath, event.reason, "handler-launched", job);
					continue;
				}
			}
			pi.sendMessage(
				{
					customType: EXTENSION_NAME,
					content: formatFireMessage(job, event.reason),
					display: true,
					details: { id: job.id, label: job.label, reason: event.reason, latches: job.latches, firedEventPath: eventPath },
				},
				{ triggerTurn: true },
			);
			await markFiredEventDelivered(eventPath, event.reason, "wake-sent", job);
		} catch (error) {
			await markFiredEventDelivered(eventPath, event.reason, "failed", job, error);
			console.error(`[${EXTENSION_NAME}] Failed to deliver fired event ${eventPath}:`, error);
		}
	}
}

function activeJobsForCurrentSession(): ReturnOnJob[] {
	return jobs.filter((job) => job.status === "active" && jobVisibleForSession(job, currentSessionFile));
}

function updateStatus(ctx = latestCtx): void {
	if (!ctx?.hasUI) return;
	const active = activeJobsForCurrentSession();
	ctx.ui.setStatus(EXTENSION_NAME, active.length > 0 ? formatStatusTag(active, ctx.ui.theme) : undefined);
}

function startTicker(pi: ExtensionAPI): void {
	if (tickTimer) return;
	tickTimer = setInterval(() => {
		void tick(pi);
	}, DEFAULT_TICK_MS);
	tickTimer.unref?.();
}

function stopTicker(): void {
	if (tickTimer) clearInterval(tickTimer);
	tickTimer = undefined;
}

function requestImmediateTick(pi: ExtensionAPI): void {
	if (immediateTickTimer) return;
	immediateTickTimer = setTimeout(() => {
		immediateTickTimer = undefined;
		void tick(pi);
	}, 0);
	immediateTickTimer.unref?.();
}

function stopFileWatchers(): void {
	for (const watcher of fileWatchers.values()) watcher.close();
	fileWatchers = new Map();
	fileWatchSignature = "";
}

function stopIncomingWebhookServer(): void {
	incomingWebhookServer?.close();
	incomingWebhookServer = undefined;
	incomingWebhookServerStarting = undefined;
}

function ensureTicker(pi: ExtensionAPI): void {
	const active = activeJobsForCurrentSession();
	if (active.length > 0) {
		startTicker(pi);
		reconcileFileWatchers(pi);
		if (active.some((job) => conditionHasIncomingWebhook(job.condition))) void ensureIncomingWebhookServer(pi);
		else stopIncomingWebhookServer();
	} else {
		stopTicker();
		stopFileWatchers();
		stopIncomingWebhookServer();
	}
	updateStatus();
}

function normalizeWebhook(input: unknown): WebhookConfig | undefined {
	if (input === undefined || input === null || input === false) return undefined;
	const config: WebhookConfig = typeof input === "string" ? { url: input } : isObject(input) ? { ...(input as Record<string, unknown>) } as unknown as WebhookConfig : (() => { throw new Error("webhook must be a URL string or object"); })();
	if (typeof config.url !== "string" || !config.url.trim()) throw new Error("webhook requires url");
	const parsed = new URL(config.url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("webhook url must use http or https");
	if (config.method !== undefined && typeof config.method !== "string") throw new Error("webhook method must be a string");
	if (config.headers !== undefined) {
		if (!isObject(config.headers)) throw new Error("webhook headers must be an object");
		config.headers = Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, String(value)]));
	}
	return config;
}

function normalizeDelivery(input: unknown, config?: Pick<ReturnOnConfig, "defaultDeliveryMode" | "defaultDeliveryNotify" | "triggerParentOnSummary">): DeliveryConfig {
	const base: DeliveryConfig = {
		mode: config?.defaultDeliveryMode ?? (process.env.PI_RETURN_ON_DELIVERY_MODE === "fork" ? "fork" : "wake"),
		notify: config?.defaultDeliveryNotify ?? "summary",
		triggerParentOnSummary: config?.triggerParentOnSummary ?? (process.env.PI_RETURN_ON_TRIGGER_PARENT_ON_SUMMARY === undefined ? true : process.env.PI_RETURN_ON_TRIGGER_PARENT_ON_SUMMARY === "1"),
	};
	if (input === undefined || input === null || input === false) return base;
	if (input === true) return { ...base, mode: "fork" };
	if (typeof input === "string") {
		if (input !== "wake" && input !== "fork") throw new Error("delivery string must be 'wake' or 'fork'");
		return { ...base, mode: input };
	}
	if (!isObject(input)) throw new Error("delivery must be an object, boolean, or 'wake'/'fork'");
	const mode = input.mode === undefined ? base.mode : input.mode;
	if (mode !== "wake" && mode !== "fork") throw new Error("delivery.mode must be 'wake' or 'fork'");
	const notify = input.notify === undefined ? base.notify : input.notify;
	if (notify !== "ack-and-summary" && notify !== "summary" && notify !== "none") throw new Error("delivery.notify must be 'ack-and-summary', 'summary', or 'none'");
	const triggerParentOnSummary = input.triggerParentOnSummary === undefined ? base.triggerParentOnSummary : Boolean(input.triggerParentOnSummary);
	const piCommand = input.piCommand === undefined ? undefined : String(input.piCommand).trim();
	return {
		mode,
		notify,
		triggerParentOnSummary,
		...(piCommand ? { piCommand } : {}),
	};
}

export function normalizeCondition(input: unknown): Condition {
	if (typeof input === "string") {
		const trimmed = input.trim();
		if (trimmed.startsWith("{")) {
			try {
				input = JSON.parse(trimmed);
			} catch (error) {
				throw new Error(`condition was a string but not valid JSON: ${(error as Error).message}`);
			}
		} else if (parseDuration(trimmed) !== undefined) {
			return normalizeCondition({ type: "timer", after: trimmed });
		}
	}
	if (!isObject(input)) throw new Error("condition must be an object (or a JSON-encoded object string)");
	let conditionInput = input as Record<string, any>;
	if (Array.isArray(conditionInput.any)) {
		if (conditionInput.any.length === 0) throw new Error("any group requires children");
		return { op: "or", children: conditionInput.any.map(normalizeCondition) };
	}
	if (Array.isArray(conditionInput.all)) {
		if (conditionInput.all.length === 0) throw new Error("all group requires children");
		return { op: "and", children: conditionInput.all.map(normalizeCondition) };
	}
	if (conditionInput.not !== undefined) return { op: "not", children: [normalizeCondition(conditionInput.not)] };
	if (typeof conditionInput.op === "string") {
		const op = conditionInput.op.toLowerCase();
		if (op !== "and" && op !== "or" && op !== "not") throw new Error(`unsupported group op '${conditionInput.op}'`);
		const childrenInput = Array.isArray(conditionInput.children) ? conditionInput.children : [];
		if (op !== "not" && childrenInput.length === 0) throw new Error(`${op} group requires children`);
		if (op === "not" && childrenInput.length !== 1) throw new Error("not group requires exactly one child");
		return { ...conditionInput, op, children: childrenInput.map(normalizeCondition) } as Condition;
	}
	if (conditionInput.type === undefined) {
		if (typeof conditionInput.timer === "string" || typeof conditionInput.timer === "number") {
			const { timer, ...rest } = conditionInput;
			return normalizeCondition({ ...rest, type: "timer", after: timer });
		}
		if (typeof conditionInput.exec === "string") {
			const { exec, ...rest } = conditionInput;
			return normalizeCondition({ ...rest, type: "exec", command: exec });
		}
		if (typeof conditionInput.file === "string") {
			const { file, ...rest } = conditionInput;
			return normalizeCondition({ ...rest, type: "file", path: file });
		}
		if (typeof conditionInput.port === "number") return normalizeCondition({ ...conditionInput, type: "port" });
		if (typeof conditionInput.url === "string") return normalizeCondition({ ...conditionInput, type: "url" });
		if (conditionInput.timer !== undefined && !isObject(conditionInput.timer)) throw new Error("timer shorthand requires a duration string or number");
		if (conditionInput.exec !== undefined && !isObject(conditionInput.exec)) throw new Error("exec shorthand requires a command string");
		const WRAPPER_LEAF_KEYS = ["file", "process", "port", "url", "webhook", "exec", "timer"] as const;
		const wrapperKeys = WRAPPER_LEAF_KEYS.filter((wrapperKey) => isObject(conditionInput[wrapperKey]));
		if (wrapperKeys.length > 1) throw new Error(`condition uses multiple leaf wrappers: ${wrapperKeys.join(", ")}`);
		const wrapperKey = wrapperKeys[0];
		if (wrapperKey) {
			const { [wrapperKey]: wrapped, ...rest } = conditionInput;
			return normalizeCondition({ ...(wrapped as Record<string, unknown>), ...rest, type: wrapperKey });
		}
		const keys = Object.keys(conditionInput);
		const keyList = keys.length === 0 ? "none" : keys.join(", ");
		throw new Error(
			`unsupported condition: no 'type' field (got keys: ${keyList}). ` +
			"Use {type:'file'|'timer'|'exec'|'process'|'port'|'url'|'webhook', ...} " +
			"or a group shorthand {any:[...]}/{all:[...]}/{not:{...}}/{op,children:[...]}.",
		);
	}
	if (conditionInput.type === "timer") {
		const timer = { ...conditionInput } as TimerCondition & { duration?: string | number };
		if (timer.after === undefined && timer.at === undefined && timer.duration !== undefined) timer.after = timer.duration;
		if (timer.after === undefined && timer.at === undefined) throw new Error("timer condition requires after, at, or duration");
		return timer;
	}
	if (conditionInput.type === "file") {
		if (typeof conditionInput.path !== "string" || !conditionInput.path.trim()) throw new Error("file condition requires path");
		return conditionInput as FileCondition;
	}
	if (conditionInput.type === "exec") {
		if (conditionInput.command === undefined && typeof conditionInput.cmd === "string") {
			const { cmd, ...rest } = conditionInput;
			conditionInput = { ...rest, command: cmd };
		}
		if (typeof conditionInput.command !== "string" && typeof conditionInput.code !== "string") {
			throw new Error("exec condition requires command or code (or cmd as a compatibility alias for command)");
		}
		for (const field of ["runner", "shell"] as const) {
			const runner = conditionInput[field];
			if (runner !== undefined && (!SUPPORTED_RUNNERS.has(runner as Runner) || typeof runner !== "string")) {
				throw new Error(`unsupported exec ${field} '${String(runner)}'`);
			}
		}
		return conditionInput as ExecCondition;
	}
	if (conditionInput.type === "process") {
		if (conditionInput.state === undefined && conditionInput.status !== undefined) {
			if (conditionInput.status !== "running" && conditionInput.status !== "exited") throw new Error("process condition status must be 'running' or 'exited'");
			conditionInput = { ...conditionInput, state: conditionInput.status };
		}
		if (conditionInput.pid !== undefined && (typeof conditionInput.pid !== "number" || !Number.isInteger(conditionInput.pid) || conditionInput.pid <= 0)) {
			throw new Error("process condition pid must be a positive integer");
		}
		if (conditionInput.pidFile !== undefined && (typeof conditionInput.pidFile !== "string" || !conditionInput.pidFile.trim())) {
			throw new Error("process condition pidFile must be a non-empty string");
		}
		if (
			conditionInput.pid === undefined
			&& conditionInput.pidFile === undefined
			&& typeof conditionInput.name !== "string"
			&& typeof conditionInput.commandContains !== "string"
			&& typeof conditionInput.matches !== "string"
		) {
			throw new Error("process condition requires pid, pidFile, name, commandContains, or matches");
		}
		return conditionInput as ProcessCondition;
	}
	if (conditionInput.type === "port") {
		if (typeof conditionInput.port !== "number" || !Number.isInteger(conditionInput.port) || conditionInput.port <= 0 || conditionInput.port > 65535) {
			throw new Error("port condition requires port between 1 and 65535");
		}
		return conditionInput as PortCondition;
	}
	if (conditionInput.type === "url") {
		if (typeof conditionInput.url !== "string" || !conditionInput.url.trim()) throw new Error("url condition requires url");
		try {
			new URL(conditionInput.url);
		} catch {
			throw new Error(`url condition has invalid url '${String(conditionInput.url)}'`);
		}
		return conditionInput as UrlCondition;
	}
	if (conditionInput.type === "webhook") {
		if (conditionInput.path !== undefined && (typeof conditionInput.path !== "string" || !conditionInput.path.startsWith("/"))) throw new Error("webhook condition path must start with '/'");
		if (conditionInput.token !== undefined && typeof conditionInput.token !== "string") throw new Error("webhook condition token must be a string");
		if (conditionInput.method !== undefined && typeof conditionInput.method !== "string") throw new Error("webhook condition method must be a string");
		return conditionInput as IncomingWebhookCondition;
	}
	throw new Error(`unsupported condition type '${String(conditionInput.type)}'`);
}

function isGroupCondition(condition: Condition): condition is GroupCondition {
	return "op" in condition;
}

function prepareIncomingWebhooks(condition: Condition): void {
	if (isGroupCondition(condition)) {
		condition.children.forEach(prepareIncomingWebhooks);
		return;
	}
	if (condition.type !== "webhook") return;
	condition.path ??= `/return-on/${makeToken(8)}`;
	condition.token ??= makeToken(16);
	condition.method ??= "POST";
}

function walkConditionLeaves(condition: Condition, visit: (leaf: Exclude<Condition, GroupCondition>, key: string) => void, key = "root"): void {
	if (isGroupCondition(condition)) {
		condition.children.forEach((child, index) => walkConditionLeaves(child, visit, `${key}.${index}`));
		return;
	}
	visit(condition as Exclude<Condition, GroupCondition>, key);
}

export function collectFileWatchTargets(job: ReturnOnJob, condition = job.condition, key = "root", targets: FileWatchTarget[] = []): FileWatchTarget[] {
	walkConditionLeaves(condition, (leaf, leafKey) => {
		if (leaf.type !== "file") return;
		const filePath = path.resolve(job.cwd, leaf.path);
		targets.push({ jobId: job.id, key: leafKey, filePath, dir: path.dirname(filePath), basename: path.basename(filePath) });
	}, key);
	return targets;
}

function reconcileFileWatchers(pi: ExtensionAPI): void {
	const targets = activeJobsForCurrentSession().flatMap((job) => collectFileWatchTargets(job));
	const groups = new Map<string, FileWatchTarget[]>();
	for (const target of targets) {
		const group = groups.get(target.dir) ?? [];
		group.push(target);
		groups.set(target.dir, group);
	}
	const signature = [...groups.entries()]
		.map(([dir, group]) => `${dir}\0${group.map((target) => `${target.jobId}:${target.key}:${target.basename}`).sort().join("|")}`)
		.sort()
		.join("\n");
	if (signature === fileWatchSignature) return;
	stopFileWatchers();
	fileWatchSignature = signature;

	for (const [dir, group] of groups) {
		try {
			const watcher = fs.watch(dir, (_event, filename) => {
				const changedName = filename ? path.basename(filename.toString()) : undefined;
				for (const target of group) {
					if (changedName && changedName !== target.basename) continue;
					const job = jobs.find((candidate) => candidate.id === target.jobId && candidate.status === "active");
					if (!job) continue;
					const state = job.leafState[target.key] ??= {};
					state.lastCheckAt = 0;
				}
				requestImmediateTick(pi);
			});
			watcher.on("error", () => {
				watcher.close();
				fileWatchers.delete(dir);
			});
			fileWatchers.set(dir, watcher);
		} catch {
			// Fall back to the normal polling ticker when native file watching is unavailable.
		}
	}
}

export function collectIncomingWebhookTargets(job: ReturnOnJob, condition = job.condition, key = "root", targets: IncomingWebhookTarget[] = []): IncomingWebhookTarget[] {
	walkConditionLeaves(condition, (leaf, leafKey) => {
		if (leaf.type === "webhook") targets.push({ jobId: job.id, key: leafKey, condition: leaf });
	}, key);
	return targets;
}

export function collectConditionLeafTargets(condition: Condition, key = "root", targets: ConditionLeafTarget[] = []): ConditionLeafTarget[] {
	walkConditionLeaves(condition, (leaf, leafKey) => {
		targets.push({ key: leafKey, condition: leaf });
	}, key);
	return targets;
}

function conditionHasExec(condition: Condition): boolean {
	if ("type" in condition && condition.type === "exec") return true;
	if (isGroupCondition(condition)) return condition.children.some(conditionHasExec);
	return false;
}

function conditionHasIncomingWebhook(condition: Condition): boolean {
	if ("type" in condition && condition.type === "webhook") return true;
	if (isGroupCondition(condition)) return condition.children.some(conditionHasIncomingWebhook);
	return false;
}

function conditionIsTimerOnly(condition: Condition): boolean {
	if (isGroupCondition(condition)) {
		if (condition.children.length === 0) return false;
		return condition.children.every(conditionIsTimerOnly);
	}
	return "type" in condition && condition.type === "timer";
}

function truncateText(value: string, limit = OUTPUT_LIMIT_BYTES): string {
	const buf = Buffer.from(value);
	if (buf.length <= limit) return value;
	return `${buf.subarray(0, limit).toString("utf8")}\n[truncated ${buf.length - limit} bytes]`;
}

function matchingFileLines(text: string, condition: FileCondition): Array<{ line: number; text: string }> {
	if (condition.contains === undefined && condition.matches === undefined) return [];
	const matcher = condition.matches !== undefined ? new RegExp(condition.matches) : undefined;
	const result: Array<{ line: number; text: string }> = [];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const contains = condition.contains !== undefined && line.includes(condition.contains);
		const matches = matcher !== undefined && matcher.test(line);
		if (contains || matches) result.push({ line: index + 1, text: truncateText(line, 500) });
		if (result.length >= 5) break;
	}
	return result;
}

async function evaluateCondition(job: ReturnOnJob, condition: Condition, key = "root", latchLeaves = true): Promise<EvalResult> {
	if (isGroupCondition(condition)) {
		const op = condition.op;
		const children = condition.children;
		if (op === "not") {
			const child = children[0]
				? await evaluateCondition(job, children[0], `${key}.0`, false)
				: { value: false, summary: "missing child" };
			return { value: !child.value, summary: `NOT(${child.summary})`, details: child };
		}
		const childResults = await Promise.all(children.map((child, index) => evaluateCondition(job, child, `${key}.${index}`, latchLeaves)));
		if (op === "and") {
			const value = childResults.every((result) => result.value);
			return { value, summary: `AND(${childResults.map((r) => r.summary).join("; ")})`, details: childResults };
		}
		const value = childResults.some((result) => result.value);
		return { value, summary: `OR(${childResults.map((r) => r.summary).join("; ")})`, details: childResults };
	}

	const latched = latchLeaves ? job.latches[key] : undefined;
	if (latched) return { value: true, summary: latched.summary, details: latched.details };

	let result: EvalResult;
	if (condition.type === "timer") result = evaluateTimer(job, condition);
	else if (condition.type === "file") result = await evaluateFile(job, condition, key);
	else if (condition.type === "exec") result = await evaluateExec(job, condition, key);
	else if (condition.type === "process") result = await evaluateProcess(job, condition, key);
	else if (condition.type === "port") result = await evaluatePort(job, condition, key);
	else if (condition.type === "url") result = await evaluateUrl(job, condition, key);
	else if (condition.type === "webhook") result = evaluateIncomingWebhook(job, condition, key);
	else result = { value: false, summary: `unknown leaf ${(condition as { type?: string }).type}` };

	if (latchLeaves && result.value) {
		job.latches[key] = { trueAt: Date.now(), summary: result.summary, details: result.details };
		job.updatedAt = Date.now();
	}
	return result;
}

function evaluateIncomingWebhook(job: ReturnOnJob, condition: IncomingWebhookCondition, key: string): EvalResult {
	const state = job.leafState[key] ??= {};
	return { value: state.lastValue ?? false, summary: state.lastSummary ?? `waiting for incoming webhook ${condition.path ?? ""}` };
}

function evaluateTimer(job: ReturnOnJob, condition: TimerCondition): EvalResult {
	const afterMs = parseDuration(condition.after);
	const afterAt = afterMs !== undefined ? job.createdAt + afterMs : undefined;
	const at = parseAt(condition.at, job.createdAt);
	const target = afterAt ?? at;
	if (!target) return { value: false, summary: "timer missing after/at" };
	const remaining = target - Date.now();
	return remaining <= 0
		? { value: true, summary: `timer elapsed (${nowIso(target)})` }
		: { value: false, summary: `timer pending ${formatDuration(remaining)}` };
}

async function evaluateFile(job: ReturnOnJob, condition: FileCondition, key: string): Promise<EvalResult> {
	const state = job.leafState[key] ??= {};
	const everyMs = getPollingInterval(job, condition.every, DEFAULT_FILE_EVERY_MS);
	const now = Date.now();
	if (state.lastCheckAt && now - state.lastCheckAt < everyMs) {
		return { value: state.lastValue ?? false, summary: state.lastSummary ?? "file check waiting for interval" };
	}
	state.lastCheckAt = now;

	const filePath = path.resolve(job.cwd, condition.path);
	let stat: fs.Stats | undefined;
	try {
		stat = await fsp.stat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const checks: Array<{ ok: boolean; label: string }> = [];
	const explicitExists = condition.exists;
	const shouldRequireExists = explicitExists !== false && !condition.deleted;
	if (condition.deleted) checks.push({ ok: !stat, label: `${condition.path} deleted` });
	else if (explicitExists === false) checks.push({ ok: !stat, label: `${condition.path} absent` });
	else if (explicitExists === true || shouldRequireExists) checks.push({ ok: !!stat, label: `${condition.path} exists` });

	if (condition.changed) {
		if (!stat) {
			checks.push({ ok: false, label: `${condition.path} changed` });
		} else if (state.lastMtimeMs === undefined) {
			state.lastMtimeMs = stat.mtimeMs;
			checks.push({ ok: false, label: `${condition.path} changed` });
		} else {
			checks.push({ ok: stat.mtimeMs !== state.lastMtimeMs, label: `${condition.path} changed` });
			state.lastMtimeMs = stat.mtimeMs;
		}
	}

	if (condition.stableFor !== undefined) {
		const stableForMs = parseDuration(condition.stableFor, 0) ?? 0;
		if (!stat) {
			state.stableSince = undefined;
			checks.push({ ok: false, label: `${condition.path} stable for ${formatDuration(stableForMs)}` });
		} else {
			if (state.lastMtimeMs !== stat.mtimeMs) {
				state.lastMtimeMs = stat.mtimeMs;
				state.stableSince = now;
			} else if (state.stableSince === undefined) {
				state.stableSince = now;
			}
			checks.push({ ok: now - (state.stableSince ?? now) >= stableForMs, label: `${condition.path} stable for ${formatDuration(stableForMs)}` });
		}
	}

	let matchDetails: Record<string, unknown> | undefined;
	if (condition.contains !== undefined || condition.matches !== undefined) {
		let text = "";
		try {
			text = await fsp.readFile(filePath, "utf8");
		} catch {
			text = "";
		}
		if (condition.contains !== undefined) checks.push({ ok: text.includes(condition.contains), label: `${condition.path} contains '${condition.contains}'` });
		if (condition.matches !== undefined) checks.push({ ok: new RegExp(condition.matches).test(text), label: `${condition.path} matches /${condition.matches}/` });
		matchDetails = {
			sizeBytes: Buffer.byteLength(text),
			...(condition.contains !== undefined ? { contains: condition.contains } : {}),
			...(condition.matches !== undefined ? { matches: condition.matches } : {}),
			matchedLines: matchingFileLines(text, condition),
		};
	}

	const ok = checks.length > 0 && checks.every((check) => check.ok);
	const summary = checks.map((check) => `${check.ok ? "✓" : "·"} ${check.label}`).join(", ") || `file ${condition.path}`;
	state.lastSummary = summary;
	state.lastValue = ok;
	return { value: ok, summary, details: { path: filePath, ...matchDetails } };
}

async function evaluateExec(job: ReturnOnJob, condition: ExecCondition, key: string): Promise<EvalResult> {
	const state = job.leafState[key] ??= {};
	const everyMs = getPollingInterval(job, condition.every, DEFAULT_EXEC_EVERY_MS, MIN_EXEC_EVERY_MS);
	const now = Date.now();
	if (state.lastCheckAt && now - state.lastCheckAt < everyMs) {
		return { value: state.lastValue ?? false, summary: state.lastSummary ?? "exec check waiting for interval" };
	}
	state.lastCheckAt = now;

	const timeoutMs = parseDuration(condition.timeout, DEFAULT_EXEC_TIMEOUT_MS) ?? DEFAULT_EXEC_TIMEOUT_MS;
	const runner = condition.runner ?? condition.shell ?? "sh";
	const { command, args, display } = buildExecArgs(runner, condition);
	const proc = await runProcess(command, args, { cwd: job.cwd, timeoutMs });
	const output = `${proc.stdout}\n${proc.stderr}`;
	const checks: Array<{ ok: boolean; label: string }> = [];
	const hasExplicit = condition.success !== undefined || condition.failure !== undefined || condition.exitCode !== undefined
		|| condition.stdoutContains !== undefined || condition.stderrContains !== undefined || condition.outputContains !== undefined
		|| condition.stdoutMatches !== undefined || condition.stderrMatches !== undefined || condition.outputMatches !== undefined;
	if (!hasExplicit || condition.success === true) checks.push({ ok: proc.code === 0, label: "exit 0" });
	if (condition.failure === true) checks.push({ ok: proc.code !== 0, label: "non-zero exit" });
	if (condition.exitCode !== undefined) checks.push({ ok: proc.code === condition.exitCode, label: `exit ${condition.exitCode}` });
	if (condition.stdoutContains !== undefined) checks.push({ ok: proc.stdout.includes(condition.stdoutContains), label: `stdout contains '${condition.stdoutContains}'` });
	if (condition.stderrContains !== undefined) checks.push({ ok: proc.stderr.includes(condition.stderrContains), label: `stderr contains '${condition.stderrContains}'` });
	if (condition.outputContains !== undefined) checks.push({ ok: output.includes(condition.outputContains), label: `output contains '${condition.outputContains}'` });
	if (condition.stdoutMatches !== undefined) checks.push({ ok: new RegExp(condition.stdoutMatches).test(proc.stdout), label: `stdout matches /${condition.stdoutMatches}/` });
	if (condition.stderrMatches !== undefined) checks.push({ ok: new RegExp(condition.stderrMatches).test(proc.stderr), label: `stderr matches /${condition.stderrMatches}/` });
	if (condition.outputMatches !== undefined) checks.push({ ok: new RegExp(condition.outputMatches).test(output), label: `output matches /${condition.outputMatches}/` });

	const ok = checks.every((check) => check.ok);
	const summary = `${display} => code ${proc.code}${proc.timedOut ? " (timed out)" : ""}; ${checks.map((check) => `${check.ok ? "✓" : "·"} ${check.label}`).join(", ")}`;
	state.lastSummary = summary;
	state.lastValue = ok;
	return {
		value: ok,
		summary,
		details: { code: proc.code, timedOut: proc.timedOut, stdout: truncateText(proc.stdout), stderr: truncateText(proc.stderr) },
	};
}

async function readPidFromFile(job: ReturnOnJob, pidFile: string): Promise<number | undefined> {
	const resolved = path.resolve(job.cwd, pidFile);
	try {
		const contents = await fsp.readFile(resolved, "utf8");
		const match = contents.match(/-?\d+/);
		if (!match) return undefined;
		const pid = Number.parseInt(match[0], 10);
		if (!Number.isInteger(pid) || pid <= 0) return undefined;
		return pid;
	} catch {
		return undefined;
	}
}

async function evaluateProcess(job: ReturnOnJob, condition: ProcessCondition, key: string): Promise<EvalResult> {
	const state = job.leafState[key] ??= {};
	const everyMs = getPollingInterval(job, condition.every, DEFAULT_PROCESS_EVERY_MS);
	const now = Date.now();
	if (state.lastCheckAt && now - state.lastCheckAt < everyMs) {
		return { value: state.lastValue ?? false, summary: state.lastSummary ?? "process check waiting for interval" };
	}
	state.lastCheckAt = now;

	const wantsRunning = condition.exited === true || condition.state === "exited" ? false : condition.running ?? true;
	const target = wantsRunning ? "running" : "exited";

	let effective: ProcessCondition = condition;
	let resolvedPid: number | undefined;
	if (condition.pid === undefined && condition.pidFile !== undefined) {
		resolvedPid = await readPidFromFile(job, condition.pidFile);
		if (resolvedPid === undefined) {
			const running = false;
			const ok = wantsRunning ? running : true;
			const summary = `pidFile '${condition.pidFile}' missing or empty; target ${target}`;
			state.lastSummary = summary;
			state.lastValue = ok;
			return { value: ok, summary, details: { running, target, pidFile: condition.pidFile } };
		}
		effective = { ...condition, pid: resolvedPid };
	}

	const running = await isProcessRunning(effective);
	const ok = wantsRunning ? running : !running;
	const subject = effective.pid !== undefined
		? condition.pidFile !== undefined ? `pidFile '${condition.pidFile}' (pid ${effective.pid})` : `pid ${effective.pid}`
		: condition.name
			? `process name '${condition.name}'`
			: condition.commandContains
				? `command contains '${condition.commandContains}'`
				: `process matches /${condition.matches}/`;
	const summary = `${subject} is ${running ? "running" : "not running"}; target ${target}`;
	state.lastSummary = summary;
	state.lastValue = ok;
	return { value: ok, summary, details: { running, target, ...(resolvedPid !== undefined ? { pidFile: condition.pidFile, resolvedPid } : {}) } };
}

async function isProcessRunning(condition: ProcessCondition): Promise<boolean> {
	if (condition.pid !== undefined) {
		try {
			process.kill(condition.pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	let matcher: RegExp | undefined;
	if (condition.matches) matcher = new RegExp(condition.matches);
	try {
		const entries = await fsp.readdir("/proc", { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
			const procDir = path.join("/proc", entry.name);
			let comm = "";
			let cmdline = "";
			try {
				comm = (await fsp.readFile(path.join(procDir, "comm"), "utf8")).trim();
			} catch {
				// Ignore processes that exit or deny reads while scanning.
			}
			try {
				cmdline = (await fsp.readFile(path.join(procDir, "cmdline"), "utf8")).replace(/\0/g, " ").trim();
			} catch {
				// Ignore processes that exit or deny reads while scanning.
			}
			const haystack = `${comm}\n${cmdline}`;
			if (condition.name && comm === condition.name) return true;
			if (condition.commandContains && cmdline.includes(condition.commandContains)) return true;
			if (matcher?.test(haystack)) return true;
		}
	} catch {
		return false;
	}
	return false;
}

async function evaluatePort(job: ReturnOnJob, condition: PortCondition, key: string): Promise<EvalResult> {
	const state = job.leafState[key] ??= {};
	const everyMs = getPollingInterval(job, condition.every, DEFAULT_PORT_EVERY_MS);
	const now = Date.now();
	if (state.lastCheckAt && now - state.lastCheckAt < everyMs) {
		return { value: state.lastValue ?? false, summary: state.lastSummary ?? "port check waiting for interval" };
	}
	state.lastCheckAt = now;

	const host = condition.host ?? "127.0.0.1";
	const timeoutMs = parseDuration(condition.timeout, DEFAULT_PORT_TIMEOUT_MS) ?? DEFAULT_PORT_TIMEOUT_MS;
	const open = await isPortOpen(host, condition.port, timeoutMs);
	const wantsOpen = condition.closed === true ? false : condition.open !== false;
	const ok = wantsOpen ? open : !open;
	const summary = `${host}:${condition.port} is ${open ? "open" : "closed"}; target ${wantsOpen ? "open" : "closed"}`;
	state.lastSummary = summary;
	state.lastValue = ok;
	return { value: ok, summary, details: { host, port: condition.port, open } };
}

function isPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host, port });
		let settled = false;
		const finish = (open: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(timeoutMs, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function evaluateUrl(job: ReturnOnJob, condition: UrlCondition, key: string): Promise<EvalResult> {
	const state = job.leafState[key] ??= {};
	const everyMs = getPollingInterval(job, condition.every, DEFAULT_URL_EVERY_MS);
	const now = Date.now();
	if (state.lastCheckAt && now - state.lastCheckAt < everyMs) {
		return { value: state.lastValue ?? false, summary: state.lastSummary ?? "url check waiting for interval" };
	}
	state.lastCheckAt = now;

	const timeoutMs = parseDuration(condition.timeout, DEFAULT_URL_TIMEOUT_MS) ?? DEFAULT_URL_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();
	try {
		const response = await fetch(condition.url, { method: condition.method ?? "GET", signal: controller.signal });
		let body = "";
		const needsBody = condition.bodyContains !== undefined || condition.bodyMatches !== undefined;
		if (needsBody) body = truncateText(await response.text());
		const checks: Array<{ ok: boolean; label: string }> = [];
		if (condition.status !== undefined) {
			const statuses = Array.isArray(condition.status) ? condition.status : [condition.status];
			checks.push({ ok: statuses.includes(response.status), label: `status in ${statuses.join(",")}` });
		} else if (condition.ok !== false) {
			checks.push({ ok: response.ok, label: "2xx status" });
		} else {
			checks.push({ ok: !response.ok, label: "non-2xx status" });
		}
		if (condition.bodyContains !== undefined) checks.push({ ok: body.includes(condition.bodyContains), label: `body contains '${condition.bodyContains}'` });
		if (condition.bodyMatches !== undefined) checks.push({ ok: new RegExp(condition.bodyMatches).test(body), label: `body matches /${condition.bodyMatches}/` });
		const ok = checks.every((check) => check.ok);
		const summary = `${condition.url} => ${response.status}; ${checks.map((check) => `${check.ok ? "✓" : "·"} ${check.label}`).join(", ")}`;
		state.lastSummary = summary;
		state.lastValue = ok;
		return { value: ok, summary, details: { status: response.status, ok: response.ok, body } };
	} catch (error) {
		const summary = `${condition.url} request failed: ${error instanceof Error ? error.message : String(error)}`;
		state.lastSummary = summary;
		state.lastValue = false;
		return { value: false, summary };
	} finally {
		clearTimeout(timer);
	}
}

function buildExecArgs(runner: Runner, condition: ExecCondition): { command: string; args: string[]; display: string } {
	if (condition.code !== undefined) {
		if (runner === "python") return { command: "python3", args: ["-c", condition.code], display: "python -c <code>" };
		if (runner === "node") return { command: "node", args: ["-e", condition.code], display: "node -e <code>" };
		if (runner === "xonsh") return { command: "xonsh", args: ["-c", condition.code], display: "xonsh -c <code>" };
		if (runner === "bash") return { command: "bash", args: ["-lc", condition.code], display: "bash -lc <code>" };
		return { command: "sh", args: ["-lc", condition.code], display: "sh -lc <code>" };
	}
	const commandText = condition.command ?? "";
	if (runner === "bash") return { command: "bash", args: ["-lc", commandText], display: commandText };
	if (runner === "xonsh") return { command: "xonsh", args: ["-c", commandText], display: commandText };
	if (runner === "python") return { command: "python3", args: [commandText], display: `python ${commandText}` };
	if (runner === "node") return { command: "node", args: [commandText], display: `node ${commandText}` };
	return { command: "sh", args: ["-lc", commandText], display: commandText };
}

function getIncomingWebhookBaseUrl(): string | undefined {
	const address = incomingWebhookServer?.address();
	if (!address || typeof address === "string") return undefined;
	const host = DEFAULT_WEBHOOK_HOST === "0.0.0.0" || DEFAULT_WEBHOOK_HOST === "::" ? "127.0.0.1" : DEFAULT_WEBHOOK_HOST;
	return `http://${host}:${address.port}`;
}

function incomingWebhookUrls(job: ReturnOnJob): Array<{ path: string; url: string; method: string }> {
	const base = getIncomingWebhookBaseUrl();
	if (!base) return [];
	return collectIncomingWebhookTargets(job).map((target) => {
		const url = new URL(target.condition.path ?? "/return-on", base);
		if (target.condition.token) url.searchParams.set("token", target.condition.token);
		return { path: target.condition.path ?? "/return-on", url: url.toString(), method: target.condition.method ?? "POST" };
	});
}

async function ensureIncomingWebhookServer(pi: ExtensionAPI): Promise<void> {
	if (incomingWebhookServer?.listening) return;
	if (incomingWebhookServerStarting) return incomingWebhookServerStarting;
	incomingWebhookServerStarting = new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			void handleIncomingWebhook(pi, req, res);
		});
		server.once("error", reject);
		server.listen(DEFAULT_WEBHOOK_PORT, DEFAULT_WEBHOOK_HOST, () => {
			incomingWebhookServer = server;
			server.off("error", reject);
			resolve();
		});
	});
	try {
		await incomingWebhookServerStarting;
	} finally {
		incomingWebhookServerStarting = undefined;
	}
}

function readRequestBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk.toString();
			if (Buffer.byteLength(body) > limit) {
				reject(new Error("request body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

async function handleIncomingWebhook(pi: ExtensionAPI, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	try {
		const base = getIncomingWebhookBaseUrl() ?? `http://${DEFAULT_WEBHOOK_HOST}:0`;
		const url = new URL(req.url ?? "/", base);
		const body = await readRequestBody(req);
		const candidates = activeJobsForCurrentSession().flatMap((job) => collectIncomingWebhookTargets(job));
		const matches = candidates.filter((target) => {
			const condition = target.condition;
			if ((condition.method ?? "POST").toUpperCase() !== (req.method ?? "GET").toUpperCase()) return false;
			if ((condition.path ?? "/return-on") !== url.pathname) return false;
			const token = url.searchParams.get("token") ?? req.headers["x-return-on-token"] ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
			if (condition.token && token !== condition.token) return false;
			if (condition.bodyContains !== undefined && !body.includes(condition.bodyContains)) return false;
			if (condition.bodyMatches !== undefined && !new RegExp(condition.bodyMatches).test(body)) return false;
			return true;
		});
		if (matches.length === 0) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "no matching active return_on webhook" }));
			return;
		}
		const now = Date.now();
		for (const target of matches) {
			const job = jobs.find((candidate) => candidate.id === target.jobId && candidate.status === "active");
			if (!job) continue;
			const summary = `incoming webhook ${target.condition.path} received`;
			job.latches[target.key] = { trueAt: now, summary, details: { method: req.method, path: url.pathname, body: truncateText(body) } };
			job.leafState[target.key] = { ...job.leafState[target.key], lastValue: true, lastSummary: summary, lastCheckAt: now };
			job.updatedAt = now;
		}
		await saveJobs();
		requestImmediateTick(pi);
		res.writeHead(202, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, matched: matches.map((target) => target.jobId) }));
	} catch (error) {
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
	}
}

function runProcess(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd: options.cwd, env: process.env });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1000).unref?.();
		}, options.timeoutMs);
		timer.unref?.();
		child.stdout.on("data", (chunk) => { if (Buffer.byteLength(stdout) < OUTPUT_LIMIT_BYTES) stdout += chunk.toString(); });
		child.stderr.on("data", (chunk) => { if (Buffer.byteLength(stderr) < OUTPUT_LIMIT_BYTES) stderr += chunk.toString(); });
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: 127, stdout: "", stderr: String(error), timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout: truncateText(stdout), stderr: truncateText(stderr), timedOut });
		});
	});
}

async function tick(pi: ExtensionAPI): Promise<void> {
	if (ticking) return;
	ticking = true;
	try {
		let changed = false;
		for (const job of activeJobsForCurrentSession()) {
			const now = Date.now();
			if (job.timeoutAt && now >= job.timeoutAt) {
				await fireJob(pi, job, "timeout");
				changed = true;
				continue;
			}
			try {
				const previousLeafState = JSON.stringify(job.leafState);
				const result = await evaluateCondition(job, job.condition);
				if (JSON.stringify(job.leafState) !== previousLeafState) changed = true;
				if (result.value) {
					if (job.rearmPending) {
						// After a fire, require the condition to evaluate false at least
						// once before we'll fire again. Skip this tick.
						changed = true;
					} else {
						await fireJob(pi, job, result.summary);
						changed = true;
					}
				} else {
					if (job.rearmPending) {
						job.rearmPending = false;
						changed = true;
					}
					if (Object.keys(job.latches).length > 0) changed = true;
				}
			} catch (error) {
				job.leafState.root = { ...job.leafState.root, lastSummary: `evaluation error: ${error instanceof Error ? error.message : String(error)}` };
				job.updatedAt = now;
				changed = true;
			}
		}
		if (changed) await saveJobs();
		ensureTicker(pi);
	} finally {
		ticking = false;
	}
}

function inheritedParentEnv(names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function hasInheritedParentEnv(): boolean {
	return !!(inheritedParentEnv(PARENT_SESSION_FILE_ENVS) || inheritedParentEnv(PARENT_SESSION_ID_ENVS) || inheritedParentEnv(PARENT_INTERCOM_TARGET_ENVS));
}

function normalizeParentRouting(value: unknown): ParentRouting {
	if (value === undefined || value === null || value === "") return "auto";
	if (value === "auto" || value === "main" || value === "current") return value;
	throw new Error("parent must be one of 'auto', 'main', or 'current'");
}

function shouldUseInheritedParent(route: ParentRouting): boolean {
	return route === "main" || (route === "auto" && hasInheritedParentEnv());
}

function getCurrentSessionFile(ctx = latestCtx): string | undefined {
	return ctx?.sessionManager.getSessionFile() ?? undefined;
}

function getCurrentSessionId(ctx = latestCtx): string | undefined {
	try {
		const sessionManager = ctx?.sessionManager as { getSessionId?: () => string } | undefined;
		return sessionManager?.getSessionId?.();
	} catch {
		return undefined;
	}
}

function getCurrentSessionName(pi: ExtensionAPI): string | undefined {
	try {
		return pi.getSessionName?.();
	} catch {
		return undefined;
	}
}

function resolveIntercomTarget(sessionName: string | undefined, sessionId: string | undefined): string | undefined {
	const name = sessionName?.trim();
	if (name) return name;
	if (!sessionId) return undefined;
	const normalized = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
	return `subagent-chat-${normalized.slice(0, 8)}`;
}

function getParentSessionFile(ctx = latestCtx, route: ParentRouting = "auto"): string | undefined {
	if (shouldUseInheritedParent(route)) {
		const inherited = inheritedParentEnv(PARENT_SESSION_FILE_ENVS);
		if (inherited) return inherited;
	}
	return getCurrentSessionFile(ctx);
}

function getParentSessionId(ctx = latestCtx, route: ParentRouting = "auto"): string | undefined {
	if (shouldUseInheritedParent(route)) {
		const inherited = inheritedParentEnv(PARENT_SESSION_ID_ENVS);
		if (inherited) return inherited;
	}
	return getCurrentSessionId(ctx);
}

function getParentSessionName(pi: ExtensionAPI, route: ParentRouting = "auto"): string | undefined {
	if (shouldUseInheritedParent(route)) {
		const inherited = inheritedParentEnv(PARENT_SESSION_NAME_ENVS);
		if (inherited) return inherited;
	}
	return getCurrentSessionName(pi);
}

function resolveParentIntercomTarget(pi: ExtensionAPI, ctx = latestCtx, route: ParentRouting = "auto"): string | undefined {
	if (shouldUseInheritedParent(route)) {
		const inherited = inheritedParentEnv(PARENT_INTERCOM_TARGET_ENVS);
		if (inherited) return inherited;
	}
	return resolveIntercomTarget(getParentSessionName(pi, route), getParentSessionId(ctx, route));
}

function makeHandlerId(job: ReturnOnJob): string {
	return `roh_${job.id.replace(/^ro_/, "")}_${Math.random().toString(36).slice(2, 6)}`;
}

function buildReturnEventPayload(job: ReturnOnJob, reason: string, run: ReturnOnHandlerRun): Record<string, unknown> {
	return {
		event: "return_on.fired",
		id: job.id,
		label: job.label,
		reason,
		createdAt: job.createdAt,
		firedAt: job.firedAt,
		cwd: job.cwd,
		parentSessionFile: job.sessionFile,
		parentSessionId: run.parentSessionId,
		parentSessionName: run.parentSessionName,
		parentIntercomTarget: run.parentIntercomTarget,
		intercom: {
			parentTarget: run.parentIntercomTarget,
			policy: "You have delegated authority to handle routine intercom work from this event. Use intercom.send for non-blocking progress/blocker notices. Use intercom.ask only when a parent decision is required and this handler cannot safely continue without it.",
			authority: "Answer or act directly when the needed response is derivable from the event, inherited context, repo state, or prior user instructions. Escalate to the parent only for destructive actions, ambiguous user preference, external side effects, security/privacy/cost risk, conflict with current parent work, or low confidence.",
		},
		resume: job.resume,
		condition: job.condition,
		latches: job.latches,
		handler: {
			id: run.id,
			dir: run.dir,
			eventPath: run.eventPath,
			stdoutPath: run.stdoutPath,
			stderrPath: run.stderrPath,
			sessionDir: run.sessionDir,
		},
	};
}

function handlerParentNotificationLines(run: Pick<ReturnOnHandlerRun, "notify" | "triggerParentOnSummary">): string[] {
	const notify = run.notify ?? "summary";
	if (notify === "none") {
		return [
			"Parent notification mode: none",
			"Your final response is stored in handler logs only and will not be automatically posted to the parent transcript/context.",
		];
	}
	return [
		`Parent notification mode: ${notify}`,
		`Your final response WILL be copied into the parent transcript/context${run.triggerParentOnSummary ? " and will trigger a parent turn" : ""}.`,
		...(notify === "ack-and-summary" ? ["The parent already received a launch ack; do not repeat startup details unless relevant."] : []),
		"Keep the final response concise. If you already sent an intercom message to the parent, do not repeat its full content; just note that you escalated it.",
	];
}

function buildHandlerPrompt(job: ReturnOnJob, reason: string, run: ReturnOnHandlerRun, eventJson: string): string {
	const parentContact = run.parentIntercomTarget
		? `Parent intercom target, if pi-intercom is available: ${run.parentIntercomTarget}`
		: "No parent intercom target was resolved; rely on your final summary.";
	return [
		"You are a background return_on handler running in a fork/sibling Pi session.",
		"The parent chat should stay undistracted. Handle the fired event as independently as safely possible.",
		"",
		"Operating rules:",
		"- Treat the inherited session/context as a snapshot, not live state.",
		"- You are delegated to handle this return event directly when safe; do not defer routine work back to the parent.",
		"- You may answer or act when the needed response is derivable from the event, inherited context, repo state, or prior user instructions.",
		"- Escalate to the parent only for destructive actions, ambiguous user preference, external side effects, security/privacy/cost risk, conflict with current parent work, or low confidence.",
		"- You may use normal Pi tools and extensions available in this top-level session, including subagent(...) if it is available and useful.",
		"- Do not ask the parent routine completion questions. Only contact the parent for a blocker, risky action, approval, or user decision.",
		"- If pi-intercom is available and a parent target is provided, use intercom.send for non-blocking progress, blocker, or escalation notices.",
		"- Use intercom.ask only when you cannot safely continue without a parent decision; it blocks this handler until reply or timeout.",
		"- If you do contact the parent, keep it brief and include the handler id.",
		"- Prefer producing a concise final summary.",
		...handlerParentNotificationLines(run).map((line) => `- ${line}`),
		"- Do not register another return_on watcher unless the resume instruction explicitly requires continued background waiting for an external event.",
		"- Never wait for this handler's own pid or status. If return_on_handlers shows this handler as running, that is expected while you are executing; summarize that observation instead of waiting.",
		"",
		parentContact,
		`Handler id: ${run.id}`,
		`Event JSON path: ${run.eventPath}`,
		"",
		"Return event payload:",
		"```json",
		eventJson,
		"```",
		"",
		"Resume instruction:",
		job.resume,
	].join("\n");
}

function buildHandlerSystemPrompt(run: ReturnOnHandlerRun): string {
	return [
		"You are a background return_on handler in a sibling Pi process.",
		"Your only task is to handle the return_on event capsule supplied in the latest user message.",
		"Do not continue unrelated inherited parent work. Treat inherited conversation as context only.",
		"You have delegated authority to handle routine work when safe; escalate only for destructive actions, ambiguous user preference, external side effects, security/privacy/cost risk, conflict with current parent work, or low confidence.",
		"Do not wait for this handler's own pid/status; seeing yourself as running is expected.",
		"If pi-intercom is available, use intercom.send for non-blocking parent notices and intercom.ask only for true blocking parent decisions.",
		...(run.parentIntercomTarget ? [`Parent intercom target: ${run.parentIntercomTarget}`] : []),
		...handlerParentNotificationLines(run),
		`Handler id: ${run.id}`,
	].join("\n");
}

function buildHandlerArgs(job: ReturnOnJob, run: ReturnOnHandlerRun): string[] {
	const args = ["-p", "--session-dir", run.sessionDir, "--append-system-prompt", buildHandlerSystemPrompt(run)];
	// If registration did not end the parent turn, the parent session file may still be
	// actively changing when the watcher fires. Forking that live transcript can make
	// the handler follow the parent turn instead of handling only the return event.
	// Use a fresh capsule-only handler in that case.
	if (job.endTurn !== false && job.sessionFile) args.push("--fork", job.sessionFile);
	args.push(`@${run.promptPath}`);
	return args;
}

function getHandlerCommand(delivery: DeliveryConfig): string {
	return delivery.piCommand || process.env.PI_RETURN_ON_PI_BIN || "pi";
}

async function readOptionalText(filePath: string): Promise<string> {
	try {
		return await fsp.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

function closeFdBestEffort(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		fs.closeSync(fd);
	} catch {
		// Best effort cleanup; the child owns duplicated stdio fds after spawn succeeds.
	}
}

function fileSizeBytes(filePath: string): number | null {
	try {
		return fs.statSync(filePath).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function formatHandlerLogPath(label: "Output" | "Errors", filePath: string): string {
	const size = fileSizeBytes(filePath);
	if (size === null) return `${label}: unavailable (${filePath}, missing)`;
	if (label === "Errors" && size === 0) return `${label}: none (${filePath}, 0 B)`;
	return `${label}: ${filePath} (${size} B)`;
}

function formatHandlerAck(job: ReturnOnJob, run: ReturnOnHandlerRun): string {
	return [
		`return_on fired: ${job.label} (${job.id})`,
		`Launched background fork handler ${run.id}${run.pid ? ` (pid ${run.pid})` : ""}.`,
		"The parent thread will not be triggered unless the handler summary is configured to trigger it.",
		`Handler dir: ${run.dir}`,
	].join("\n");
}

function formatHandlerSummary(job: { id: string; label: string }, run: ReturnOnHandlerRun): string {
	const status = run.status === "complete" ? "completed" : "failed";
	const output = run.summary?.trim() || run.error || "(no handler output)";
	const exit = run.exitCode !== undefined && run.exitCode !== null ? String(run.exitCode) : run.signal ? `signal ${run.signal}` : "unknown";
	return [
		`return_on handler ${status}: ${job.label} (${job.id})`,
		`Handler: ${run.id}`,
		`Exit: ${exit}`,
		formatHandlerLogPath("Output", run.stdoutPath),
		formatHandlerLogPath("Errors", run.stderrPath),
		"",
		truncateText(output, HANDLER_SUMMARY_LIMIT_BYTES),
	].join("\n");
}

function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function fillHandlerOutput(run: ReturnOnHandlerRun): Promise<{ stdout: string; stderr: string }> {
	const stdout = await readOptionalText(run.stdoutPath);
	const stderr = await readOptionalText(run.stderrPath);
	run.summary = truncateText(stdout.trim() || stderr.trim(), HANDLER_SUMMARY_LIMIT_BYTES);
	return { stdout, stderr };
}

async function markHandlerFinished(pi: ExtensionAPI, job: ReturnOnJob, runId: string, code: number | null, signal: NodeJS.Signals | null, notify: HandlerNotifyMode, triggerParent: boolean): Promise<void> {
	await loadHandlers();
	const run = handlerRuns.find((candidate) => candidate.id === runId);
	if (!run) return;
	run.endedAt = Date.now();
	run.exitCode = code;
	run.signal = signal;
	run.finishSource = "close";
	const { stderr } = await fillHandlerOutput(run);
	run.status = code === 0 ? "complete" : "failed";
	if (code !== 0) run.error = stderr.trim() || `handler exited with ${code ?? signal ?? "unknown status"}`;
	await saveHandlers();
	await appendLifecycleAudit("handler_finished", { id: run.id, jobId: run.jobId, label: run.label, status: run.status, exitCode: code, signal, endedAt: run.endedAt, error: run.error });
	try {
		pi.appendEntry?.("return-on-handler-finished", { id: run.id, jobId: run.jobId, status: run.status, exitCode: code, signal, endedAt: run.endedAt });
	} catch {
		// Best-effort audit trail.
	}
	await loadJobs();
	const storedJob = jobs.find((candidate) => candidate.id === run.jobId);
	const cancelled = storedJob?.status === "cancelled" || job.status === "cancelled";
	if (cancelled) {
		await appendLifecycleAudit("handler_summary_suppressed", { id: run.id, jobId: run.jobId, label: run.label, reason: "job_cancelled", endedAt: run.endedAt });
		return;
	}
	if (notify === "summary" || notify === "ack-and-summary") {
		pi.sendMessage(
			{
				customType: HANDLER_MESSAGE_TYPE,
				content: formatHandlerSummary(job, run),
				display: true,
				details: { id: job.id, handlerRunId: run.id, label: job.label, status: run.status, exitCode: code, signal },
			},
			{ triggerTurn: triggerParent },
		);
	}
}

async function reconcileHandlerRunsOnStartup(pi: ExtensionAPI, sessionFile: string | undefined, notifyReconciled = true): Promise<number> {
	let changed = false;
	let reconciled = 0;
	for (const run of handlerRuns) {
		if (run.status !== "starting" && run.status !== "running") continue;
		if (!handlerVisibleForSession(run, sessionFile)) continue;
		if (run.status === "running" && isProcessAlive(run.pid)) continue;
		const storedJob = jobs.find((candidate) => candidate.id === run.jobId);
		const job = storedJob ?? { id: run.jobId, label: run.label };
		const { stderr } = await fillHandlerOutput(run);
		run.endedAt = run.endedAt ?? Date.now();
		run.exitCode = run.exitCode ?? null;
		run.signal = run.signal ?? null;
		run.finishSource = "reconciled";
		if (run.status === "starting") {
			run.status = "failed";
			run.error = run.error || stderr.trim() || "handler was still starting when the parent session ended";
		} else if (stderr.trim()) {
			run.status = "failed";
			run.error = run.error || stderr.trim();
		} else {
			run.status = "complete";
		}
		changed = true;
		reconciled += 1;
		await appendLifecycleAudit("handler_reconciled", { id: run.id, jobId: run.jobId, label: run.label, status: run.status, pid: run.pid, endedAt: run.endedAt, error: run.error });
		try {
			pi.appendEntry?.("return-on-handler-reconciled", { id: run.id, jobId: run.jobId, status: run.status, pid: run.pid, endedAt: run.endedAt });
		} catch {
			// Best-effort audit trail.
		}
		const notify = run.notify ?? storedJob?.delivery?.notify ?? "summary";
		if (storedJob?.status === "cancelled") {
			await appendLifecycleAudit("handler_summary_suppressed", { id: run.id, jobId: run.jobId, label: run.label, reason: "job_cancelled", endedAt: run.endedAt, reconciled: true });
			continue;
		}
		if (notifyReconciled && (notify === "summary" || notify === "ack-and-summary")) {
			try {
				pi.sendMessage(
					{
						customType: HANDLER_MESSAGE_TYPE,
						content: formatHandlerSummary(job, run),
						display: true,
						details: { id: run.jobId, handlerRunId: run.id, label: run.label, status: run.status, exitCode: run.exitCode, signal: run.signal, reconciled: true },
					},
					{ triggerTurn: run.triggerParentOnSummary ?? storedJob?.delivery?.triggerParentOnSummary ?? false },
				);
			} catch (error) {
				console.error(`[${EXTENSION_NAME}] Failed to send reconciled handler summary ${run.id}:`, error);
			}
		}
	}
	if (changed) await saveHandlers();
	return reconciled;
}

async function launchReturnHandler(pi: ExtensionAPI, job: ReturnOnJob, reason: string, delivery: DeliveryConfig): Promise<boolean> {
	await loadHandlers();
	await reconcileHandlerRunsOnStartup(pi, undefined, false);
	await loadHandlers();
	const id = makeHandlerId(job);
	const parentSessionId = job.parentSessionId ?? getParentSessionId(undefined, job.parentRouting ?? "auto");
	const parentSessionName = job.parentSessionName ?? getParentSessionName(pi, job.parentRouting ?? "auto");
	const parentIntercomTarget = job.parentIntercomTarget ?? resolveParentIntercomTarget(pi, undefined, job.parentRouting ?? "auto");
	const run: ReturnOnHandlerRun = {
		...buildForkRunPaths("return_on", id),
		jobId: job.id,
		label: job.label,
		cwd: job.cwd,
		...(job.sessionFile ? { parentSessionFile: job.sessionFile } : {}),
		...(parentSessionId ? { parentSessionId } : {}),
		...(parentSessionName ? { parentSessionName } : {}),
		...(parentIntercomTarget ? { parentIntercomTarget } : {}),
		status: "starting",
		startedAt: Date.now(),
		notify: delivery.notify,
		triggerParentOnSummary: delivery.triggerParentOnSummary,
	};
	const eventJson = JSON.stringify(buildReturnEventPayload(job, reason, run), null, 2);
	await fsp.mkdir(run.sessionDir, { recursive: true });
	await fsp.writeFile(run.eventPath, `${eventJson}\n`, "utf8");
	await fsp.writeFile(run.promptPath, buildHandlerPrompt(job, reason, run, eventJson), "utf8");
	handlerRuns.push(run);
	job.handlerRunId = run.id;
	await saveHandlers();
	await saveJobs();
	await appendLifecycleAudit("handler_queued", { id: run.id, jobId: run.jobId, label: run.label, status: run.status, startedAt: run.startedAt, notify: run.notify });

	const command = getHandlerCommand(delivery);
	const args = buildHandlerArgs(job, run);
	try {
		const launch = await launchDetachedFork({
			command,
			args,
			cwd: job.cwd,
			stdoutPath: run.stdoutPath,
			stderrPath: run.stderrPath,
			env: buildForkHandlerEnv("return_on", run.id, {
				...process.env,
				...(job.sessionFile ? { [RETURN_ON_PARENT_SESSION_FILE_ENV]: job.sessionFile } : {}),
				...(parentSessionId ? { [RETURN_ON_PARENT_SESSION_ID_ENV]: parentSessionId } : {}),
				...(parentSessionName ? { [RETURN_ON_PARENT_SESSION_NAME_ENV]: parentSessionName } : {}),
				...(parentIntercomTarget ? { [RETURN_ON_PARENT_INTERCOM_TARGET_ENV]: parentIntercomTarget } : {}),
			}),
			onClose: (code, signal) => {
				void markHandlerFinished(pi, job, run.id, code, signal, delivery.notify, delivery.triggerParentOnSummary).catch((error) => {
					console.error(`[${EXTENSION_NAME}] Failed to finish handler ${run.id}:`, error);
				});
			},
		});
		if (!launch.ok) {
			run.status = "failed";
			run.endedAt = Date.now();
			run.error = launch.error instanceof Error ? launch.error.message : String(launch.error);
			await saveHandlers();
			await appendLifecycleAudit("handler_launch_failed", { id: run.id, jobId: run.jobId, label: run.label, error: run.error, endedAt: run.endedAt });
			console.error(`[${EXTENSION_NAME}] Failed to launch handler ${run.id}:`, launch.error);
			return false;
		}

		run.pid = launch.pid;
		run.status = "running";
		await saveHandlers();
		await appendLifecycleAudit("handler_running", { id: run.id, jobId: run.jobId, label: run.label, pid: run.pid, startedAt: run.startedAt });
		if (delivery.notify === "ack-and-summary") {
			pi.sendMessage(
				{
					customType: HANDLER_MESSAGE_TYPE,
					content: formatHandlerAck(job, run),
					display: true,
					details: { id: job.id, handlerRunId: run.id, label: job.label, status: "running" },
				},
				{ triggerTurn: false },
			);
		}
		return true;
	} catch (error) {
		run.status = "failed";
		run.endedAt = Date.now();
		run.error = error instanceof Error ? error.message : String(error);
		await saveHandlers();
		await appendLifecycleAudit("handler_launch_failed", { id: run.id, jobId: run.jobId, label: run.label, error: run.error, endedAt: run.endedAt });
		console.error(`[${EXTENSION_NAME}] Failed to launch handler ${run.id}:`, error);
		return false;
	}
}

async function fireJob(pi: ExtensionAPI, job: ReturnOnJob, reason: string): Promise<void> {
	if (job.status !== "active") return;
	const now = Date.now();
	const maxFires = Math.max(1, job.maxFires ?? 1);
	const nextCount = (job.fireCount ?? 0) + 1;
	const exhausted = reason === "timeout" || nextCount >= maxFires;
	job.fireCount = nextCount;
	job.lastFiredAt = now;
	job.firedAt = job.firedAt ?? now;
	job.updatedAt = now;
	job.fireReason = reason;
	job.status = exhausted ? "fired" : "active";
	if (!exhausted) {
		// Re-arm: clear latches and leaf cache so the condition must go false
		// (or at least be re-evaluated) before it can fire again.
		job.latches = {};
		job.leafState = {};
		job.rearmPending = true;
	}
	await saveJobs();
	await appendLifecycleAudit("job_fired", { id: job.id, label: job.label, reason, fireCount: job.fireCount, exhausted, status: job.status, firedAt: job.lastFiredAt, timedOut: reason === "timeout" });
	let eventPath: string | undefined;
	try {
		eventPath = await writeFiredEvent(job, reason);
	} catch (error) {
		console.error(`[${EXTENSION_NAME}] Failed to write fired event for ${job.id}:`, error);
	}
	try {
		pi.appendEntry?.("return-on-fired", { id: job.id, label: job.label, reason, firedAt: job.firedAt, eventPath });
	} catch {
		// Best-effort audit trail.
	}
	void sendWebhook(job, reason).catch((error) => {
		console.error(`[${EXTENSION_NAME}] Webhook failed for ${job.id}:`, error);
	});
	const delivery = job.delivery ?? normalizeDelivery(undefined);
	if (delivery.mode === "fork") {
		const launched = await launchReturnHandler(pi, job, reason, delivery);
		if (launched) {
			if (eventPath) await markFiredEventDelivered(eventPath, reason, "handler-launched", job);
			return;
		}
	}
	const message = formatFireMessage(job, reason);
	pi.sendMessage(
		{
			customType: EXTENSION_NAME,
			content: message,
			display: true,
			details: { id: job.id, label: job.label, reason, latches: job.latches, eventPath },
		},
		{ triggerTurn: true },
	);
	if (eventPath) await markFiredEventDelivered(eventPath, reason, "wake-sent", job);
}

async function sendWebhook(job: ReturnOnJob, reason: string): Promise<void> {
	if (!job.webhook) return;
	const timeoutMs = parseDuration(job.webhook.timeout, 5000) ?? 5000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();
	try {
		const headers = new Headers(job.webhook.headers ?? {});
		if (!headers.has("content-type")) headers.set("content-type", "application/json");
		const body = JSON.stringify({
			event: "return_on.fired",
			id: job.id,
			label: job.label,
			reason,
			createdAt: job.createdAt,
			firedAt: job.firedAt,
			cwd: job.cwd,
			sessionFile: job.sessionFile,
			resume: job.resume,
			condition: job.condition,
			latches: job.latches,
		});
		const response = await fetch(job.webhook.url, {
			method: job.webhook.method ?? "POST",
			headers,
			body,
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`webhook returned HTTP ${response.status}`);
	} finally {
		clearTimeout(timer);
	}
}

function formatFireMessage(job: ReturnOnJob, reason: string): string {
	const latched = Object.entries(job.latches)
		.map(([key, latch]) => `- ${key}: ${latch.summary} at ${nowIso(latch.trueAt)}`)
		.join("\n") || "- none";
	const maxFires = Math.max(1, job.maxFires ?? 1);
	const countLine = maxFires > 1 ? [`Fire: ${job.fireCount ?? 1}/${maxFires}${job.status === "active" ? " (will re-arm)" : ""}`] : [];
	return [
		`return_on fired: ${job.label} (${job.id})`,
		`Reason: ${reason}`,
		...countLine,
		`Created: ${nowIso(job.createdAt)}`,
		`Fired: ${nowIso(job.lastFiredAt ?? job.firedAt ?? Date.now())}`,
		`CWD: ${job.cwd}`,
		"",
		"Latched leaves:",
		latched,
		"",
		"Resume instruction:",
		job.resume,
	].join("\n");
}

function truncateInline(value: string, limit: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}…` : normalized;
}

function describeCondition(condition: Condition): string {
	if (isGroupCondition(condition)) {
		const op = condition.op.toUpperCase();
		return `${op}(${condition.children.map(describeCondition).join(", ")})`;
	}
	if (condition.type === "timer") return condition.after !== undefined ? `timer after ${condition.after}` : `timer at ${condition.at ?? "?"}`;
	if (condition.type === "file") {
		const checks = [
			condition.deleted ? "deleted" : undefined,
			condition.exists === false ? "absent" : undefined,
			condition.exists === true ? "exists" : undefined,
			condition.changed ? "changed" : undefined,
			condition.stableFor !== undefined ? `stable ${condition.stableFor}` : undefined,
			condition.contains !== undefined ? `contains '${condition.contains}'` : undefined,
			condition.matches !== undefined ? `matches /${condition.matches}/` : undefined,
		].filter(Boolean).join("+");
		return `file ${condition.path}${checks ? ` ${checks}` : ""}`;
	}
	if (condition.type === "exec") return `exec ${condition.command ?? condition.code ?? "?"}`;
	if (condition.type === "process") {
		const target = condition.pid !== undefined
			? `pid ${condition.pid}`
			: condition.pidFile !== undefined
				? `pidFile ${condition.pidFile}`
				: condition.name ?? condition.commandContains ?? condition.matches ?? "?";
		const state = condition.exited || condition.state === "exited" ? "exited" : "running";
		return `process ${target} ${state}`;
	}
	if (condition.type === "port") return `port ${condition.host ?? "127.0.0.1"}:${condition.port} ${condition.closed ? "closed" : "open"}`;
	if (condition.type === "url") return `url ${condition.url}`;
	if (condition.type === "webhook") return `webhook ${condition.method ?? "POST"} ${condition.path ?? ""}`;
	return "unknown condition";
}

function compactPathForReceipt(value: string, cwd: string): string {
	const home = os.homedir();
	const homeRelative = value === home ? "~" : value.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, value)}` : value;
	const cwdRelative = path.isAbsolute(value) ? path.relative(cwd, value) : value;
	let compact = cwdRelative && !cwdRelative.startsWith("..") && !path.isAbsolute(cwdRelative) && cwdRelative.length < homeRelative.length ? cwdRelative : homeRelative;
	if (compact.length <= 88) return compact;
	const parts = compact.split(/[\\/]+/).filter(Boolean);
	if (parts.length >= 2) compact = `…/${parts.slice(-2).join("/")}`;
	return truncateInline(compact, 88);
}

function describeConditionForReceipt(condition: Condition, cwd: string): string {
	if (isGroupCondition(condition)) return `${condition.op.toUpperCase()}(${condition.children.map((child) => describeConditionForReceipt(child, cwd)).join(", ")})`;
	if (condition.type === "timer") return condition.after !== undefined ? `timer reaches ${condition.after}` : `clock reaches ${condition.at ?? "the requested time"}`;
	if (condition.type === "file") {
		const action = condition.deleted ? "file is deleted" : condition.exists === false ? "file is absent" : condition.changed ? "file changes" : condition.stableFor !== undefined ? `file is stable for ${condition.stableFor}` : "file appears";
		const content = condition.contains !== undefined ? ` and contains “${truncateInline(condition.contains, 36)}”` : condition.matches !== undefined ? ` and matches /${truncateInline(condition.matches, 36)}/` : "";
		return `${action}${content}: ${compactPathForReceipt(condition.path, cwd)}`;
	}
	if (condition.type === "exec") return `command succeeds: ${truncateInline(condition.command ?? condition.code ?? "exec condition", 72)}`;
	if (condition.type === "process") {
		const target = condition.pid !== undefined
			? `pid ${condition.pid}`
			: condition.pidFile !== undefined
				? compactPathForReceipt(condition.pidFile, cwd)
				: condition.name ?? condition.commandContains ?? condition.matches ?? "process";
		const state = condition.exited || condition.state === "exited" ? "exits" : "is running";
		return `process ${state}: ${target}`;
	}
	if (condition.type === "port") return `port ${condition.host ?? "127.0.0.1"}:${condition.port} is ${condition.closed ? "closed" : "open"}`;
	if (condition.type === "url") return `URL is ready: ${truncateInline(condition.url, 88)}`;
	if (condition.type === "webhook") return `webhook arrives: ${condition.method ?? "POST"} ${condition.path ?? "configured path"}`;
	return describeCondition(condition);
}

function formatReceiptConditionLines(job: ReturnOnJob): string[] {
	const condition = job.condition;
	if (isGroupCondition(condition) && condition.op !== "not") {
		const heading = condition.op === "or" ? "It will return when ANY ONE happens:" : "It will return when ALL happen:";
		return [heading, ...condition.children.map((child, index) => `  ${index + 1}. ${describeConditionForReceipt(child, job.cwd)}`)];
	}
	if (isGroupCondition(condition) && condition.op === "not") {
		return ["It will return when this is no longer true:", `  • ${condition.children[0] ? describeConditionForReceipt(condition.children[0], job.cwd) : "condition"}`];
	}
	return ["It will return when:", `  • ${describeConditionForReceipt(condition, job.cwd)}`];
}

function formatReceiptCheckCadence(job: ReturnOnJob): string | undefined {
	const pollable = collectConditionLeafTargets(job.condition)
		.map(({ condition }) => pollingIntervalForLeaf(job, condition))
		.filter((value): value is number => value !== undefined);
	if (pollable.length === 0) return undefined;
	const min = Math.min(...pollable);
	const max = Math.max(...pollable);
	return min === max ? `Checks: every ${formatDuration(min)}` : `Checks: every ${formatDuration(min)}–${formatDuration(max)}`;
}

function formatRegisteredJobMessage(job: ReturnOnJob, timeoutMs: number, maxTimeoutMs: number, maxFires: number, endTurn: boolean, incomingWebhooks: string): string {
	const lines = [
		`✅ return_on is WAITING now`,
		`Job: ${job.label} (${job.id})`,
		...formatReceiptConditionLines(job),
		formatReceiptCheckCadence(job),
		`Timeout: in ${formatDuration(timeoutMs)} (max ${formatDuration(maxTimeoutMs)})`,
		maxFires > 1 ? `Repeats: up to ${maxFires} times after the condition resets` : undefined,
		`View status: ${RETURN_ON_SHORTCUT_LABEL} or /return-on-waiters`,
		endTurn ? "This chat will resume when it returns; no manual polling needed." : "Continuing this turn; the watcher is still active in the background.",
		incomingWebhooks || undefined,
	].filter((line): line is string => Boolean(line));
	return lines.join("\n");
}

function latestLeafSummary(job: ReturnOnJob): string | undefined {
	const latched = Object.entries(job.latches);
	if (latched.length > 0) return `latched ${latched.length}: ${latched.map(([, latch]) => latch.summary).join("; ")}`;
	const summaries = Object.values(job.leafState)
		.filter((state) => state.lastSummary)
		.sort((a, b) => (b.lastCheckAt ?? 0) - (a.lastCheckAt ?? 0));
	return summaries[0]?.lastSummary;
}

function formatJobWaitSummary(job: ReturnOnJob): string {
	return latestLeafSummary(job) ?? describeCondition(job.condition);
}

function formatStatusTag(active: ReturnOnJob[], theme?: Theme): string {
	const clock = theme ? theme.fg("success", "⏰") : "⏰";
	const count = theme ? theme.fg("success", String(active.length)) : String(active.length);
	const hint = theme ? theme.fg("dim", RETURN_ON_SHORTCUT_LABEL) : RETURN_ON_SHORTCUT_LABEL;
	return `${clock} ${count} · ${hint}`;
}

function pollingIntervalForLeaf(job: ReturnOnJob, condition: LeafCondition): number | undefined {
	if (condition.type === "file") return getPollingInterval(job, condition.every, DEFAULT_FILE_EVERY_MS);
	if (condition.type === "exec") return getPollingInterval(job, condition.every, DEFAULT_EXEC_EVERY_MS, MIN_EXEC_EVERY_MS);
	if (condition.type === "process") return getPollingInterval(job, condition.every, DEFAULT_PROCESS_EVERY_MS);
	if (condition.type === "port") return getPollingInterval(job, condition.every, DEFAULT_PORT_EVERY_MS);
	if (condition.type === "url") return getPollingInterval(job, condition.every, DEFAULT_URL_EVERY_MS);
	return undefined;
}

function formatNextCheck(job: ReturnOnJob, key: string, condition: LeafCondition): string | undefined {
	if (job.status !== "active") return undefined;
	const interval = pollingIntervalForLeaf(job, condition);
	if (interval === undefined) return undefined;
	const last = job.leafState[key]?.lastCheckAt;
	if (!last) return "next check: due now";
	const remaining = last + interval - Date.now();
	return remaining <= 0 ? "next check: due now" : `next check: in ${formatDuration(remaining)}`;
}

function formatConditionTree(condition: Condition, key = "root", depth = 0): string {
	const prefix = "  ".repeat(depth);
	if (isGroupCondition(condition)) {
		return [
			`${prefix}${key}: ${condition.op.toUpperCase()}`,
			...condition.children.map((child, index) => formatConditionTree(child, `${key}.${index}`, depth + 1)),
		].join("\n");
	}
	return `${prefix}${key}: ${describeCondition(condition)}`;
}

function formatLeafStateLines(job: ReturnOnJob): string[] {
	return collectConditionLeafTargets(job.condition).map(({ key, condition }) => {
		const latch = job.latches[key];
		if (latch) return `${key}: latched at ${nowIso(latch.trueAt)} — ${latch.summary}`;
		const state = job.leafState[key];
		const checked = state?.lastCheckAt ? `last check ${nowIso(state.lastCheckAt)}` : "not checked yet";
		const value = state?.lastValue === undefined ? "unknown" : state.lastValue ? "true" : "false";
		const next = formatNextCheck(job, key, condition);
		return `${key}: ${value}; ${checked}${next ? `; ${next}` : ""}; ${state?.lastSummary ?? describeCondition(condition)}`;
	});
}

function formatJobWebhooks(job: ReturnOnJob): string[] {
	const urls = incomingWebhookUrls(job);
	if (urls.length > 0) return urls.map((hook) => `${hook.method} ${hook.url}`);
	return collectIncomingWebhookTargets(job).map((target) => `${target.condition.method ?? "POST"} ${target.condition.path ?? "/return-on"}${target.condition.token ? "?token=<redacted>" : ""}`);
}

function summarizeJob(job: ReturnOnJob): string {
	const timeout = job.timeoutAt ? ` timeout=${nowIso(job.timeoutAt)}` : "";
	const delivery = job.delivery?.mode ? ` delivery=${job.delivery.mode}` : "";
	const handler = job.handlerRunId ? ` handler=${job.handlerRunId}` : "";
	const lastFired = job.lastFiredAt ?? job.firedAt;
	const fired = lastFired ? ` fired=${nowIso(lastFired)}` : "";
	const maxFires = Math.max(1, job.maxFires ?? 1);
	const fires = maxFires > 1 ? ` fires=${job.fireCount ?? 0}/${maxFires}` : "";
	const cancelled = job.cancelledAt ? ` cancelled=${nowIso(job.cancelledAt)}` : "";
	return `${job.id} [${job.status}] ${job.label}${timeout}${delivery}${handler}${fired}${fires}${cancelled}\n  waiting: ${formatJobWaitSummary(job)}\n  condition: ${describeCondition(job.condition)}\n  cwd=${job.cwd}`;
}

function formatFiredEventLine(event: FiredEventState): string {
	const delivered = event.deliveredAt ? ` delivered=${nowIso(event.deliveredAt)}` : "";
	const attempted = !event.deliveredAt && event.lastAttemptAt ? ` lastAttempt=${nowIso(event.lastAttemptAt)}` : "";
	const handler = event.handlerRunId ? ` handler=${event.handlerRunId}` : "";
	const error = event.error ? ` error=${truncateInline(event.error, 80)}` : "";
	return `${event.jobId} [${event.deliveryStatus}] ${event.label} fired=${nowIso(event.firedAt)}${delivered}${attempted}${handler} reason=${truncateInline(event.reason, 100)}${error}`;
}

function formatFiredEvents(events: FiredEventState[]): string {
	if (events.length === 0) return "No return_on fired events.";
	return [`return_on fired events (${events.length})`, ...events.map(formatFiredEventLine)].join("\n");
}

function formatJobDetails(job: ReturnOnJob): string {
	const lines = [
		`return_on job ${job.id}`,
		`Status: ${job.status}`,
		`Label: ${job.label}`,
		`Created: ${nowIso(job.createdAt)}`,
		`Updated: ${nowIso(job.updatedAt)}`,
		...(job.timeoutAt ? [`Timeout: ${nowIso(job.timeoutAt)}`] : []),
		...(job.firedAt ? [`Fired: ${nowIso(job.lastFiredAt ?? job.firedAt)}${job.maxFires && job.maxFires > 1 ? ` (${job.fireCount ?? 0}/${job.maxFires})` : ""}`] : []),
		...(job.fireReason ? [`Fire reason: ${job.fireReason}`] : []),
		...(job.cancelledAt ? [`Cancelled: ${nowIso(job.cancelledAt)}`] : []),
		...(job.delivery ? [`Delivery: ${job.delivery.mode} notify=${job.delivery.notify}`] : []),
		...(job.handlerRunId ? [`Handler: ${job.handlerRunId}`] : []),
		`CWD: ${job.cwd}`,
		"",
		`Waiting: ${formatJobWaitSummary(job)}`,
		"",
		"Condition tree:",
		formatConditionTree(job.condition),
		"",
		"Leaf checks:",
		...formatLeafStateLines(job).map((line) => `- ${line}`),
	];
	const hooks = formatJobWebhooks(job);
	if (hooks.length > 0) lines.push("", "Incoming webhooks:", ...hooks.map((hook) => `- ${hook}`));
	lines.push("", "Resume instruction:", job.resume);
	return lines.join("\n");
}

function formatTimeoutSummary(job: ReturnOnJob): string {
	if (!job.timeoutAt) return "none";
	const remaining = job.timeoutAt - Date.now();
	return remaining <= 0 ? `due ${formatDuration(-remaining)} ago` : `in ${formatDuration(remaining)}`;
}

function latestJobCheckAt(job: ReturnOnJob): number | undefined {
	const leafChecks = Object.values(job.leafState).map((state) => state.lastCheckAt ?? 0);
	const latchTimes = Object.values(job.latches).map((latch) => latch.trueAt);
	const latest = Math.max(0, ...leafChecks, ...latchTimes);
	return latest > 0 ? latest : undefined;
}

function timerTargetAt(job: ReturnOnJob, condition: TimerCondition): number | undefined {
	const afterMs = parseDuration(condition.after);
	const afterAt = afterMs !== undefined ? job.createdAt + afterMs : undefined;
	return afterAt ?? parseAt(condition.at, job.createdAt);
}

function formatJobCheckSchedule(job: ReturnOnJob, now = Date.now()): string | undefined {
	const leaves = collectConditionLeafTargets(job.condition);
	const pollable = leaves
		.map((target) => {
			const everyMs = pollingIntervalForLeaf(job, target.condition);
			if (everyMs === undefined) return undefined;
			const lastCheckAt = job.leafState[target.key]?.lastCheckAt;
			return { everyMs, nextAt: lastCheckAt ? lastCheckAt + everyMs : now };
		})
		.filter((value): value is { everyMs: number; nextAt: number } => value !== undefined);
	if (pollable.length > 0) {
		const minEvery = Math.min(...pollable.map((item) => item.everyMs));
		const maxEvery = Math.max(...pollable.map((item) => item.everyMs));
		const nextAt = Math.min(...pollable.map((item) => item.nextAt));
		const everyText = minEvery === maxEvery
			? `checks every ${formatDuration(minEvery)}`
			: `checks every ${formatDuration(minEvery)}–${formatDuration(maxEvery)}`;
		const remaining = nextAt - now;
		return `${everyText} · ${remaining <= 0 ? "next check now" : `next check in ${formatDuration(remaining)}`}`;
	}
	const timers = leaves
		.map((target) => "type" in target.condition && target.condition.type === "timer" ? timerTargetAt(job, target.condition) : undefined)
		.filter((target): target is number => target !== undefined);
	if (timers.length > 0) {
		const nextTimer = Math.min(...timers);
		const remaining = nextTimer - now;
		return remaining <= 0 ? "timer due now" : `timer due in ${formatDuration(remaining)}`;
	}
	if (leaves.some((target) => "type" in target.condition && target.condition.type === "webhook")) return "waiting for webhook";
	return undefined;
}

function formatJobStatusBadge(job: ReturnOnJob): string {
	if (job.status === "active") return "● WAITING";
	if (job.status === "fired") return "✓ RETURNED";
	return "× CANCELLED";
}

function colorJobStatusBadge(job: ReturnOnJob, theme: Theme): string {
	const badge = formatJobStatusBadge(job);
	if (job.status === "active") return theme.fg("warning", badge);
	if (job.status === "fired") return theme.fg("success", badge);
	return theme.fg("muted", badge);
}

function formatJobAgeSummary(job: ReturnOnJob): string {
	const now = Date.now();
	const started = `started ${formatAge(job.createdAt, now)}`;
	if (job.status === "active") {
		const checkedAt = latestJobCheckAt(job);
		const schedule = formatJobCheckSchedule(job, now);
		return `${started} · ${checkedAt ? `last check ${formatAge(checkedAt, now)}` : "not checked yet"}${schedule ? ` · ${schedule}` : ""}`;
	}
	if (job.status === "fired") return `${started} · returned ${formatAge(job.lastFiredAt ?? job.firedAt ?? job.updatedAt, now)}`;
	return `${started} · cancelled ${formatAge(job.cancelledAt ?? job.updatedAt, now)}`;
}

function formatJobModalLine(job: ReturnOnJob, theme?: Theme): string {
	const timeout = job.status === "active" && job.timeoutAt ? ` · timeout ${formatTimeoutSummary(job)}` : "";
	const badge = theme ? colorJobStatusBadge(job, theme) : formatJobStatusBadge(job);
	const label = truncateInline(job.label, 56);
	const meta = `${formatJobAgeSummary(job)}${timeout}`;
	if (!theme) return `${badge} — ${label} · ${meta}`;
	return `${badge} ${theme.fg("muted", "—")} ${theme.fg("accent", label)} ${theme.fg("muted", "·")} ${theme.fg("dim", meta)}`;
}

const RETURN_ON_WAITERS_SORTS = ["status", "updated", "created", "timeout", "label"] as const;
type ReturnOnWaitersSort = typeof RETURN_ON_WAITERS_SORTS[number];
type ReturnOnWaitersScope = "related" | "session" | "all";

function statusRank(job: ReturnOnJob): number {
	return job.status === "active" ? 0 : job.status === "fired" ? 1 : 2;
}

function defaultSortDescending(sort: ReturnOnWaitersSort): boolean {
	return sort === "updated" || sort === "created";
}

function compareOptionalNumber(a: number | undefined, b: number | undefined): number {
	if (a === undefined && b === undefined) return 0;
	if (a === undefined) return 1;
	if (b === undefined) return -1;
	return a - b;
}

function compareJobsForSort(a: ReturnOnJob, b: ReturnOnJob, sort: ReturnOnWaitersSort): number {
	switch (sort) {
		case "status": {
			const byStatus = statusRank(a) - statusRank(b);
			return byStatus !== 0 ? byStatus : (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt);
		}
		case "updated":
			return (a.updatedAt ?? a.createdAt) - (b.updatedAt ?? b.createdAt);
		case "created":
			return a.createdAt - b.createdAt;
		case "timeout":
			return compareOptionalNumber(a.timeoutAt, b.timeoutAt);
		case "label":
			return a.label.localeCompare(b.label);
	}
}

function sortJobsForDisplay(items: ReturnOnJob[], sort: ReturnOnWaitersSort = "status", descending = defaultSortDescending(sort)): ReturnOnJob[] {
	return [...items].sort((a, b) => {
		const result = compareJobsForSort(a, b, sort) || a.id.localeCompare(b.id);
		return descending ? -result : result;
	});
}

function formatByteCount(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function safeHandlerPath(filePath: string | undefined): string | undefined {
	if (!filePath || !isPathInside(HANDLERS_DIR, filePath)) return undefined;
	return filePath;
}

function handlerLogSize(filePath: string | undefined): number | undefined {
	const safePath = safeHandlerPath(filePath);
	if (!safePath) return undefined;
	try {
		return fs.statSync(safePath).size;
	} catch {
		return undefined;
	}
}

function formatHandlerLogPathForModal(filePath: string | undefined): string {
	if (!filePath) return "none";
	const size = handlerLogSize(filePath);
	return `${filePath}${size !== undefined ? ` (${formatByteCount(size)})` : ""}`;
}

function readHandlerLogTail(filePath: string | undefined, maxBytes = 1600, maxLines = 8): string | undefined {
	const safePath = safeHandlerPath(filePath);
	if (!safePath) return undefined;
	try {
		const stats = fs.statSync(safePath);
		if (!stats.isFile() || stats.size <= 0) return undefined;
		const fd = fs.openSync(safePath, "r");
		try {
			const length = Math.min(maxBytes, stats.size);
			const buffer = Buffer.alloc(length);
			fs.readSync(fd, buffer, 0, length, stats.size - length);
			return buffer.toString("utf8").split("\n").filter((line) => line.trim().length > 0).slice(-maxLines).join("\n");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

function commandAvailable(command: string): boolean {
	if (command.includes(path.sep)) {
		try {
			fs.accessSync(command, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		try {
			fs.accessSync(path.join(dir, command), fs.constants.X_OK);
			return true;
		} catch {
			// Try next PATH entry.
		}
	}
	return false;
}

function openHandlerDirInTerminal(dir: string | undefined): { ok: boolean; message: string } {
	const safeDir = safeHandlerPath(dir);
	if (!safeDir) return { ok: false, message: "Refusing to open handler logs outside the return_on handlers directory." };
	const candidates: Array<{ command: string; args: string[] }> = [];
	if (process.env.TERMINAL && !process.env.TERMINAL.includes(" ")) candidates.push({ command: process.env.TERMINAL, args: [] });
	candidates.push(
		{ command: "ghostty", args: ["--working-directory", safeDir] },
		{ command: "kitty", args: ["--directory", safeDir] },
		{ command: "alacritty", args: ["--working-directory", safeDir] },
		{ command: "wezterm", args: ["start", "--cwd", safeDir] },
		{ command: "x-terminal-emulator", args: ["--working-directory", safeDir] },
		{ command: "gnome-terminal", args: ["--working-directory", safeDir] },
	);
	for (const candidate of candidates) {
		if (!commandAvailable(candidate.command)) continue;
		try {
			const child = spawn(candidate.command, candidate.args, { cwd: safeDir, detached: true, stdio: "ignore" });
			child.on("error", () => undefined);
			child.unref();
			return { ok: true, message: `Opened handler logs in ${candidate.command}: ${safeDir}` };
		} catch {
			// Try the next known terminal command.
		}
	}
	return { ok: false, message: `No supported terminal was found. Handler logs are in ${safeDir}` };
}

class ReturnOnWaitersModal implements Component {
	private scroll = 0;
	private selectedIndex = 0;
	private showDetails = false;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private scope: ReturnOnWaitersScope = "related";
	private showCompleted = false;
	private sort: ReturnOnWaitersSort = "status";
	private sortDescending = defaultSortDescending(this.sort);

	constructor(
		private readonly allJobs: ReturnOnJob[],
		private readonly allHandlers: ReturnOnHandlerRun[],
		private readonly session: string | undefined,
		private readonly sessionId: string | undefined,
		private readonly sessionName: string | undefined,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly notify: (message: string, type?: "info" | "warning" | "error") => void,
	) {}

	handleInput(data: string): void {
		const visibleJobs = this.visibleJobs();
		this.clampSelection(visibleJobs.length);
		const body = this.getCachedBodyLength();
		const maxScroll = Math.max(0, body - RETURN_ON_MODAL_BODY_LINES);
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || RETURN_ON_SHORTCUT_ALIASES.some((shortcut) => matchesKey(data, shortcut)) || data === "q") {
			this.done();
			return;
		}
		if (data === "a") {
			this.scope = this.scope === "related" ? "session" : this.scope === "session" ? "all" : "related";
			this.resetView();
		} else if (data === "c") {
			this.showCompleted = !this.showCompleted;
			this.resetView();
		} else if (data === "o") {
			this.openSelectedHandler(visibleJobs);
		} else if (data === "s") {
			const current = RETURN_ON_WAITERS_SORTS.indexOf(this.sort);
			this.sort = RETURN_ON_WAITERS_SORTS[(current + 1) % RETURN_ON_WAITERS_SORTS.length];
			this.sortDescending = defaultSortDescending(this.sort);
			this.resetView();
		} else if (data === "r") {
			this.sortDescending = !this.sortDescending;
			this.resetView();
		} else if (matchesKey(data, Key.enter) || data === " " || data === "d") {
			if (visibleJobs.length > 0) this.showDetails = !this.showDetails;
			this.ensureSelectedVisible();
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selectedIndex = Math.min(visibleJobs.length - 1, this.selectedIndex + 1);
			this.ensureSelectedVisible();
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureSelectedVisible();
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) {
			this.selectedIndex = Math.min(visibleJobs.length - 1, this.selectedIndex + RETURN_ON_MODAL_BODY_LINES - 6);
			this.ensureSelectedVisible();
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) {
			this.selectedIndex = Math.max(0, this.selectedIndex - (RETURN_ON_MODAL_BODY_LINES - 6));
			this.ensureSelectedVisible();
		} else if (matchesKey(data, Key.home)) {
			this.selectedIndex = 0;
			this.ensureSelectedVisible();
		} else if (matchesKey(data, Key.end)) {
			this.selectedIndex = Math.max(0, visibleJobs.length - 1);
			this.ensureSelectedVisible();
		} else if (data === "J") this.scroll = Math.min(maxScroll, this.scroll + 1);
		else if (data === "K") this.scroll = Math.max(0, this.scroll - 1);
		else return;
		this.invalidate();
	}

	render(width: number): string[] {
		const frameWidth = Math.max(40, width);
		const innerWidth = Math.max(20, frameWidth - 4);
		const visibleJobs = this.visibleJobs();
		this.clampSelection(visibleJobs.length);
		const activeCount = visibleJobs.filter((job) => job.status === "active").length;
		const body = this.getBodyLines(innerWidth);
		const maxScroll = Math.max(0, body.length - RETURN_ON_MODAL_BODY_LINES);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visibleBody = body.slice(this.scroll, this.scroll + RETURN_ON_MODAL_BODY_LINES);
		const scopeLabel = this.scope === "all" ? "all sessions" : this.scope === "related" ? "related" : "this chat";
		const sortLabel = `${this.sort} ${this.sortDescending ? "desc" : "asc"}`;
		const selected = visibleJobs.length > 0 ? ` · ${this.selectedIndex + 1}/${visibleJobs.length}` : "";
		const title = `${this.theme.fg("accent", "⏰ return_on waiters")} ${this.theme.fg("dim", `${activeCount} waiting · ${visibleJobs.length} total · ${scopeLabel} · ${sortLabel}${selected}`)}`;
		const range = body.length > RETURN_ON_MODAL_BODY_LINES
			? ` · lines ${this.scroll + 1}-${Math.min(body.length, this.scroll + RETURN_ON_MODAL_BODY_LINES)}/${body.length}`
			: "";
		const help = this.theme.fg("dim", `↑/↓ select · Enter details · a scope · c completed · s sort · r reverse · o open logs · q close${range}`);
		return [
			this.border("┌", "┐", frameWidth),
			this.frameLine(title, frameWidth),
			this.border("├", "┤", frameWidth),
			...visibleBody.map((line) => this.frameLine(line, frameWidth)),
			...(visibleBody.length === 0 ? [this.frameLine("", frameWidth)] : []),
			this.border("├", "┤", frameWidth),
			this.frameLine(help, frameWidth),
			this.border("└", "┘", frameWidth),
		].map((line) => line.startsWith("│") ? line : this.theme.fg("muted", line));
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private resetView(): void {
		this.scroll = 0;
		this.selectedIndex = 0;
		this.showDetails = false;
	}

	private clampSelection(count = this.visibleJobs().length): void {
		if (count <= 0) {
			this.selectedIndex = 0;
			this.showDetails = false;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, count - 1));
	}

	private selectedRowLine(): number {
		return 4 + this.selectedIndex;
	}

	private ensureSelectedVisible(): void {
		const row = this.selectedRowLine();
		if (row < this.scroll) this.scroll = row;
		else if (row >= this.scroll + RETURN_ON_MODAL_BODY_LINES) this.scroll = row - RETURN_ON_MODAL_BODY_LINES + 1;
		this.scroll = Math.max(0, this.scroll);
	}

	private getCachedBodyLength(): number {
		return this.cachedLines?.length ?? 0;
	}

	private handlerForJob(job: ReturnOnJob): ReturnOnHandlerRun | undefined {
		if (!job.handlerRunId) return undefined;
		return this.allHandlers.find((run) => run.id === job.handlerRunId);
	}

	private jobIsRelated(job: ReturnOnJob): boolean {
		if (jobVisibleForSession(job, this.session)) return true;
		const handler = this.handlerForJob(job);
		if (!handler) return false;
		if (this.session && handler.parentSessionFile === this.session) return true;
		if (this.sessionId && handler.parentSessionId === this.sessionId) return true;
		if (this.sessionName && (handler.parentSessionName === this.sessionName || handler.parentIntercomTarget === this.sessionName)) return true;
		if (this.session && handler.sessionDir && isPathInside(handler.sessionDir, this.session)) return true;
		return false;
	}

	private visibleJobs(): ReturnOnJob[] {
		const scoped = this.scope === "all"
			? this.allJobs
			: this.scope === "related"
				? this.allJobs.filter((job) => this.jobIsRelated(job))
				: this.allJobs.filter((job) => jobVisibleForSession(job, this.session));
		const statusFiltered = this.showCompleted ? scoped : scoped.filter((job) => job.status === "active");
		return sortJobsForDisplay(statusFiltered, this.sort, this.sortDescending);
	}

	private openSelectedHandler(visibleJobs: ReturnOnJob[]): void {
		const job = visibleJobs[this.selectedIndex];
		const handler = job ? this.handlerForJob(job) : undefined;
		if (!job || !handler) {
			this.notify("No return_on handler logs are attached to the selected waiter yet.", "info");
			return;
		}
		const result = openHandlerDirInTerminal(handler.dir);
		this.notify(result.message, result.ok ? "info" : "warning");
	}

	private scopeDescription(): string {
		if (this.scope === "all") return "all sessions";
		if (this.scope === "related") return this.session ? `related to this chat (${this.session})` : "related to this chat";
		return this.session ? `this chat (${this.session})` : "this chat (unsaved session)";
	}

	private getBodyLines(innerWidth: number): string[] {
		if (this.cachedLines && this.cachedWidth === innerWidth) return this.cachedLines;
		const visibleJobs = this.visibleJobs();
		this.clampSelection(visibleJobs.length);
		const activeCount = visibleJobs.filter((job) => job.status === "active").length;
		const lines: string[] = [];
		const push = (line = "") => lines.push(line);
		const pushWrapped = (line = "") => {
			if (!line) {
				push("");
				return;
			}
			for (const wrapped of wrapTextWithAnsi(line, innerWidth)) push(wrapped);
		};
		pushWrapped(`${this.theme.fg("dim", "Scope:")} ${this.theme.fg("accent", this.scopeDescription())} ${this.theme.fg("muted", "· completed:")} ${this.theme.fg("accent", this.showCompleted ? "shown" : "hidden")} ${this.theme.fg("muted", "· sort:")} ${this.theme.fg("accent", `${this.sort} ${this.sortDescending ? "desc" : "asc"}`)}`);
		pushWrapped(this.theme.fg("dim", "Keys: ↑/↓ or j/k select · Enter/d details · a scope · c completed · s sort · r reverse · o open logs"));
		push("");
		pushWrapped(this.theme.fg("accent", `Waiters (${visibleJobs.length}, ${activeCount} waiting)`));
		if (visibleJobs.length === 0) {
			pushWrapped(this.theme.fg("warning", `No return_on waiters for ${this.scope === "all" ? "any session" : this.scope === "related" ? "related jobs" : "this chat"}.`));
		} else {
			visibleJobs.forEach((job, index) => {
				const selected = index === this.selectedIndex;
				const marker = selected ? this.theme.fg("accent", "›") : " ";
				const indexText = selected ? this.theme.fg("accent", `${index + 1}.`) : this.theme.fg("dim", `${index + 1}.`);
				const line = `${marker} ${indexText} ${formatJobModalLine(job, this.theme)}`;
				pushWrapped(line);
			});
		}
		const selectedJob = visibleJobs[this.selectedIndex];
		if (selectedJob && this.showDetails) {
			push("");
			pushWrapped(this.theme.fg("accent", `Details: ${selectedJob.label}`));
			pushWrapped(`${this.theme.fg("dim", "id/state:")} ${selectedJob.id} / ${colorJobStatusBadge(selectedJob, this.theme)}`);
			pushWrapped(`${this.theme.fg("dim", "waiting:")} ${formatJobWaitSummary(selectedJob)}`);
			pushWrapped(`${this.theme.fg("dim", "timeout:")} ${formatTimeoutSummary(selectedJob)}`);
			pushWrapped(`${formatJobAgeSummary(selectedJob)} · timeout ${formatTimeoutSummary(selectedJob)}`);
			pushWrapped(`session: ${selectedJob.sessionFile ?? "unknown"}`);
			pushWrapped(`cwd: ${selectedJob.cwd}`);
			if (selectedJob.delivery) pushWrapped(`delivery: ${selectedJob.delivery.mode} notify=${selectedJob.delivery.notify}`);
			const handler = this.handlerForJob(selectedJob);
			if (selectedJob.handlerRunId) pushWrapped(`handler: ${selectedJob.handlerRunId}${handler ? ` (${handler.status})` : ""}`);
			if (handler) {
				pushWrapped(`${this.theme.fg("dim", "handler dir:")} ${handler.dir}`);
				pushWrapped(`${this.theme.fg("dim", "handler session:")} ${handler.sessionDir}`);
				pushWrapped(`${this.theme.fg("dim", "stdout:")} ${formatHandlerLogPathForModal(handler.stdoutPath)}`);
				pushWrapped(`${this.theme.fg("dim", "stderr:")} ${formatHandlerLogPathForModal(handler.stderrPath)}`);
				if (handler.pid) pushWrapped(`handler pid: ${handler.pid}`);
				if (handler.summary) pushWrapped(`summary: ${truncateInline(handler.summary, 180)}`);
				if (handler.error) pushWrapped(this.theme.fg("error", `error: ${truncateInline(handler.error, 180)}`));
				const stdoutTail = readHandlerLogTail(handler.stdoutPath);
				const stderrTail = readHandlerLogTail(handler.stderrPath);
				if (stdoutTail) {
					pushWrapped(this.theme.fg("dim", "stdout tail:"));
					for (const line of stdoutTail.split("\n")) pushWrapped(`  ${line}`);
				}
				if (stderrTail) {
					pushWrapped(this.theme.fg("dim", "stderr tail:"));
					for (const line of stderrTail.split("\n")) pushWrapped(`  ${line}`);
				}
			}
			const maxFires = Math.max(1, selectedJob.maxFires ?? 1);
			if (maxFires > 1) pushWrapped(`fires: ${selectedJob.fireCount ?? 0}/${maxFires}${selectedJob.rearmPending ? " (re-arm pending)" : ""}`);
			pushWrapped("condition tree:");
			for (const line of formatConditionTree(selectedJob.condition).split("\n")) pushWrapped(`  ${line}`);
			pushWrapped("leaf checks:");
			for (const line of formatLeafStateLines(selectedJob)) pushWrapped(`  - ${line}`);
			const hooks = formatJobWebhooks(selectedJob);
			if (hooks.length > 0) {
				pushWrapped("incoming webhooks:");
				for (const hook of hooks) pushWrapped(`  - ${hook}`);
			}
			pushWrapped(`resume: ${selectedJob.resume}`);
		}
		this.cachedWidth = innerWidth;
		this.cachedLines = lines;
		return lines;
	}

	private border(left: string, right: string, width: number): string {
		return `${left}${"─".repeat(Math.max(0, width - 2))}${right}`;
	}

	private frameLine(content: string, width: number): string {
		const innerWidth = Math.max(1, width - 4);
		const text = truncateToWidth(content, innerWidth, "…");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
		return `│ ${text}${padding} │`;
	}
}

async function showWaitersModal(ctx: ExtensionContext): Promise<void> {
	latestCtx = ctx;
	currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
	await loadJobs();
	await loadHandlers();
	const session = ctx.sessionManager.getSessionFile() ?? undefined;
	const sessionId = ctx.sessionManager.getSessionId() ?? undefined;
	const sessionName = ctx.sessionManager.getSessionName() ?? undefined;
	const allJobs = sortJobsForDisplay(jobs, "status");
	if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
		ctx.ui.notify(allJobs.length ? allJobs.map(summarizeJob).join("\n") : "No return_on jobs.", "info");
		return;
	}
	await ctx.ui.custom<void>(
		(_tui, theme, _keybindings, done) => new ReturnOnWaitersModal(allJobs, handlerRuns, session, sessionId, sessionName, theme, done, (message, type = "info") => ctx.ui.notify(message, type)),
		{
			overlay: true,
			overlayOptions: {
				width: "90%",
				minWidth: 60,
				maxHeight: "85%",
				anchor: "center",
				margin: 1,
			},
		},
	);
	updateStatus(ctx);
}

function jobVisibleForSession(job: ReturnOnJob, session: string | undefined): boolean {
	return !session || !job.sessionFile || job.sessionFile === session;
}

function handlerVisibleForSession(run: ReturnOnHandlerRun, session: string | undefined): boolean {
	const currentHandlerRunId = process.env.PI_RETURN_ON_HANDLER_RUN_ID;
	return !session || !run.parentSessionFile || run.parentSessionFile === session || (!!currentHandlerRunId && run.id === currentHandlerRunId);
}

async function findJobForCommand(args: string, ctx: ExtensionContext): Promise<ReturnOnJob | undefined> {
	latestCtx = ctx;
	await loadJobs();
	const id = args.trim();
	const session = ctx.sessionManager.getSessionFile() ?? undefined;
	const job = jobs.find((candidate) => candidate.id === id && jobVisibleForSession(candidate, session));
	if (!job) {
		ctx.ui.notify(`No return_on job found for '${id}'`, "warning");
		return undefined;
	}
	return job;
}

async function notifyDirectWaitAudit(args: string, ctx: ExtensionContext): Promise<void> {
	latestCtx = ctx;
	const requestedLimit = Number.parseInt(args.trim(), 10);
	const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 1000) : 50;
	const entries = await readDirectWaitAudit(limit);
	ctx.ui.notify(formatDirectWaitAudit(entries), "info");
}

function isPathInside(parent: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate));
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function commandReply(content: string): void {
	try {
		// Commands are for humans, but showing the result in the transcript is useful.
		(latestCtx as unknown);
	} catch {
		// no-op
	}
}

export default function (pi: ExtensionAPI) {
	(pi.on as unknown as (event: "context", handler: (event: { messages: unknown[] }) => { messages: unknown[] } | undefined) => void)("context", (event) => {
		const messages = compactReturnOnHandlerMessages(event.messages);
		if (messages === event.messages) return undefined;
		return { messages };
	});

	pi.registerMessageRenderer?.(EXTENSION_NAME, (message, _options, theme) => {
		return new Text(theme.fg("accent", "⏰ return_on\n") + message.content, 0, 0);
	});
	pi.registerMessageRenderer?.(HANDLER_MESSAGE_TYPE, (message, _options, theme) => {
		return new Text(theme.fg("accent", "⏰ return_on handler\n") + message.content, 0, 0);
	});
	for (const shortcut of RETURN_ON_SHORTCUT_ALIASES) {
		pi.registerShortcut?.(shortcut, {
			description: shortcut === RETURN_ON_SHORTCUT
				? "Show return_on waiters and condition details"
				: `Show return_on waiters and condition details (${RETURN_ON_SHORTCUT_LABEL} alias)`,
			handler: showWaitersModal,
		});
	}

	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: `${event.systemPrompt}\n\n${DIRECT_WAIT_SYSTEM_GUIDANCE}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const input = event.input as { command?: unknown };
		const command = typeof input.command === "string" ? input.command : "";
		const directWait = analyzeDirectWait(command);
		if (!directWait) return undefined;
		const reason = directWait.action === "blocked" ? formatDirectWaitBlockReason(directWait) : undefined;
		const auditEntry: DirectWaitAuditEntry = {
			version: 1,
			event: "direct_wait",
			timestamp: Date.now(),
			cwd: ctx?.cwd,
			sessionFile: ctx?.sessionManager.getSessionFile() ?? undefined,
			toolName: event.toolName,
			command: redactCommand(command),
			thresholdMs: DIRECT_SLEEP_BLOCK_THRESHOLD_MS,
			...directWait,
			...(reason ? { reason } : {}),
		};
		await appendDirectWaitAudit(auditEntry);
		try {
			pi.appendEntry?.("return-on-direct-wait", auditEntry);
		} catch {
			// Best-effort audit trail.
		}
		if (directWait.action !== "blocked") return undefined;
		return { block: true, reason };
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		await loadJobs();
		await loadHandlers();
		try {
			await reconcileHandlerRunsOnStartup(pi, currentSessionFile, true);
		} catch (error) {
			console.error(`[${EXTENSION_NAME}] Failed to reconcile handler runs:`, error);
		}
		try {
			await pruneState();
		} catch (error) {
			console.error(`[${EXTENSION_NAME}] Failed to prune retained state:`, error);
		}
		await deliverPendingFiredEvents(pi);
		ensureTicker(pi);
		if (ctx.hasUI && activeJobsForCurrentSession().length > 0) {
			ctx.ui.notify(`return_on watching ${activeJobsForCurrentSession().length} job(s)`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		stopTicker();
		stopFileWatchers();
		stopIncomingWebhookServer();
		if (immediateTickTimer) clearTimeout(immediateTickTimer);
		immediateTickTimer = undefined;
		latestCtx = undefined;
	});

	pi.registerCommand("return-on-list", {
		description: "List active/completed return_on jobs for this session",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			await loadJobs();
			const session = ctx.sessionManager.getSessionFile() ?? undefined;
			const relevant = jobs.filter((job) => jobVisibleForSession(job, session));
			const text = relevant.length ? relevant.map(summarizeJob).join("\n") : "No return_on jobs for this session.";
			ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("return-on-waiters", {
		description: `Open the return_on waiters modal (${RETURN_ON_SHORTCUT_LABEL})`,
		handler: async (_args, ctx) => {
			await showWaitersModal(ctx);
		},
	});

	pi.registerCommand("return-on-status", {
		description: "Show details for a return_on job: /return-on-status <id>",
		handler: async (args, ctx) => {
			const job = await findJobForCommand(args, ctx);
			if (!job) return;
			ctx.ui.notify(formatJobDetails(job), "info");
		},
	});

	pi.registerCommand("return-on-handlers", {
		description: "List background return_on fork handlers",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			await loadHandlers();
			await reconcileHandlerRunsOnStartup(pi, undefined, false);
			await loadHandlers();
			const session = ctx.sessionManager.getSessionFile() ?? undefined;
			const relevant = handlerRuns.filter((run) => handlerVisibleForSession(run, session));
			const text = relevant.length
				? relevant.map((run) => `${run.id} [${run.status}] job=${run.jobId} pid=${run.pid ?? "-"} dir=${run.dir}`).join("\n")
				: "No return_on handler runs for this session.";
			ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("return-on-prune", {
		description: "Prune old return_on state: /return-on-prune [--dry-run] [--days=N] [--audit-max=N]",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			let options: PruneOptions;
			try {
				options = parsePruneCommandArgs(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				return;
			}
			await loadJobs();
			await loadHandlers();
			const summary = await pruneState(options);
			ctx.ui.notify(formatPruneSummary(summary), "info");
		},
	});

	pi.registerCommand("return-on-fired-events", {
		description: "List durable return_on fired-event capsules: /return-on-fired-events [pending|delivered|failed|all] [limit]",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const status = parts[0] === "pending" || parts[0] === "delivered" || parts[0] === "failed" || parts[0] === "all" ? parts.shift() : "all";
			const requestedLimit = Number.parseInt(parts[0] ?? "", 10);
			const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 1000) : 50;
			const session = ctx.sessionManager.getSessionFile() ?? undefined;
			const events = (await readFiredEventFiles())
				.filter(({ event }) => !event.sessionFile || !session || event.sessionFile === session)
				.filter(({ event }) => status === "all" || (status === "pending" ? event.deliveryStatus === "pending" : status === "delivered" ? !!event.deliveredAt : event.deliveryStatus === "failed"))
				.slice(0, limit)
				.map(({ event }) => event);
			ctx.ui.notify(formatFiredEvents(events), "info");
		},
	});

	pi.registerCommand("return-on-cancel", {
		description: "Cancel a return_on job: /return-on-cancel <id>",
		handler: async (args, ctx) => {
			const job = await findJobForCommand(args, ctx);
			if (!job) return;
			job.status = "cancelled";
			job.cancelledAt = Date.now();
			job.updatedAt = job.cancelledAt;
			await saveJobs();
			ensureTicker(pi);
			ctx.ui.notify(`Cancelled ${job.id}`, "info");
		},
	});

	pi.registerCommand("return-on-direct-waits", {
		description: "Show the direct-wait policy audit log: /return-on-direct-waits [limit]",
		handler: notifyDirectWaitAudit,
	});

	pi.registerCommand("return-on-audit", {
		description: "Alias for /return-on-direct-waits",
		handler: notifyDirectWaitAudit,
	});

	pi.registerTool({
		name: "return_on",
		label: "Return On",
		description: "Register a background condition watcher and wake the agent later when the condition tree becomes true. Supports timer, file, process, port, url, incoming webhook, and exec leaves plus and/or/not groups.",
		promptSnippet: "Register timers/watchers that resume Pi later without spending model tokens waiting",
		promptGuidelines: [
			"Use return_on when waiting for time, files, logs, processes, ports, URLs, command checks, builds, renders, servers, or other external state instead of polling in the conversation.",
			"Every return_on watcher has an effective timeout. If no timeout is provided, the configured default applies; explicit timeouts cannot exceed the configured maximum. The packaged default max is 2h; choose a realistic explicit timeout for long jobs instead of assuming an older 10m cap.",
			"Do not use direct waits like sleep commands of 10 seconds or longer, tail -f, watch, foreground dev servers, or manual polling loops; start the work in the background and register return_on instead.",
			"For long-running commands, capture logs and pid files (for example under .return-on/) so return_on can watch a file/log/process/port/url signal and wake the session later.",
			"return_on conditions latch once true; combine leaves with op='and', op='or', op='not' or shorthand any/all/not.",
			"By default each watcher fires once and is retired. Set maxFires to a positive integer to fire up to N times (edge-triggered: the condition must evaluate false between fires); timer-only conditions cannot be combined with maxFires>1.",
			"Prefer first-class process/port/url/file/timer leaves before exec. Exec leaves run arbitrary local commands; set allowExec only after user approval.",
		],
		parameters: Type.Object({
			label: Type.Optional(Type.String({ description: "Short human-readable name for this watcher" })),
			condition: Type.Any({ description: "Condition tree. Groups: {op:'and'|'or'|'not', children:[...]}, {any:[...]}, {all:[...]}, {not:{...}}. Leaves: timer/file/process/port/url/webhook/exec." }),
			resume: Type.String({ description: "Instruction to inject when the watcher fires" }),
			every: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Default polling interval inherited by file/process/port/url/exec leaves, e.g. '2s' or milliseconds" })),
			timeout: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Max time before waking anyway, e.g. '2m' or milliseconds. If omitted, the configured returnOn.defaultTimeout applies; values above returnOn.maxTimeout are rejected." })),
			webhook: Type.Optional(Type.Any({ description: "Optional HTTP webhook notified when the watcher fires. Use a URL string or {url, method, headers, timeout}." })),
			delivery: Type.Optional(Type.Any({ description: "Optional delivery. Use {mode:'wake'} for legacy same-session wake or {mode:'fork', notify:'ack-and-summary'|'summary'|'none', triggerParentOnSummary?:boolean, piCommand?:string} to handle the event in a background fork/sibling Pi session." })),
			parent: Type.Optional(Type.String({ enum: ["auto", "main", "current"], description: "Ownership/routing for watchers created inside fork handlers. auto (default) returns fork-created watchers to the inherited main dialog when available; main forces inherited main-dialog ownership; current keeps the watcher/callback owned by the creating fork/session." })),
			endTurn: Type.Optional(Type.Boolean({ description: "Whether registering this watcher should end the current assistant turn. Defaults to true. Set false only when the current turn can continue useful work without waiting for the condition." })),
			allowExec: Type.Optional(Type.Boolean({ description: "Required/confirmed when condition contains exec leaves" })),
			maxFires: Type.Optional(Type.Number({ description: "How many times this watcher should fire before it is retired. Defaults to 1. After each fire the condition must evaluate false at least once before it can fire again (edge-triggered). The watcher is also retired by its timeout, whichever comes first." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			await loadJobs();
			const condition = normalizeCondition(params.condition);
			prepareIncomingWebhooks(condition);
			const hasExec = conditionHasExec(condition);
			let allowExec = params.allowExec === true;
			if (hasExec && !allowExec) {
				if (!ctx.hasUI) {
					throw new Error("return_on condition contains exec leaves. Set allowExec=true only after user approval.");
				}
				allowExec = await ctx.ui.confirm("Allow return_on exec watcher?", "This watcher can run arbitrary local commands repeatedly. Approve it?", { timeout: 30_000 });
				if (!allowExec) throw new Error("User did not approve exec watcher.");
			}

			const returnOnConfig = await loadReturnOnConfig(ctx.cwd);
			const timeoutMs = parseRequestedJobTimeout(params.timeout, returnOnConfig);
			const webhook = normalizeWebhook(params.webhook);
			const delivery = normalizeDelivery(params.delivery, returnOnConfig);
			let maxFires = 1;
			if (params.maxFires !== undefined) {
				if (typeof params.maxFires !== "number" || !Number.isFinite(params.maxFires) || !Number.isInteger(params.maxFires) || params.maxFires < 1) {
					throw new Error("maxFires must be a positive integer");
				}
				maxFires = params.maxFires;
			}
			if (maxFires > 1 && conditionIsTimerOnly(condition)) {
				throw new Error("maxFires > 1 requires a re-armable condition. A timer-only condition cannot fire more than once because a passed deadline stays passed. Combine the timer with a file/process/port/url/exec/webhook leaf, or use multiple separate watchers.");
			}
			const parentRouting = normalizeParentRouting(params.parent);
			const inheritedParentSession = shouldUseInheritedParent(parentRouting) && hasInheritedParentEnv();
			const registrationSessionFile = getParentSessionFile(ctx, parentRouting);
			const registrationSessionId = getParentSessionId(ctx, parentRouting);
			const registrationSessionName = getParentSessionName(pi, parentRouting);
			const registrationIntercomTarget = resolveParentIntercomTarget(pi, ctx, parentRouting);
			const job: ReturnOnJob = {
				id: makeId(),
				label: params.label?.trim() || "return_on watcher",
				cwd: ctx.cwd,
				...(registrationSessionFile ? { sessionFile: registrationSessionFile } : {}),
				...(registrationSessionId ? { parentSessionId: registrationSessionId } : {}),
				...(registrationSessionName ? { parentSessionName: registrationSessionName } : {}),
				...(registrationIntercomTarget ? { parentIntercomTarget: registrationIntercomTarget } : {}),
				parentRouting,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				status: "active",
				condition,
				resume: params.resume,
				timeoutAt: Date.now() + timeoutMs,
				allowExec,
				...(params.every !== undefined ? { every: params.every } : {}),
				...(webhook ? { webhook } : {}),
				...(params.delivery !== undefined || delivery.mode !== "wake" ? { delivery } : {}),
				...(params.endTurn === false ? { endTurn: false } : {}),
				...(maxFires > 1 ? { maxFires } : {}),
				fireCount: 0,
				latches: {},
				leafState: {},
			};
			if (conditionHasIncomingWebhook(job.condition)) await ensureIncomingWebhookServer(pi);
			jobs.push(job);
			await saveJobs();
			await appendLifecycleAudit("job_registered", { id: job.id, label: job.label, cwd: job.cwd, sessionFile: job.sessionFile, registeredFromSessionFile: currentSessionFile, parentRouting, inheritedParentSession, createdAt: job.createdAt, timeoutAt: job.timeoutAt, deliveryMode: job.delivery?.mode ?? "wake", maxFires });
			try {
				pi.appendEntry?.("return-on-registered", { id: job.id, label: job.label, createdAt: job.createdAt, condition: job.condition });
			} catch {
				// Best-effort audit trail.
			}
			ensureTicker(pi);
			const incomingWebhooks = incomingWebhookUrls(job);
			const webhookText = incomingWebhooks.length > 0 ? `Incoming webhook URL(s):\n${incomingWebhooks.map((hook) => `- ${hook.method} ${hook.url}`).join("\n")}` : "";
			const endTurn = params.endTurn !== false;
			return {
				content: [{ type: "text", text: formatRegisteredJobMessage(job, timeoutMs, returnOnConfig.maxTimeoutMs, maxFires, endTurn, webhookText) }],
				details: { job, incomingWebhooks },
				terminate: endTurn,
			};
		},
	});

	pi.registerTool({
		name: "return_on_cancel",
		label: "Cancel Return On",
		description: "Cancel a background return_on watcher by id.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			await loadJobs();
			const session = ctx.sessionManager.getSessionFile() ?? undefined;
			const job = jobs.find((candidate) => candidate.id === params.id && jobVisibleForSession(candidate, session));
			if (!job) throw new Error(`No return_on job found for '${params.id}'`);
			job.status = "cancelled";
			job.cancelledAt = Date.now();
			job.updatedAt = job.cancelledAt;
			await saveJobs();
			await appendLifecycleAudit("job_cancelled", { id: job.id, label: job.label, cancelledAt: job.cancelledAt });
			ensureTicker(pi);
			return { content: [{ type: "text", text: `Cancelled ${job.id}.` }], details: { job } };
		},
	});

	pi.registerTool({
		name: "return_on_list",
		label: "List Return On",
		description: "List return_on watcher jobs for this session.",
		parameters: Type.Object({ status: Type.Optional(StringEnum(["active", "fired", "cancelled", "all"] as const)) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			await loadJobs();
			const session = ctx.sessionManager.getSessionFile() ?? undefined;
			const status = params.status ?? "active";
			const relevant = jobs.filter((job) => jobVisibleForSession(job, session) && (status === "all" || job.status === status));
			return {
				content: [{ type: "text", text: relevant.length ? relevant.map(summarizeJob).join("\n") : `No ${status} return_on jobs.` }],
				details: { jobs: relevant },
			};
		},
	});

	pi.registerTool({
		name: "return_on_prune",
		label: "Prune Return On State",
		description: "Prune old retained return_on jobs, delivered fired-event capsules, completed handler runs/artifacts, and direct-wait audit entries. Defaults to 30 days and 5000 audit entries.",
		parameters: Type.Object({
			dryRun: Type.Optional(Type.Boolean()),
			retentionDays: Type.Optional(Type.Number()),
			auditMaxEntries: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			await loadJobs();
			await loadHandlers();
			if (params.retentionDays !== undefined && (typeof params.retentionDays !== "number" || !Number.isFinite(params.retentionDays) || params.retentionDays < 0)) {
				throw new Error("retentionDays must be a non-negative number");
			}
			if (params.auditMaxEntries !== undefined && (typeof params.auditMaxEntries !== "number" || !Number.isSafeInteger(params.auditMaxEntries) || params.auditMaxEntries < 0)) {
				throw new Error("auditMaxEntries must be a non-negative integer");
			}
			const retentionDays = params.retentionDays;
			const auditMaxEntries = params.auditMaxEntries;
			const summary = await pruneState({
				dryRun: params.dryRun === true,
				...(retentionDays !== undefined ? { retentionMs: Math.round(retentionDays * 86_400_000) } : {}),
				...(auditMaxEntries !== undefined ? { auditMaxEntries } : {}),
			});
			return { content: [{ type: "text", text: formatPruneSummary(summary) }], details: { summary } };
		},
	});

	pi.registerTool({
		name: "return_on_status",
		label: "Return On Status",
		description: "Show detailed status for a return_on watcher by id, including condition tree, leaf checks, latches, delivery, and resume instruction.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			await loadJobs();
			const session = ctx.sessionManager.getSessionFile() ?? undefined;
			const job = jobs.find((candidate) => candidate.id === params.id && jobVisibleForSession(candidate, session));
			if (!job) throw new Error(`No return_on job found for '${params.id}'`);
			return { content: [{ type: "text", text: formatJobDetails(job) }], details: { job } };
		},
	});

	pi.registerTool({
		name: "return_on_handlers",
		label: "List Return On Handlers",
		description: "List background fork/sibling handlers launched for fired return_on jobs.",
		parameters: Type.Object({ status: Type.Optional(StringEnum(["starting", "running", "complete", "failed", "all"] as const)) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			await loadHandlers();
			await reconcileHandlerRunsOnStartup(pi, undefined, false);
			await loadHandlers();
			const session = ctx.sessionManager.getSessionFile() ?? undefined;
			const status = params.status ?? "all";
			const relevant = handlerRuns.filter((run) => handlerVisibleForSession(run, session) && (status === "all" || run.status === status));
			const text = relevant.length
				? relevant.map((run) => `${run.id} [${run.status}] job=${run.jobId} pid=${run.pid ?? "-"} dir=${run.dir}`).join("\n")
				: `No ${status} return_on handlers.`;
			return { content: [{ type: "text", text }], details: { handlers: relevant } };
		},
	});

	pi.registerTool({
		name: "return_on_fired_events",
		label: "List Return On Fired Events",
		description: "List durable fired-event capsules used for restart-safe return_on delivery.",
		parameters: Type.Object({ status: Type.Optional(StringEnum(["pending", "delivered", "failed", "all"] as const)), limit: Type.Optional(Type.Number()) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			const session = ctx.sessionManager.getSessionFile() ?? undefined;
			const status = params.status ?? "all";
			const requestedLimit = typeof params.limit === "number" ? params.limit : undefined;
			const limit = requestedLimit !== undefined && Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 1000) : 50;
			const events = (await readFiredEventFiles())
				.filter(({ event }) => !event.sessionFile || !session || event.sessionFile === session)
				.filter(({ event }) => status === "all" || (status === "pending" ? event.deliveryStatus === "pending" : status === "delivered" ? !!event.deliveredAt : event.deliveryStatus === "failed"))
				.slice(0, limit)
				.map(({ event }) => event);
			return { content: [{ type: "text", text: formatFiredEvents(events) }], details: { firedEvents: events } };
		},
	});
}
