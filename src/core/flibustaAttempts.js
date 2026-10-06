import { norm } from "./matching.js";

// Universal attempt builder for a Gemini text-search query result.
// Includes the title_ru/author_ru enrichment fields (mirroring
// buildFlibustaAttemptsFromVisionItem below) since Gemini sometimes answers
// in English for a famous work (e.g. "We" / "Yevgeny Zamyatin" for "Замятин
// Мы"), which a Russian-only catalog like Flibusta won't match at all.
export function buildFlibustaAttemptsFromQuery(q, input) {
  const attempts = [];
  const add = (title, author = null) => {
    const t = String(title || "").trim();
    const a = String(author || "").trim();
    if (!t) return;
    attempts.push({ title: t, author: a || null });
  };

  if (q?.title_ru) add(q.title_ru, q.author_ru || q.author || null);
  if (q?.title) add(q.title, q.author || null);
  if (q?.title) add(q.title, null);
  if (q?.query) add(q.query, null);
  if (input) add(input, null);

  return dedupAttempts(attempts);
}

// Uses the Gemini Vision enrichment fields (title_ru/author_ru, variants)
// that were previously computed and thrown away - see P0-1 in
// PRIORITIZED_FINDINGS.md. Each variant gets its own Flibusta attempt so the
// cross-script (EN cover -> RU catalog) matching the enrichment step exists
// for actually gets used.
export function buildFlibustaAttemptsFromVisionItem(item) {
  const attempts = [];
  const add = (title, author = null) => {
    const t = String(title || "").trim();
    const a = String(author || "").trim();
    if (!t) return;
    attempts.push({ title: t, author: a || null });
  };

  // Vision models sometimes return a confidently wrong author (and the
  // RU/EN enrichment then translates that wrong author), so each title is
  // also tried on its own - explicitly, not only if the model happened to
  // put a bare title into variants.
  add(item?.title, item?.author);
  add(item?.title, null);
  add(item?.title_ru, item?.author_ru);
  add(item?.title_ru, null);
  add(item?.title_en, item?.author_en);
  add(item?.title_en, null);
  for (const v of Array.isArray(item?.variants) ? item.variants : []) add(v, null);

  return dedupAttempts(attempts);
}

function dedupAttempts(attempts) {
  const seen = new Set();
  const uniq = [];
  for (const a of attempts) {
    const key = `${norm(a.title)}|${norm(a.author || "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(a);
  }
  return uniq;
}
