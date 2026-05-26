export function parseDuration(input: string | number | undefined, fallbackMs?: number): number | undefined {
	if (input === undefined || input === null || input === "") return fallbackMs;
	if (typeof input === "number" && Number.isFinite(input)) return input;
	if (typeof input !== "string") return fallbackMs;
	let trimmed = input.trim();
	if (!trimmed) return fallbackMs;
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === "string") trimmed = parsed.trim();
		} catch {
			trimmed = trimmed.slice(1, -1).trim();
		}
	}
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

export function parsePositiveDurationSetting(value: unknown, fallbackMs: number, name: string): number {
	const parsed = parseDuration(typeof value === "string" || typeof value === "number" ? value : undefined, fallbackMs);
	if (parsed === undefined || parsed <= 0) throw new Error(`${name} must be a positive duration`);
	return parsed;
}

export function parseShellSleepDurationMs(value: string, unit = "s"): number | undefined {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return undefined;
	const normalizedUnit = unit.toLowerCase();
	const multiplier = normalizedUnit === "" || normalizedUnit === "s"
		? 1000
		: normalizedUnit === "m"
			? 60_000
			: normalizedUnit === "h"
				? 3_600_000
				: normalizedUnit === "d"
					? 86_400_000
					: normalizedUnit === "ms"
						? 1
						: undefined;
	return multiplier === undefined ? undefined : Math.round(numeric * multiplier);
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}
