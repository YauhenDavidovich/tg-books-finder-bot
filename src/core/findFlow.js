import crypto from "crypto";
import { Markup } from "telegraf";
import { config } from "../config.js";
import { norm, scoreMatch, shortTitle } from "./matching.js";
import { replyChunked } from "./telegramUtils.js";
import { isDebugAllowed, getUserId } from "../access/accessControl.js";
import { searchBooks, searchByAuthor, getBookInfo } from "../providers/flibustaProvider.js";
import { geminiDebugBookQueryFromText, parseBookQueryResult } from "../geminiTextSearch.js";
import { findBooksByQuery } from "../googleBooks.js";
import { createBoundedCache } from "./cache.js";

const MAX_CANDIDATES = 5;

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

// Searches Flibusta for one title/author attempt and returns every
// deduped candidate with its score (not just the best one), so callers can
// pool candidates across several attempts before deciding anything.
async function searchFlibustaCandidates(ctx, { title, author }) {
  const fullTitle = String(title ?? "").trim();
  const qAuthor = String(author ?? "").trim();
  const tShort = shortTitle(fullTitle);

  if (!tShort) return [];

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

  const uniq = [];
  const seen = new Set();
  for (const b of candidates) {
    const key = String(b?.id ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(b);
  }

  return uniq.map((book) => ({ book, score: scoreMatch(book, tShort, qAuthor) }));
}

// Pools candidates across every attempt (deduped by book id, keeping the
// highest score seen for each), instead of stopping at the first attempt
// that clears some threshold. That earlier approach could lock in a weak
// false-positive (e.g. an English phrase substring-matching an unrelated
// book's bracketed alternate title) before a later, more specific attempt -
// like the user's original untranslated input - got a chance to run at all.
export async function pickFlibustaCandidates(ctx, attempts, limit = MAX_CANDIDATES) {
  const byId = new Map();

  for (const attempt of attempts) {
    const scored = await searchFlibustaCandidates(ctx, attempt);
    for (const { book, score } of scored) {
      const id = String(book?.id ?? "");
      if (!id) continue;
      const existing = byId.get(id);
      if (!existing || score > existing.score) byId.set(id, { book, score });
    }
  }

  const ranked = [...byId.values()]
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (config.FLIBUSTA_DEBUG && isDebugAllowed(ctx)) {
    const text = ranked.length
      ? ranked.map((c, i) => `${i + 1}) score=${c.score} | ${c.book.id} | ${c.book.title}${c.book.author ? `, ${c.book.author}` : ""}`).join("\n")
      : "пусто";
    await replyChunked(ctx, `FLIBUSTA candidates (pooled, top ${limit}):\n${text}`);
  }

  return ranked;
}

// --- candidate picker UI (user always picks, per product decision) ---

// Bounded like the photo/text result cache (core/cache.js) - unpicked
// candidate lists shouldn't accumulate forever if users abandon them.
const pendingCandidatePicks = createBoundedCache(500);

function candidateButtonLabel(index) {
  return String(index + 1);
}

function candidateLine(index, book) {
  const t = String(book?.title ?? "").slice(0, 90);
  const a = String(book?.author ?? "").slice(0, 60);
  return `${index + 1}) ${t}${a ? `, ${a}` : ""}`;
}

// Shows the pooled candidates as numbered inline buttons and stores enough
// context (in-memory only - short-lived, like the Kindle-send tokens) for
// the bot.action handler in bot/actions.js to resolve a tap into a full
// reply. `onNone` is called if the user says none of the candidates match,
// letting each caller (text search vs photo search) define its own
// Google Books fallback without this module needing to know which one.
export async function presentFlibustaCandidates(ctx, { candidates, bestItem, cache, cacheKey, onNone }) {
  const userId = getUserId(ctx);
  const token = crypto.randomBytes(8).toString("hex");

  pendingCandidatePicks.set(token, { userId, candidates, bestItem, cache, cacheKey, onNone, createdAt: Date.now() });

  const lines = candidates.map((c, i) => candidateLine(i, c.book));
  const text = `Нашёл во Флибусте несколько вариантов, выбери нужный:\n\n${lines.join("\n")}`;

  const pickButtons = candidates.map((c, i) => Markup.button.callback(candidateButtonLabel(i), `flib:pick:${token}:${i}`));
  const rows = [];
  for (let i = 0; i < pickButtons.length; i += MAX_CANDIDATES) rows.push(pickButtons.slice(i, i + MAX_CANDIDATES));
  rows.push([Markup.button.callback("❌ Ничего не подходит", `flib:pick:${token}:none`)]);

  await ctx.reply(text, {
    ...Markup.inlineKeyboard(rows),
    message_thread_id: ctx.message?.message_thread_id,
  });
}

export function getCandidatePickPayload(token) {
  return pendingCandidatePicks.get(token);
}

export function clearCandidatePick(token) {
  pendingCandidatePicks.delete(token);
}

export async function fetchFlibustaResultForCandidate(candidate) {
  const info = await getBookInfo(candidate.book.id);
  return { book: candidate.book, info, score: candidate.score };
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
  const candidates = await pickFlibustaCandidates(ctx, attempts);
  const cacheKey = `find:${norm(`${q.title || ""} ${q.author || ""} ${q.query || ""}`)}`;

  if (candidates.length) {
    await presentFlibustaCandidates(ctx, {
      candidates,
      bestItem: pseudoBestItem,
      cache,
      cacheKey,
      onNone: (ctx2) => runGoogleBooksFallback(ctx2, q),
    });
    return;
  }

  await runGoogleBooksFallback(ctx, q);
}

async function runGoogleBooksFallback(ctx, q) {
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
