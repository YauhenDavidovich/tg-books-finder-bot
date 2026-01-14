import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import crypto from "crypto";
import fetch from "node-fetch";

// ✅ Флибуста, единственная точка импорта flibusta-api сидит внутри провайдера
import {
  searchBooks,
  searchByAuthor,
  getBookInfo,
  getUrl
} from "./providers/flibustaProvider.js";

import { geminiExtractBookFromImageBuffer } from "./geminiVision.js";
import { findBookByTitleAuthor, findBooksByQuery } from "./books.js";
import { geminiExtractBookQueryFromText } from "./geminiTextSearch.js";
import { replyWithFlibustaResult } from "./helpers/flibustaReply.js";

const bot = new Telegraf(process.env.BOT_TOKEN);

const ALLOWED_THREAD_ID = Number(process.env.ALLOWED_THREAD_ID || 0);
const BOOKS_KEY = process.env.GOOGLE_BOOKS_API_KEY || "";

const cache = new Map();

let RAW_MODE = process.env.RAW_MODE === "1"; // /raw on|off тоже работает
let FLIBUSTA_DEBUG = process.env.FLIBUSTA_DEBUG === "1"; // /fdebug on|off тоже работает

const MAX_TG_LEN = 3800;

// если flibusta-api вернет относительный путь, превратим его в абсолютный
const FLIBUSTA_BASE_URL = (process.env.FLIBUSTA_BASE_URL || "https://flibusta.is").replace(/\/+$/, "");

// --- helpers

async function downloadTelegramFile(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link.href);
  if (!res.ok) throw new Error("Failed to download file");
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function isAllowedTopic(ctx) {
  if (!ALLOWED_THREAD_ID) return true;
  const threadId = ctx.message?.message_thread_id;
  return Number(threadId) === ALLOWED_THREAD_ID;
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function uniqStrings(arr) {
  return [...new Set((arr || []).map((s) => String(s || "").trim()).filter(Boolean))];
}

function scoreMatch(candidate, title, author) {
  const ct = norm(candidate?.title);
  const ca = norm(candidate?.author);
  const qt = norm(title);
  const qa = norm(author);

  let score = 0;

  if (qt && ct === qt) score += 6;
  else if (qt && (ct.includes(qt) || qt.includes(ct))) score += 4;

  if (qa && ca === qa) score += 4;
  else if (qa && (ca.includes(qa) || qa.includes(ca))) score += 2;

  return score;
}

function shortTitle(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const cut = s.split(/[.:—–(]| - /)[0].trim();
  return cut.length >= 4 ? cut : s;
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

async function replyChunked(ctx, text) {
  const threadId = ctx.message?.message_thread_id;
  if (!text) return;

  if (text.length <= MAX_TG_LEN) {
    await ctx.reply(text, { message_thread_id: threadId });
    return;
  }

  await ctx.reply(text.slice(0, MAX_TG_LEN), { message_thread_id: threadId });
  await ctx.reply(text.slice(MAX_TG_LEN, MAX_TG_LEN * 2), { message_thread_id: threadId });
}

function toAbsoluteUrl(url) {
  const s = String(url ?? "").trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return `${FLIBUSTA_BASE_URL}${s}`;
  return "";
}

async function tryFlibustaFirst(ctx, { title, author }) {
  const fullTitle = String(title ?? "").trim();
  const qAuthor = String(author ?? "").trim();
  const tShort = shortTitle(fullTitle);

  if (!tShort) return null;

  const queriesRaw = [qAuthor ? `${tShort} ${qAuthor}` : tShort, tShort, fullTitle].filter(Boolean);
  const queries = [...new Set(queriesRaw)];

  let candidates = [];

  for (const q of queries) {
    const list = await searchBooks(q, 40);

    if (FLIBUSTA_DEBUG) {
      const text =
        `FLIBUSTA searchBooks("${q}") -> ${Array.isArray(list) ? list.length : 0}\n` +
        formatFlibustaList(list, 5);
      await replyChunked(ctx, text);
    }

    if (Array.isArray(list) && list.length) candidates = candidates.concat(list);
  }

  if ((!candidates || candidates.length === 0) && qAuthor) {
    const byA = await searchByAuthor(qAuthor, 80);

    if (FLIBUSTA_DEBUG) {
      const text =
        `FLIBUSTA searchByAuthor("${qAuthor}") -> ${Array.isArray(byA) ? byA.length : 0}\n` +
        formatFlibustaList(byA, 5);
      await replyChunked(ctx, text);
    }

    if (Array.isArray(byA) && byA.length) candidates = candidates.concat(byA);
  }

  if (!candidates.length) return null;

  // дедуп по id
  const uniq = [];
  const seen = new Set();
  for (const b of candidates) {
    const key = String(b?.id ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(b);
  }

  // выбираем лучший скор
  let best = null;
  let bestScore = -1;

  for (const b of uniq) {
    const s = scoreMatch(b, tShort, qAuthor);
    if (s > bestScore) {
      bestScore = s;
      best = b;
    }
  }

  const minScore = qAuthor ? 4 : 5;

  if (FLIBUSTA_DEBUG) {
    const picked = best
      ? `bestScore=${bestScore}, minScore=${minScore}\nBEST: ${best.id} | ${best.title}${best.author ? `, ${best.author}` : ""}`
      : `BEST: null`;
    await replyChunked(ctx, `FLIBUSTA picked:\n${picked}`);
  }

  if (!best || bestScore < minScore) return null;

  const info = await getBookInfo(best.id);
  return { book: best, info, score: bestScore };
}

// --- commands

bot.command("raw", async (ctx) => {
  const arg = (ctx.message?.text || "")
    .split(" ")
    .slice(1)
    .join(" ")
    .trim()
    .toLowerCase();

  if (arg === "on" || arg === "1" || arg === "true") {
    RAW_MODE = true;
    await ctx.reply("Ок, буду присылать сырой ответ нейронки (JSON) для каждого фото в этом чате.", {
      message_thread_id: ctx.message?.message_thread_id
    });
    return;
  }

  if (arg === "off" || arg === "0" || arg === "false") {
    RAW_MODE = false;
    await ctx.reply("Ок, больше не присылаю сырой ответ нейронки.", {
      message_thread_id: ctx.message?.message_thread_id
    });
    return;
  }

  await ctx.reply(`RAW_MODE сейчас: ${RAW_MODE ? "on" : "off"}\nКоманды: /raw on, /raw off`, {
    message_thread_id: ctx.message?.message_thread_id
  });
});

bot.command("fdebug", async (ctx) => {
  const arg = (ctx.message?.text || "")
    .split(" ")
    .slice(1)
    .join(" ")
    .trim()
    .toLowerCase();

  if (arg === "on" || arg === "1" || arg === "true") {
    FLIBUSTA_DEBUG = true;
    await ctx.reply("Ок, включил дебаг Флибусты. Буду показывать результаты запросов.", {
      message_thread_id: ctx.message?.message_thread_id
    });
    return;
  }

  if (arg === "off" || arg === "0" || arg === "false") {
    FLIBUSTA_DEBUG = false;
    await ctx.reply("Ок, выключил дебаг Флибусты.", {
      message_thread_id: ctx.message?.message_thread_id
    });
    return;
  }

  await ctx.reply(`FLIBUSTA_DEBUG сейчас: ${FLIBUSTA_DEBUG ? "on" : "off"}\nКоманды: /fdebug on, /fdebug off`, {
    message_thread_id: ctx.message?.message_thread_id
  });
});

bot.command("find", async (ctx) => {
  try {
    const input = (ctx.message?.text || "").split(" ").slice(1).join(" ").trim();
    if (!input) {
      await ctx.reply("Напиши так: /find описание книги или что помнишь", {
        message_thread_id: ctx.message?.message_thread_id
      });
      return;
    }

    const q = await geminiExtractBookQueryFromText(input);

    const conf = Number(q?.confidence ?? 0) || 0;

    // если query пустой, точно нечего искать
    if (!q?.query) {
      await ctx.reply(
        "Мало деталей. Добавь 2–3 штуки: страна, время, профессия героя, конфликт, жанр.",
        { message_thread_id: ctx.message?.message_thread_id }
      );
      return;
    }
    
    // если confidence очень низкий, тогда просим деталей
    if (conf < 0.25) {
      await ctx.reply(
        `Я понял запрос, но уверенность низкая (${conf.toFixed(2)}). Добавь 2–3 детали: страна, время, профессия героя, конфликт, жанр.`,
        { message_thread_id: ctx.message?.message_thread_id }
      );
      return;
    }

    // --- 1) PRIORITY: Flibusta через variants от Gemini
    const pseudoBestItem = {
      confidence: q.confidence ?? 0,
      evidence: [
        q.title ? `title:${q.title}` : null,
        q.author ? `author:${q.author}` : null,
        q.title_ru ? `ru_title:${q.title_ru}` : null,
        q.author_ru ? `ru_author:${q.author_ru}` : null,
        q.query ? `query:${q.query}` : null,
        q.query_ru ? `ru_query:${q.query_ru}` : null,
        ...(Array.isArray(q.keywords) ? q.keywords.slice(0, 2).map((k) => `kw:${k}`) : [])
      ].filter(Boolean)
    };

    const listToTry = uniqStrings([
      ...(Array.isArray(q.variants) ? q.variants : []),
      q.title && q.author ? `${q.title} ${q.author}` : null,
      q.title,
      q.query,
      q.title_ru && q.author_ru ? `${q.title_ru} ${q.author_ru}` : null,
      q.title_ru,
      q.query_ru
    ]);

    let flibustaResult = null;

    try {
      for (const s of listToTry) {
        flibustaResult = await tryFlibustaFirst(ctx, { title: s, author: null });
        if (flibustaResult?.book) break;
      }
    } catch (e) {
      if (e?.isUserFacing) {
        await ctx.reply(e.message, { message_thread_id: ctx.message?.message_thread_id });
        return;
      }
      throw e;
    }

    const cacheKey = `find:${norm(listToTry[0] || q.query || input)}`;

    const handled = await replyWithFlibustaResult({
      ctx,
      flibustaResult,
      bestItem: pseudoBestItem,
      toAbsoluteUrl,
      getUrl,
      cache,
      cacheKey
    });

    if (handled) return;

    // --- 2) Fallback: Google Books
    const parts = [];
    if (q.title) parts.push(`intitle:"${q.title}"`);
    if (q.author) parts.push(`inauthor:"${q.author}"`);
    if (!parts.length) parts.push(q.query);

    const kw = Array.isArray(q.keywords) ? q.keywords.slice(0, 5) : [];
    const finalQuery = `${parts.join(" ")} ${kw.join(" ")}`.trim();

    const results = await findBooksByQuery(finalQuery, BOOKS_KEY);

    if (!results.length) {
      await ctx.reply(
        `Не нашёл по запросу: ${q.query}\nПопробуй: больше деталей или имя автора.`,
        { message_thread_id: ctx.message?.message_thread_id }
      );
      return;
    }

    const top = results[0];
    const url = top.canonicalLink || `https://www.google.com/search?q=${encodeURIComponent(finalQuery)}`;
    const extra = Markup.inlineKeyboard([[Markup.button.url("Открыть", url)]]);

    const author = top.authors?.[0] ? `, ${top.authors[0]}` : "";
    const tags =
      Array.isArray(q.tags) && q.tags.length
        ? `\nТеги: #${q.tags
            .map((t) => String(t).trim().toLowerCase().replace(/\s+/g, "_"))
            .slice(0, 8)
            .join(" #")}`
        : "";

    await ctx.reply(
      `Похоже на:\n• ${top.title || q.query}${author}\n\nЗапрос: ${q.query}\nУверенность: ${(q.confidence ?? 0).toFixed(2)}${tags}`,
      { ...extra, message_thread_id: ctx.message?.message_thread_id }
    );
  } catch (e) {
    console.error(e);
    const msg = String(e?.message || e).slice(0, 900);
    await ctx.reply(`Ошибка: ${msg}`, { message_thread_id: ctx.message?.message_thread_id });
  }
});

// --- main

bot.on("photo", async (ctx) => {
  try {
    if (!isAllowedTopic(ctx)) return;

    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];
    const buffer = await downloadTelegramFile(ctx, best.file_id);

    const hash = sha256(buffer);
    const cached = cache.get(hash);
    if (cached && !RAW_MODE) {
      await ctx.reply(cached.text, { ...cached.extra, message_thread_id: ctx.message.message_thread_id });
      return;
    }

    // 1) Gemini Vision: image -> JSON
    const extracted = await geminiExtractBookFromImageBuffer(buffer, "image/jpeg");

    if (RAW_MODE) {
      const rawText =
        `RAW AI JSON, thread_id=${ctx.message?.message_thread_id ?? "null"}:\n\n` +
        JSON.stringify(extracted, null, 2);

      await replyChunked(ctx, rawText);
    }

    const items = Array.isArray(extracted?.items) ? extracted.items : [];
    const bestItem = items.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];

    if (!bestItem || !bestItem.title || (bestItem.confidence ?? 0) < 0.65) {
      await ctx.reply("Не уверен в названии. Пришли кадр, где обложка крупнее и ровнее.", {
        message_thread_id: ctx.message.message_thread_id
      });
      return;
    }

    const guessedTitle = bestItem.title;
    const guessedAuthor = bestItem.author || null;

    // 2) PRIORITY: Flibusta, пробуем варианты если они есть
    let flibustaResult = null;

    const variantsToTry = uniqStrings([
      ...(Array.isArray(bestItem?.variants) ? bestItem.variants : []),
      bestItem?.title,
      bestItem?.title_ru,
      bestItem?.title_en,
      bestItem?.title && bestItem?.author ? `${bestItem.title} ${bestItem.author}` : null,
      bestItem?.title_ru && bestItem?.author_ru ? `${bestItem.title_ru} ${bestItem.author_ru}` : null,
      bestItem?.title_en && bestItem?.author_en ? `${bestItem.title_en} ${bestItem.author_en}` : null
    ]);

    try {
      for (const s of variantsToTry) {
        flibustaResult = await tryFlibustaFirst(ctx, { title: s, author: null });
        if (flibustaResult?.book) break;
      }

      if (!flibustaResult?.book) {
        flibustaResult = await tryFlibustaFirst(ctx, { title: guessedTitle, author: guessedAuthor });
      }
    } catch (e) {
      if (e?.isUserFacing) {
        await ctx.reply(e.message, { message_thread_id: ctx.message.message_thread_id });
        return;
      }
      throw e;
    }

    const handled = await replyWithFlibustaResult({
      ctx,
      flibustaResult,
      bestItem,
      toAbsoluteUrl,
      getUrl,
      cache,
      cacheKey: hash
    });

    if (handled) return;

    // 3) Fallback: Google Books confirm
    const book = await findBookByTitleAuthor({ title: guessedTitle, author: guessedAuthor }, BOOKS_KEY);

    if (!book?.title) {
      await ctx.reply(
        `Похоже на: ${guessedTitle}${guessedAuthor ? `, ${guessedAuthor}` : ""}\nНе нашёл во Флибусте и не смог подтвердить в Google Books.`,
        { message_thread_id: ctx.message.message_thread_id }
      );
      return;
    }

    const url =
      book.canonicalLink ||
      `https://www.google.com/search?q=${encodeURIComponent(`${book.title} ${book.authors?.[0] || ""}`.trim())}`;

    const extra = Markup.inlineKeyboard([[Markup.button.url("Google Books", url)]]);

    const author = book.authors?.[0] ? `, ${book.authors[0]}` : "";
    const evidence =
      Array.isArray(bestItem.evidence) && bestItem.evidence.length ? bestItem.evidence.slice(0, 3).join(" | ") : "-";

    const msg =
      `Нашёл так:\n\n• ${book.title}${author}\n` +
      `\nУверенность: ${(bestItem.confidence ?? 0).toFixed(2)}\n` +
      `Доказательства: ${evidence}` +
      `\n\nФлибуста не дала уверенного совпадения, поэтому показал Google Books.`;

    await ctx.reply(msg, { ...extra, message_thread_id: ctx.message.message_thread_id });
    cache.set(hash, { text: msg, extra });
  } catch (e) {
    console.error(e);

    const msg = String(e?.message || e || "unknown error").slice(0, 800);
    if (process.env.DEBUG_ERRORS === "1") {
      await ctx.reply(`Ошибка: ${msg}`, {
        message_thread_id: ctx.message?.message_thread_id
      });
    } else {
      await ctx.reply("Что-то пошло не так при обработке скрина. Попробуй еще раз.", {
        message_thread_id: ctx.message?.message_thread_id
      });
    }
  }
});

bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));