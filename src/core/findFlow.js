import { Markup } from "telegraf";
import { config } from "../config.js";
import { norm, scoreMatch, shortTitle } from "./matching.js";
import { replyChunked } from "./telegramUtils.js";
import { isDebugAllowed, getUserId } from "../access/accessControl.js";
import { searchBooks, searchByAuthor, getBookInfo, getUrl, toAbsoluteUrl } from "../providers/flibustaProvider.js";
import { geminiDebugBookQueryFromText, parseBookQueryResult } from "../geminiTextSearch.js";
import { findBooksByQuery } from "../googleBooks.js";
import { replyWithFlibustaResult } from "../helpers/flibustaReply.js";
import { buildKindleButton } from "../kindle/kindleSender.js";

// scoreMatch's exact-title-only match already lands at 8 (6 exact + 2
// token-overlap stacking bonus - see PRIORITIZED_FINDINGS.md), so treat 8+
// as "confident enough to stop looking further" and skip the remaining,
// weaker attempts. Below that, keep trying every attempt and keep whichever
// scores highest overall, instead of stopping at the first one that merely
// clears tryFlibustaFirst's own (much lower) minScore=4 acceptance bar.
const STRONG_MATCH_SCORE = 8;

// Tries every attempt and keeps the best-scoring result, short-circuiting
// only once a strong match is found. Fixes a real bug: stopping at the
// first attempt to clear minScore=4 could lock in a weak false-positive
// (e.g. an English phrase substring-matching an unrelated book's bracketed
// alternate title) before a later, more specific attempt got a chance.
export async function pickBestFlibustaResult(ctx, attempts) {
  let best = null;

  for (const a of attempts) {
    const result = await tryFlibustaFirst(ctx, a);
    if (result?.book && (!best || result.score > best.score)) {
      best = result;
    }
    if (best && best.score >= STRONG_MATCH_SCORE) break;
  }

  return best;
}

function formatFlibustaList(list, limit = 5) {
  if (!Array.isArray(list) || list.length === 0) return "пусто";
  return list
    .slice(0, limit)
    .map((b, i) => {
      const id = b?.id ?? "?";
      const t = String(b?.title ?? "").slice(0, 120);
      const a = String(b?.author ?? "").slice(0, 80);
      return `${i + 1}) ${id} | ${t}${a ? `, ${a}` : ""}`;
    })
    .join("\n");
}

// Universal attempt builder for a Gemini text-search query result.
export function buildFlibustaAttemptsFromQuery(q, input) {
  const attempts = [];
  const add = (title, author = null) => {
    const t = String(title || "").trim();
    const a = String(author || "").trim();
    if (!t) return;
    attempts.push({ title: t, author: a || null });
  };

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

  add(item?.title, item?.author);
  add(item?.title_ru, item?.author_ru);
  add(item?.title_en, item?.author_en);
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

export async function tryFlibustaFirst(ctx, { title, author }) {
  const fullTitle = String(title ?? "").trim();
  const qAuthor = String(author ?? "").trim();
  const tShort = shortTitle(fullTitle);

  if (!tShort) return null;

  const queriesRaw = [qAuthor ? `${tShort} ${qAuthor}` : tShort, tShort, fullTitle].filter(Boolean);
  const queries = [...new Set(queriesRaw)];

  let candidates = [];

  for (const q of queries) {
    const list = await searchBooks(q, 40);

    if (config.FLIBUSTA_DEBUG && isDebugAllowed(ctx)) {
      const text = `FLIBUSTA searchBooks("${q}") -> ${Array.isArray(list) ? list.length : 0}\n` + formatFlibustaList(list, 5);
      await replyChunked(ctx, text);
    }

    if (Array.isArray(list) && list.length) candidates = candidates.concat(list);
  }

  if ((!candidates || candidates.length === 0) && qAuthor) {
    const byA = await searchByAuthor(qAuthor, 80);

    if (config.FLIBUSTA_DEBUG && isDebugAllowed(ctx)) {
      const text = `FLIBUSTA searchByAuthor("${qAuthor}") -> ${Array.isArray(byA) ? byA.length : 0}\n` + formatFlibustaList(byA, 5);
      await replyChunked(ctx, text);
    }

    if (Array.isArray(byA) && byA.length) candidates = candidates.concat(byA);
  }

  if (!candidates.length) return null;

  const uniq = [];
  const seen = new Set();
  for (const b of candidates) {
    const key = String(b?.id ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(b);
  }

  let best = null;
  let bestScore = -1;

  for (const b of uniq) {
    const s = scoreMatch(b, tShort, qAuthor);
    if (s > bestScore) {
      bestScore = s;
      best = b;
    }
  }

  const minScore = qAuthor ? 4 : 4;

  if (config.FLIBUSTA_DEBUG && isDebugAllowed(ctx)) {
    const picked = best
      ? `bestScore=${bestScore}, minScore=${minScore}\nBEST: ${best.id} | ${best.title}${best.author ? `, ${best.author}` : ""}`
      : `BEST: null`;
    await replyChunked(ctx, `FLIBUSTA picked:\n${picked}`);
  }

  if (!best || bestScore < minScore) return null;

  const info = await getBookInfo(best.id);
  return { book: best, info, score: bestScore };
}

export async function handleFindQuery({ ctx, input, db, cache }) {
  // Fetch Gemini exactly once and reuse it for both the debug preview and
  // the actual parsed query - two independent calls aren't guaranteed to
  // agree (Gemini 2.5 Flash's "thinking" adds variance even at temperature
  // 0), which previously let the debug preview show one answer while a
  // second, separate call silently returned a different one for the search.
  const raw = await geminiDebugBookQueryFromText(input);

  if (config.GEMINI_DEBUG && isDebugAllowed(ctx)) {
    const bodyPreview = String(raw?.rawBody || "").slice(0, 2000);
    const candPreview = String(raw?.candidateText || "").slice(0, 2000);
    const infoText =
      `GEMINI DEBUG\n` +
      `finishReason: ${raw?.finishReason || "-"}\n` +
      `status: ${raw?.status ?? "-"}\n\n` +
      `candidateText:\n${candPreview || "(empty)"}\n\n` +
      `rawBody preview:\n${bodyPreview || "(empty)"}`;

    await replyChunked(ctx, infoText);
  }

  const q = parseBookQueryResult(raw);
  const conf = Number(q?.confidence ?? 0) || 0;

  if (!q?.query) {
    await ctx.reply("Мало деталей. Добавь 2–3 штуки: страна, время, профессия героя, конфликт, жанр.", {
      message_thread_id: ctx.message?.message_thread_id,
    });
    return;
  }

  if (conf < 0.25) {
    await ctx.reply(`Уверенность низкая (${conf.toFixed(2)}), но я всё равно попробую поискать.`, {
      message_thread_id: ctx.message?.message_thread_id,
    });
  }

  const pseudoBestItem = {
    confidence: q.confidence ?? 0,
    evidence: [q.title ? `title:${q.title}` : null, q.author ? `author:${q.author}` : null, q.query ? `query:${q.query}` : null].filter(
      Boolean
    ),
  };

  const attempts = buildFlibustaAttemptsFromQuery(q, input);
  const flibustaResult = await pickBestFlibustaResult(ctx, attempts);

  const userId = getUserId(ctx);
  const cacheKey = `find:${norm(`${q.title || ""} ${q.author || ""} ${q.query || ""}`)}`;
  const kindleButton = flibustaResult?.book ? buildKindleButton(db, userId, flibustaResult.book) : null;

  const handled = await replyWithFlibustaResult({
    ctx,
    flibustaResult,
    bestItem: pseudoBestItem,
    toAbsoluteUrl,
    getUrl,
    cache,
    cacheKey,
    extraButtons: kindleButton ? [kindleButton] : [],
  });

  if (handled) return;

  const parts = [];
  if (q.title) parts.push(`intitle:"${q.title}"`);
  if (q.author) parts.push(`inauthor:"${q.author}"`);
  if (!parts.length) parts.push(q.query);

  const finalQuery = parts.join(" ").trim();
  const results = await findBooksByQuery(finalQuery, config.GOOGLE_BOOKS_API_KEY);

  if (!results.length) {
    await ctx.reply(`Не нашёл по запросу: ${q.query}\nПопробуй: больше деталей или имя автора.`, {
      message_thread_id: ctx.message?.message_thread_id,
    });
    return;
  }

  const top = results[0];
  const url = top.canonicalLink || `https://www.google.com/search?q=${encodeURIComponent(finalQuery)}`;
  const extra = Markup.inlineKeyboard([[Markup.button.url("Открыть", url)]]);

  const author = top.authors?.[0] ? `, ${top.authors[0]}` : "";

  await ctx.reply(`Похоже на:\n• ${top.title || q.query}${author}\n\nЗапрос: ${q.query}\nУверенность: ${(q.confidence ?? 0).toFixed(2)}`, {
    ...extra,
    message_thread_id: ctx.message?.message_thread_id,
  });
}
