import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const EXTENSION_NAME = "return-on";
const STATE_DIR = path.join(os.homedir(), ".local", "state", "pi-return-on");
const JOBS_FILE = path.join(STATE_DIR, "jobs.json");
const DEFAULT_TICK_MS = 1000;
const DEFAULT_EXEC_EVERY_MS = 5000;
const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
const DEFAULT_FILE_EVERY_MS = 1000;
const DEFAULT_PROCESS_EVERY_MS = 2000;
const DEFAULT_PORT_EVERY_MS = 2000;
const DEFAULT_URL_EVERY_MS = 5000;
const DEFAULT_PORT_TIMEOUT_MS = 1000;
const DEFAULT_URL_TIMEOUT_MS = 5000;
const MIN_EXEC_EVERY_MS = 2000;
const OUTPUT_LIMIT_BYTES = 50 * 1024;

type GroupOp = "and" | "or" | "not";
type Runner = "sh" | "bash" | "xonsh" | "python" | "node";

const SUPPORTED_RUNNERS = new Set<Runner>(["sh", "bash", "xonsh", "python", "node"]);

type Condition = GroupCondition | TimerCondition | FileCondition | ExecCondition | ProcessCondition | PortCondition | UrlCondition;

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

interface ReturnOnJob {
	id: string;
	label: string;
	cwd: string;
	sessionFile?: string;
	createdAt: number;
	updatedAt: number;
	status: "active" | "fired" | "cancelled";
	condition: Condition;
	resume: string;
	timeoutAt?: number;
	allowExec?: boolean;
	every?: string | number;
	latches: Record<string, LeafLatch>;
	leafState: Record<string, LeafState>;
	fireReason?: string;
	firedAt?: number;
	cancelledAt?: number;
}

interface JobsState {
	version: 1;
	jobs: ReturnOnJob[];
}

interface EvalResult {
	value: boolean;
	summary: string;
	details?: unknown;
}

let jobs: ReturnOnJob[] = [];
let currentSessionFile: string | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let latestCtx: ExtensionContext | undefined;
let ticking = false;

function nowIso(ts = Date.now()): string {
	return new Date(ts).toISOString();
}

function makeId(): string {
	return `ro_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseDuration(input: string | number | undefined, fallbackMs?: number): number | undefined {
	if (input === undefined || input === null || input === "") return fallbackMs;
	if (typeof input === "number" && Number.isFinite(input)) return input;
	if (typeof input !== "string") return fallbackMs;
	const trimmed = input.trim();
	if (!trimmed) return fallbackMs;
	const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?$/i);
	if (!match) return fallbackMs;
	const value = Number(match[1]);
	const unit = (match[2] ?? "ms").toLowerCase();
	const multipliers: Record<string, number> = {
		ms: 1,
		s: 1000,
		sec: 1000,
		secs: 1000,
		m: 60_000,
		min: 60_000,
		mins: 60_000,
		h: 3_600_000,
		hr: 3_600_000,
		hrs: 3_600_000,
		d: 86_400_000,
		day: 86_400_000,
		days: 86_400_000,
	};
	return Math.max(0, Math.round(value * (multipliers[unit] ?? 1)));
}

function getPollingInterval(job: ReturnOnJob, conditionEvery: string | number | undefined, fallbackMs: number, minMs = 0): number {
	return Math.max(parseDuration(conditionEvery ?? job.every, fallbackMs) ?? fallbackMs, minMs);
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

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
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

async function saveJobs(): Promise<void> {
	await fsp.mkdir(STATE_DIR, { recursive: true });
	const tmp = `${JOBS_FILE}.${process.pid}.${Date.now()}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify({ version: 1, jobs } satisfies JobsState, null, 2), "utf8");
	await fsp.rename(tmp, JOBS_FILE);
}

function activeJobsForCurrentSession(): ReturnOnJob[] {
	return jobs.filter((job) => job.status === "active" && (!job.sessionFile || !currentSessionFile || job.sessionFile === currentSessionFile));
}

function updateStatus(ctx = latestCtx): void {
	if (!ctx?.hasUI) return;
	const count = activeJobsForCurrentSession().length;
	ctx.ui.setStatus(EXTENSION_NAME, count > 0 ? `return_on: ${count}` : undefined);
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

function ensureTicker(pi: ExtensionAPI): void {
	if (activeJobsForCurrentSession().length > 0) startTicker(pi);
	else stopTicker();
	updateStatus();
}

function normalizeCondition(input: unknown): Condition {
	if (!isObject(input)) throw new Error("condition must be an object");
	if (Array.isArray(input.any)) {
		if (input.any.length === 0) throw new Error("any group requires children");
		return { op: "or", children: input.any.map(normalizeCondition) };
	}
	if (Array.isArray(input.all)) {
		if (input.all.length === 0) throw new Error("all group requires children");
		return { op: "and", children: input.all.map(normalizeCondition) };
	}
	if (input.not !== undefined) return { op: "not", children: [normalizeCondition(input.not)] };
	if (typeof input.op === "string") {
		const op = input.op.toLowerCase();
		if (op !== "and" && op !== "or" && op !== "not") throw new Error(`unsupported group op '${input.op}'`);
		const childrenInput = Array.isArray(input.children) ? input.children : [];
		if (op !== "not" && childrenInput.length === 0) throw new Error(`${op} group requires children`);
		if (op === "not" && childrenInput.length !== 1) throw new Error("not group requires exactly one child");
		return { ...input, op, children: childrenInput.map(normalizeCondition) } as Condition;
	}
	if (input.type === "timer") return input as TimerCondition;
	if (input.type === "file") {
		if (typeof input.path !== "string" || !input.path.trim()) throw new Error("file condition requires path");
		return input as FileCondition;
	}
	if (input.type === "exec") {
		if (typeof input.command !== "string" && typeof input.code !== "string") {
			throw new Error("exec condition requires command or code");
		}
		for (const field of ["runner", "shell"] as const) {
			const runner = input[field];
			if (runner !== undefined && (!SUPPORTED_RUNNERS.has(runner as Runner) || typeof runner !== "string")) {
				throw new Error(`unsupported exec ${field} '${String(runner)}'`);
			}
		}
		return input as ExecCondition;
	}
	if (input.type === "process") {
		if (input.pid !== undefined && (typeof input.pid !== "number" || !Number.isInteger(input.pid) || input.pid <= 0)) {
			throw new Error("process condition pid must be a positive integer");
		}
		if (input.pid === undefined && typeof input.name !== "string" && typeof input.commandContains !== "string" && typeof input.matches !== "string") {
			throw new Error("process condition requires pid, name, commandContains, or matches");
		}
		return input as ProcessCondition;
	}
	if (input.type === "port") {
		if (typeof input.port !== "number" || !Number.isInteger(input.port) || input.port <= 0 || input.port > 65535) {
			throw new Error("port condition requires port between 1 and 65535");
		}
		return input as PortCondition;
	}
	if (input.type === "url") {
		if (typeof input.url !== "string" || !input.url.trim()) throw new Error("url condition requires url");
		try {
			new URL(input.url);
		} catch {
			throw new Error(`url condition has invalid url '${String(input.url)}'`);
		}
		return input as UrlCondition;
	}
	throw new Error(`unsupported condition type '${String(input.type)}'`);
}

function isGroupCondition(condition: Condition): condition is GroupCondition {
	return "op" in condition;
}

function conditionHasExec(condition: Condition): boolean {
	if ("type" in condition && condition.type === "exec") return true;
	if (isGroupCondition(condition)) return condition.children.some(conditionHasExec);
	return false;
}

function truncateText(value: string, limit = OUTPUT_LIMIT_BYTES): string {
	const buf = Buffer.from(value);
	if (buf.length <= limit) return value;
	return `${buf.subarray(0, limit).toString("utf8")}\n[truncated ${buf.length - limit} bytes]`;
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
	else result = { value: false, summary: `unknown leaf ${(condition as { type?: string }).type}` };

	if (latchLeaves && result.value) {
		job.latches[key] = { trueAt: Date.now(), summary: result.summary, details: result.details };
		job.updatedAt = Date.now();
	}
	return result;
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

	if (condition.contains !== undefined || condition.matches !== undefined) {
		let text = "";
		try {
			text = await fsp.readFile(filePath, "utf8");
		} catch {
			text = "";
		}
		if (condition.contains !== undefined) checks.push({ ok: text.includes(condition.contains), label: `${condition.path} contains '${condition.contains}'` });
		if (condition.matches !== undefined) checks.push({ ok: new RegExp(condition.matches).test(text), label: `${condition.path} matches /${condition.matches}/` });
	}

	const ok = checks.length > 0 && checks.every((check) => check.ok);
	const summary = checks.map((check) => `${check.ok ? "✓" : "·"} ${check.label}`).join(", ") || `file ${condition.path}`;
	state.lastSummary = summary;
	state.lastValue = ok;
	return { value: ok, summary, details: { path: filePath } };
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

async function evaluateProcess(job: ReturnOnJob, condition: ProcessCondition, key: string): Promise<EvalResult> {
	const state = job.leafState[key] ??= {};
	const everyMs = getPollingInterval(job, condition.every, DEFAULT_PROCESS_EVERY_MS);
	const now = Date.now();
	if (state.lastCheckAt && now - state.lastCheckAt < everyMs) {
		return { value: state.lastValue ?? false, summary: state.lastSummary ?? "process check waiting for interval" };
	}
	state.lastCheckAt = now;

	const running = await isProcessRunning(condition);
	const wantsRunning = condition.exited === true || condition.state === "exited" ? false : condition.running ?? true;
	const ok = wantsRunning ? running : !running;
	const target = wantsRunning ? "running" : "exited";
	const subject = condition.pid !== undefined
		? `pid ${condition.pid}`
		: condition.name
			? `process name '${condition.name}'`
			: condition.commandContains
				? `command contains '${condition.commandContains}'`
				: `process matches /${condition.matches}/`;
	const summary = `${subject} is ${running ? "running" : "not running"}; target ${target}`;
	state.lastSummary = summary;
	state.lastValue = ok;
	return { value: ok, summary, details: { running, target } };
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
				const result = await evaluateCondition(job, job.condition);
				if (result.value) {
					await fireJob(pi, job, result.summary);
					changed = true;
				} else if (Object.keys(job.latches).length > 0) {
					changed = true;
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

async function fireJob(pi: ExtensionAPI, job: ReturnOnJob, reason: string): Promise<void> {
	if (job.status !== "active") return;
	job.status = "fired";
	job.firedAt = Date.now();
	job.updatedAt = job.firedAt;
	job.fireReason = reason;
	await saveJobs();
	const message = formatFireMessage(job, reason);
	try {
		pi.appendEntry?.("return-on-fired", { id: job.id, label: job.label, reason, firedAt: job.firedAt });
	} catch {
		// Best-effort audit trail.
	}
	pi.sendMessage(
		{
			customType: EXTENSION_NAME,
			content: message,
			display: true,
			details: { id: job.id, label: job.label, reason, latches: job.latches },
		},
		{ triggerTurn: true },
	);
}

function formatFireMessage(job: ReturnOnJob, reason: string): string {
	const latched = Object.entries(job.latches)
		.map(([key, latch]) => `- ${key}: ${latch.summary} at ${nowIso(latch.trueAt)}`)
		.join("\n") || "- none";
	return [
		`return_on fired: ${job.label} (${job.id})`,
		`Reason: ${reason}`,
		`Created: ${nowIso(job.createdAt)}`,
		`Fired: ${nowIso(job.firedAt ?? Date.now())}`,
		`CWD: ${job.cwd}`,
		"",
		"Latched leaves:",
		latched,
		"",
		"Resume instruction:",
		job.resume,
	].join("\n");
}

function summarizeJob(job: ReturnOnJob): string {
	const timeout = job.timeoutAt ? ` timeout=${nowIso(job.timeoutAt)}` : "";
	return `${job.id} [${job.status}] ${job.label}${timeout} cwd=${job.cwd}`;
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
	pi.registerMessageRenderer?.(EXTENSION_NAME, (message, _options, theme) => {
		return new Text(theme.fg("accent", "⏰ return_on\n") + message.content, 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		await loadJobs();
		ensureTicker(pi);
		if (ctx.hasUI && activeJobsForCurrentSession().length > 0) {
			ctx.ui.notify(`return_on watching ${activeJobsForCurrentSession().length} job(s)`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		stopTicker();
		latestCtx = undefined;
	});

	pi.registerCommand("return-on-list", {
		description: "List active/completed return_on jobs for this session",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			await loadJobs();
			const session = ctx.sessionManager.getSessionFile() ?? undefined;
			const relevant = jobs.filter((job) => !job.sessionFile || !session || job.sessionFile === session);
			const text = relevant.length ? relevant.map(summarizeJob).join("\n") : "No return_on jobs for this session.";
			ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("return-on-status", {
		description: "Show details for a return_on job: /return-on-status <id>",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			await loadJobs();
			const id = args.trim();
			const job = jobs.find((candidate) => candidate.id === id);
			if (!job) {
				ctx.ui.notify(`No return_on job found for '${id}'`, "warning");
				return;
			}
			ctx.ui.notify(`${summarizeJob(job)}\n${JSON.stringify({ latches: job.latches, leafState: job.leafState }, null, 2)}`, "info");
		},
	});

	pi.registerCommand("return-on-cancel", {
		description: "Cancel a return_on job: /return-on-cancel <id>",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			await loadJobs();
			const id = args.trim();
			const job = jobs.find((candidate) => candidate.id === id);
			if (!job) {
				ctx.ui.notify(`No return_on job found for '${id}'`, "warning");
				return;
			}
			job.status = "cancelled";
			job.cancelledAt = Date.now();
			job.updatedAt = job.cancelledAt;
			await saveJobs();
			ensureTicker(pi);
			ctx.ui.notify(`Cancelled ${id}`, "info");
		},
	});

	pi.registerTool({
		name: "return_on",
		label: "Return On",
		description: "Register a background condition watcher and wake the agent later when the condition tree becomes true. Supports timer, file, process, port, url, and exec leaves plus and/or/not groups.",
		promptSnippet: "Register timers/watchers that resume Pi later without spending model tokens waiting",
		promptGuidelines: [
			"Use return_on when waiting for time, files, logs, processes, ports, URLs, command checks, builds, renders, servers, or other external state instead of polling in the conversation.",
			"return_on conditions latch once true; combine leaves with op='and', op='or', op='not' or shorthand any/all/not.",
			"Prefer first-class process/port/url/file/timer leaves before exec. Exec leaves run arbitrary local commands; set allowExec only when the user approved the command or after confirmation.",
		],
		parameters: Type.Object({
			label: Type.Optional(Type.String({ description: "Short human-readable name for this watcher" })),
			condition: Type.Any({ description: "Condition tree. Groups: {op:'and'|'or'|'not', children:[...]}, {any:[...]}, {all:[...]}, {not:{...}}. Leaves: timer/file/process/port/url/exec." }),
			resume: Type.String({ description: "Instruction to inject when the watcher fires" }),
			every: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Default polling interval inherited by file/process/port/url/exec leaves, e.g. '2s' or milliseconds" })),
			timeout: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Optional max time before waking anyway, e.g. '30m' or milliseconds" })),
			allowExec: Type.Optional(Type.Boolean({ description: "Required/confirmed when condition contains exec leaves" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			await loadJobs();
			const condition = normalizeCondition(params.condition);
			const hasExec = conditionHasExec(condition);
			let allowExec = params.allowExec === true;
			if (hasExec && !allowExec) {
				if (!ctx.hasUI) {
					throw new Error("return_on condition contains exec leaves. Set allowExec=true only after user approval.");
				}
				allowExec = await ctx.ui.confirm("Allow return_on exec watcher?", "This watcher can run arbitrary local commands repeatedly. Approve it?", { timeout: 30_000 });
				if (!allowExec) throw new Error("User did not approve exec watcher.");
			}

			const timeoutMs = parseDuration(params.timeout);
			const job: ReturnOnJob = {
				id: makeId(),
				label: params.label?.trim() || "return_on watcher",
				cwd: ctx.cwd,
				sessionFile: currentSessionFile,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				status: "active",
				condition,
				resume: params.resume,
				...(timeoutMs !== undefined ? { timeoutAt: Date.now() + timeoutMs } : {}),
				allowExec,
				...(params.every !== undefined ? { every: params.every } : {}),
				latches: {},
				leafState: {},
			};
			jobs.push(job);
			await saveJobs();
			try {
				pi.appendEntry?.("return-on-registered", { id: job.id, label: job.label, createdAt: job.createdAt, condition: job.condition });
			} catch {
				// Best-effort audit trail.
			}
			ensureTicker(pi);
			return {
				content: [{ type: "text", text: `Registered return_on job ${job.id}: ${job.label}. I will wake the session when it fires; do not poll or wait manually.` }],
				details: { job },
				terminate: true,
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
			const job = jobs.find((candidate) => candidate.id === params.id);
			if (!job) throw new Error(`No return_on job found for '${params.id}'`);
			job.status = "cancelled";
			job.cancelledAt = Date.now();
			job.updatedAt = job.cancelledAt;
			await saveJobs();
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
			const relevant = jobs.filter((job) => (!job.sessionFile || !session || job.sessionFile === session) && (status === "all" || job.status === status));
			return {
				content: [{ type: "text", text: relevant.length ? relevant.map(summarizeJob).join("\n") : `No ${status} return_on jobs.` }],
				details: { jobs: relevant },
			};
		},
	});
}
