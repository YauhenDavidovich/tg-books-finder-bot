import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import crypto from "crypto";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

import { extractTextFromImage } from "./ocr.js";
import { findBook } from "./books.js";
import { normalizeLines, shortText } from "./format.js";

// --- GCP creds from Railway var (optional but handy)
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GCP_SA_JSON) {
  const p = path.join("/tmp", "gcp-sa.json");
  fs.writeFileSync(p, process.env.GCP_SA_JSON, "utf8");
  process.env.GOOGLE_APPLICATION_CREDENTIALS = p;
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const ALLOWED_THREAD_ID = Number(process.env.ALLOWED_THREAD_ID || 0);
const BOOKS_KEY = process.env.GOOGLE_BOOKS_API_KEY || "";

const cache = new Map();

// --- helper: download photo from Telegram
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
  // if ALLOWED_THREAD_ID = 0, allow everything (debug mode)
  if (!ALLOWED_THREAD_ID) return true;
  const threadId = ctx.message?.message_thread_id;
  return Number(threadId) === ALLOWED_THREAD_ID;
}

// --- DEBUG: get thread id from ANY message
bot.on("message", async (ctx) => {
  const threadId = ctx.message?.message_thread_id ?? null;
  const chatId = ctx.chat?.id ?? null;
  const topic = threadId ? `topic thread_id=${threadId}` : "no topic thread_id";

  // отвечаем коротко, чтобы ты мог скопировать
  await ctx.reply(`chat_id=${chatId}\n${topic}`);

  // и в логи Railway тоже
  console.log("debug ids:", {
    chatId,
    threadId,
    from: ctx.from?.username,
    text: ctx.message?.text
  });
});

// --- MAIN: photo handler (будет работать, но в debug-режиме ответит везде)
bot.on("photo", async (ctx) => {
  try {
    if (!isAllowedTopic(ctx)) return;

    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];
    const buffer = await downloadTelegramFile(ctx, best.file_id);

    const hash = sha256(buffer);
    const cached = cache.get(hash);
    if (cached) {
      await ctx.reply(cached.text, { ...cached.extra, message_thread_id: ctx.message.message_thread_id });
      return;
    }

    const { text } = await extractTextFromImage(buffer, "TEXT");
    const candidates = normalizeLines(text);

    if (candidates.length === 0) {
      await ctx.reply(
        "Тут не вижу названий книг. Если это рилс, попробуй кадр, где текст крупнее.",
        { message_thread_id: ctx.message.message_thread_id }
      );
      return;
    }

    const results = [];
    for (const q of candidates) {
      const book = await findBook(q, BOOKS_KEY);
      if (book?.title) results.push({ query: q, book });
      if (results.length >= 6) break;
    }

    if (results.length === 0) {
      await ctx.reply(
        "Текст прочитал, но не смог уверенно сопоставить книги. Можешь прислать еще один скрин, где видно названия четче.",
        { message_thread_id: ctx.message.message_thread_id }
      );
      return;
    }

    let msg = "Нашёл так:\n\n";
    for (const r of results) {
      const title = r.book.title || r.query;
      const author = r.book.authors?.[0] ? `, ${r.book.authors[0]}` : "";
      const desc = shortText(r.book.description, 220);
      msg += `• ${title}${author}\n`;
      if (desc) msg += `${desc}\n`;
      msg += "\n";
    }

    const buttons = results.slice(0, 3).map((r) => {
      const title = r.book.title || r.query;
      const url = r.book.canonicalLink || `https://www.google.com/search?q=${encodeURIComponent(title)}`;
      return [Markup.button.url(title.slice(0, 28), url)];
    });

    const extra = Markup.inlineKeyboard(buttons);

    await ctx.reply(msg.trim(), { ...extra, message_thread_id: ctx.message.message_thread_id });

    cache.set(hash, { text: msg.trim(), extra });
  } catch (e) {
    console.error(e);
    await ctx.reply("Что-то пошло не так при обработке скрина. Попробуй еще раз.", {
      message_thread_id: ctx.message?.message_thread_id
    });
  }
});

bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));