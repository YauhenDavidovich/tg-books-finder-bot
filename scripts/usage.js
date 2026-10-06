#!/usr/bin/env node
// Usage report from search_log: searches per day, text/photo, via/models,
// fallback rate, LLM latency, outcomes. Opens the DB read-only.
//
//   node scripts/usage.js [--days 30] [--db path/to/bot.sqlite3]
//
// On Railway (the DB lives on the bot's volume):
//   railway ssh -s <bot service> node scripts/usage.js
import "dotenv/config";
import Database from "better-sqlite3";
import { config } from "../src/config.js";
import { listSearchLogSince } from "../src/storage/searchLogRepo.js";
import { summarizeSearchLog } from "../src/core/usageReport.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const days = Number(arg("days", 30));
const dbFile = arg("db", config.DB_FILE);
if (!Number.isInteger(days) || days < 1) {
  console.error("--days must be a positive integer");
  process.exit(1);
}

let rows;
try {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  rows = listSearchLogSince(db, since);
} catch (err) {
  const hint = /no such table/.test(err?.message) ? " - the bot hasn't run with search_log yet" : "";
  console.error(`Can't read ${dbFile}: ${err?.message || err}${hint}`);
  process.exit(1);
}

const s = summarizeSearchLog(rows, { days });
const pct = (n, total) => (total ? `${((100 * n) / total).toFixed(1)}%` : "-");
const pad = (v, n) => String(v).padStart(n);

console.log(`search_log ${s.from} … ${s.to} (${s.days} UTC days, today is partial), ${dbFile}\n`);
console.log(
  `searches: ${s.searches} (text ${s.text}, photo ${s.photo}); owner ${s.owner}, others ${s.others} ` +
    `(${s.otherUsers} users by hash); cache hits ${s.cacheHits}; limit rejections ${s.limit}`
);
console.log(`per day: max ${s.perDay.max}, mean ${s.perDay.mean.toFixed(2)}, median ${s.perDay.median}\n`);

const active = s.daily.filter((d) => d.searches || d.limit);
if (active.length) {
  console.log("day          searches  text photo owner cache failed limit");
  for (const d of active) {
    console.log(
      `${d.day}  ${pad(d.searches, 8)} ${pad(d.text, 5)} ${pad(d.photo, 5)} ${pad(d.owner, 5)} ${pad(d.cacheHits, 5)} ${pad(d.failed, 6)} ${pad(d.limit, 5)}`
    );
  }
  console.log("");
}

const llmTotal = s.via.freellmapi + s.via.direct;
console.log(
  `LLM searches: ${llmTotal}; freellmapi ${s.via.freellmapi}, direct ${s.via.direct} -> fallback ${pct(s.via.direct, llmTotal)}`
);
console.log("  (direct = at least one step answered by Gemini directly; with LLM_PROVIDER=direct that's every search)");
for (const [model, n] of s.models) console.log(`  ${pad(n, 5)}  ${model}`);

if (s.latency.length) {
  console.log("\nLLM latency, ms (median / p90):");
  for (const l of s.latency) console.log(`  ${l.kind.padEnd(5)} ${l.via.padEnd(10)} ${l.median} / ${l.p90}  (n=${l.n})`);
}

if (s.outcomes.length) {
  console.log(`\noutcomes: ${s.outcomes.map(([k, n]) => `${k} ${n} (${pct(n, s.searches)})`).join(", ")}`);
}
