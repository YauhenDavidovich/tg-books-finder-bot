import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import crypto from "crypto";
import fetch from "node-fetch";

// ✅ приоритетный сервис: Флибуста (сетевой провайдер)
import { searchBooks, getBookInfo, getUrl } from "./providers/flibustaProvider.js";

import { geminiExtractBookFromImageBuffer } from "./geminiVision.js";
import { findBookByTitleAuthor } from "./books.js";

const bot = new Telegraf(process.env.BOT_TOKEN);

const ALLOWED_THREAD_ID = Number(process.env.ALLOWED_THREAD_ID || 0);
const BOOKS_KEY = process.env.GOOGLE_BOOKS_API_KEY || "";

const cache = new Map();

let RAW_MODE = process.env.RAW_MODE === "1"; // /raw on|off тоже работает
const MAX_TG_LEN = 3800;

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

async function tryFlibustaFirst({ title, author }) {
  const qTitle = String(title ?? "").trim();
  const qAuthor = String(author ?? "").trim();

  if (!qTitle) return null;

  // 1) пробуем искать по "title author"
  const query = qAuthor ? `${qTitle} ${qAuthor}` : qTitle;
  const list = await searchBooks(query, 20);

  if (!Array.isArray(list) || list.length === 0) return null;

  // выбираем самый похожий
  let best = null;
  let bestScore = -1;

  for (const b of list) {
    const s = scoreMatch(b, qTitle, qAuthor);
    if (s > bestScore) {
      bestScore = s;
      best = b;
    }
  }

  // порог, чтобы не улетать в нерелевант
  if (!best || bestScore < 5) return null;

  // 2) тянем инфу по книге, если есть
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
    await ctx.reply("Ок, буду присылать сырой ответ нейронки (JSON) для каждого фото в этом чате.");
    return;
  }

  if (arg === "off" || arg === "0" || arg === "false") {
    RAW_MODE = false;
    await ctx.reply("Ок, больше не присылаю сырой ответ нейронки.");
    return;
  }

  await ctx.reply(`RAW_MODE сейчас: ${RAW_MODE ? "on" : "off"}\nКоманды: /raw on, /raw off`);
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

      if (rawText.length <= MAX_TG_LEN) {
        await ctx.reply(rawText, { message_thread_id: ctx.message.message_thread_id });
      } else {
        await ctx.reply(rawText.slice(0, MAX_TG_LEN), { message_thread_id: ctx.message.message_thread_id });
        await ctx.reply(rawText.slice(MAX_TG_LEN, MAX_TG_LEN * 2), { message_thread_id: ctx.message.message_thread_id });
      }
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

    // ✅ 2) PRIORITY: Flibusta
    let flibustaResult = null;
    try {
      flibustaResult = await tryFlibustaFirst({ title: guessedTitle, author: guessedAuthor });
    } catch (e) {
      // провайдер кидает user-facing сообщение в e.message, если e.isUserFacing
      if (e?.isUserFacing) {
        await ctx.reply(e.message, { message_thread_id: ctx.message.message_thread_id });
        return;
      }
      throw e;
    }

    if (flibustaResult?.book) {
      const { book, info } = flibustaResult;

      const genres =
        Array.isArray(info?.genres) && info.genres.length
          ? info.genres.slice(0, 3).map((g) => g.title).filter(Boolean).join(", ")
          : null;

      const desc =
        String(info?.description || "").trim()
          ? String(info.description).trim().slice(0, 500)
          : null;

      const author = book.author ? `, ${book.author}` : "";

      const buttons = [];

      if (book.link) buttons.push(Markup.button.url("Флибуста", book.link));
      const mobi = getUrl(String(book.id), "mobi");
      const epub = getUrl(String(book.id), "epub");
      if (mobi) buttons.push(Markup.button.url("Скачать MOBI", mobi));
      if (epub) buttons.push(Markup.button.url("Скачать EPUB", epub));

      const extra = buttons.length
        ? Markup.inlineKeyboard([buttons.slice(0, 2), buttons.slice(2, 4)].filter((row) => row.length))
        : undefined;

      const evidence = Array.isArray(bestItem.evidence) && bestItem.evidence.length
        ? bestItem.evidence.slice(0, 3).join(" | ")
        : "-";

      const msg =
        `Нашёл во Флибусте:\n\n• ${book.title}${author}\n` +
        `\nУверенность: ${(bestItem.confidence ?? 0).toFixed(2)}\n` +
        `Доказательства: ${evidence}` +
        (genres ? `\nЖанры: ${genres}` : "") +
        (desc ? `\n\nОписание:\n${desc}` : "");

      await ctx.reply(msg, { ...(extra ? extra : {}), message_thread_id: ctx.message.message_thread_id });

      cache.set(hash, { text: msg, extra: extra ? extra : {} });
      return;
    }

    // 3) Fallback: Google Books confirm
    const book = await findBookByTitleAuthor(
      { title: guessedTitle, author: guessedAuthor },
      BOOKS_KEY
    );

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
    const evidence = Array.isArray(bestItem.evidence) && bestItem.evidence.length
      ? bestItem.evidence.slice(0, 3).join(" | ")
      : "-";

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