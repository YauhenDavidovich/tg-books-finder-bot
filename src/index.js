import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import crypto from "crypto";
import fetch from "node-fetch";

import { geminiExtractBookFromImageBuffer } from "./geminiVision.js";
import { findBookByTitleAuthor } from "./books.js";

const bot = new Telegraf(process.env.BOT_TOKEN);

const ALLOWED_THREAD_ID = Number(process.env.ALLOWED_THREAD_ID || 0);
const BOOKS_KEY = process.env.GOOGLE_BOOKS_API_KEY || "";

const cache = new Map();

let RAW_MODE = process.env.RAW_MODE === "1"; // /raw on|off тоже работает
const MAX_TG_LEN = 3800;

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
      const rawText = `RAW AI JSON, thread_id=${ctx.message?.message_thread_id ?? "null"}:\n\n` +
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
      await ctx.reply(
        "Не уверен в названии. Пришли кадр, где обложка крупнее и ровнее.",
        { message_thread_id: ctx.message.message_thread_id }
      );
      return;
    }

    // 2) Confirm via Google Books
    const book = await findBookByTitleAuthor(
      { title: bestItem.title, author: bestItem.author || null },
      BOOKS_KEY
    );

    if (!book?.title) {
      await ctx.reply(
        `Похоже на: ${bestItem.title}${bestItem.author ? `, ${bestItem.author}` : ""}\nНе смог подтвердить в Google Books.`,
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
      `Доказательства: ${evidence}`;

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