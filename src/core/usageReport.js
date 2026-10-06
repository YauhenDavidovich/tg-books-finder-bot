import { SEARCH_ERRORS } from "./searchLog.js";

const DAY_MS = 86_400_000;

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Nearest-rank percentile of an ascending array.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function countBy(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/**
 * Aggregates search_log rows over the last `days` UTC days (today included).
 * Limit rejections are counted on their own and left out of everything else:
 * nothing was searched for them.
 */
export function summarizeSearchLog(rows, { days = 30, today = new Date().toISOString().slice(0, 10) } = {}) {
  const dayList = Array.from({ length: days }, (_, i) =>
    new Date(Date.parse(today) - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10)
  );
  const perDay = new Map(dayList.map((day) => [day, { day, searches: 0, text: 0, photo: 0, owner: 0, cacheHits: 0, failed: 0, limit: 0 }]));

  const searches = [];
  let limit = 0;
  for (const r of rows) {
    const d = perDay.get(String(r.ts).slice(0, 10));
    if (!d) continue;
    if (r.error_kind === SEARCH_ERRORS.LIMIT) {
      d.limit += 1;
      limit += 1;
      continue;
    }
    searches.push(r);
    d.searches += 1;
    d[r.kind] += 1;
    d.owner += r.is_owner ? 1 : 0;
    d.cacheHits += r.cache_hit ? 1 : 0;
    d.failed += r.ok ? 0 : 1;
  }

  const daily = [...perDay.values()];
  const totals = daily.map((d) => d.searches).sort((a, b) => a - b);
  const others = searches.filter((r) => !r.is_owner);

  const withLlm = searches.filter((r) => r.via);
  const direct = withLlm.filter((r) => r.via === "direct").length;

  const latency = [];
  for (const kind of ["text", "photo"]) {
    for (const via of ["freellmapi", "direct"]) {
      const ms = withLlm
        .filter((r) => r.kind === kind && r.via === via && r.latency_ms != null)
        .map((r) => r.latency_ms)
        .sort((a, b) => a - b);
      if (ms.length) latency.push({ kind, via, n: ms.length, median: median(ms), p90: percentile(ms, 90) });
    }
  }

  return {
    from: dayList[0],
    to: today,
    days,
    daily,
    searches: searches.length,
    text: searches.filter((r) => r.kind === "text").length,
    photo: searches.filter((r) => r.kind === "photo").length,
    owner: searches.length - others.length,
    others: others.length,
    otherUsers: new Set(others.map((r) => r.user_hash).filter(Boolean)).size,
    cacheHits: searches.filter((r) => r.cache_hit).length,
    limit,
    perDay: {
      max: totals.at(-1) ?? 0,
      mean: totals.reduce((a, b) => a + b, 0) / days,
      median: median(totals) ?? 0,
    },
    via: { freellmapi: withLlm.length - direct, direct },
    fallbackPct: withLlm.length ? (100 * direct) / withLlm.length : null,
    models: countBy(withLlm.flatMap((r) => String(r.model || "").split("+").filter(Boolean))),
    latency,
    outcomes: countBy(searches.map((r) => (r.ok ? "ok" : r.error_kind || SEARCH_ERRORS.ERROR))),
  };
}
