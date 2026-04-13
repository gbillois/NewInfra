// Period boundary helpers. All timestamps are unix seconds, UTC.
// A "day" synthesis covers 00:00:00 → 23:59:59 UTC.
// A "week" is a rolling 7-day window ending at `ref`.
// A "fortnight" is 15-day.
// A "month" is 30-day rolling (simpler than calendar months; matches the
// user's request for "1 mois" as a time-window, not a calendar month).

const DAY_SECS = 86400;

export function periodBounds(period, refEpochSec) {
  const ref = Number.isFinite(refEpochSec)
    ? refEpochSec
    : Math.floor(Date.now() / 1000);
  // Align `ref` to the end of its UTC day so "today" includes everything
  // published today UTC.
  const endOfDay = ref - (ref % DAY_SECS) + DAY_SECS - 1;
  const startOfDay = endOfDay - DAY_SECS + 1;

  switch (period) {
    case "day":
      return { start: startOfDay, end: endOfDay };
    case "week":
      return { start: endOfDay - 7 * DAY_SECS + 1, end: endOfDay };
    case "fortnight":
      return { start: endOfDay - 15 * DAY_SECS + 1, end: endOfDay };
    case "month":
      return { start: endOfDay - 30 * DAY_SECS + 1, end: endOfDay };
    default:
      throw new Error(`Unknown period: ${period}`);
  }
}

export function isValidPeriod(p) {
  return p === "day" || p === "week" || p === "fortnight" || p === "month";
}

export function formatDateUTC(epochSec) {
  const d = new Date(epochSec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
