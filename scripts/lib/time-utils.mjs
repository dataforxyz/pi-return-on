export function parseDurationMs(value, unit = "s") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const normalized = String(unit || "s").toLowerCase();
  const multiplier = normalized === "" || normalized === "s"
    ? 1000
    : normalized === "m"
      ? 60_000
      : normalized === "h"
        ? 3_600_000
        : normalized === "d"
          ? 86_400_000
          : normalized === "ms"
            ? 1
            : undefined;
  return multiplier === undefined ? undefined : Math.round(numeric * multiplier);
}
