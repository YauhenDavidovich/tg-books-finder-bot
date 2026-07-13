import crypto from "crypto";
import { Markup } from "telegraf";
import { config } from "../config.js";
import { isAllowedTopic, downloadTelegramFile, replyChunked } from "../core/telegramUtils.js";
import { ensureAllowedOrRequest, isDebugAllowed, getUserId } from "../access/accessControl.js";
import { enforceDailyLimit } from "./dailyLimit.js";
import { geminiExtractBookFromImageBuffer } from "../geminiVision.js";
import { buildFlibustaAttemptsFromVisionItem, tryFlibustaFirst } from "../core/findFlow.js";
import { buildKindleButton } from "../kindle/kindleSender.js";
import { replyWithFlibustaResult } from "../helpers/flibustaReply.js";
import { findBookByTitleAuthor } from "../googleBooks.js";
import { toAbsoluteUrl, getUrl } from "../providers/flibustaProvider.js";

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function registerPhotoHandler(bot, db, cache) {
  bot.on("photo", async (ctx) => {
    try {
      if (!isAllowedTopic(ctx)) return;
      if (!(await ensureAllowedOrRequest(bot, db, ctx))) return;
      if (!(await enforceDailyLimit(ctx, db))) return;

      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      const buffer = await downloadTelegramFile(ctx, best.file_id);

      const hash = sha256(buffer);
      const cached = cache.get(hash);
      if (cached && !config.RAW_MODE) {
        await ctx.reply(cached.text, { ...cached.extra, message_thread_id: ctx.message.message_thread_id });
        return;
      }

      // 1) Gemini Vision: image -> JSON
      const extracted = await geminiExtractBookFromImageBuffer(buffer, "image/jpeg");

      if (config.RAW_MODE && isDebugAllowed(ctx)) {
        const rawText =
          `RAW AI JSON, thread_id=${ctx.message?.message_thread_id ?? "null"}:\n\n` + JSON.stringify(extracted, null, 2);
        await replyChunked(ctx, rawText);
      }

      const items = Array.isArray(extracted?.items) ? extracted.items : [];
      const bestItem = items.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];

      if (!bestItem || !bestItem.title || (bestItem.confidence ?? 0) < 0.65) {
        await ctx.reply("Не уверен в названии. Пришли кадр, где обложка крупнее и ровнее.", {
          message_thread_id: ctx.message.message_thread_id,
        });
        return;
      }

      // 2) PRIORITY: Flibusta - try the original title/author plus the
      // RU/EN enrichment variants (title_ru/author_ru, variants[]) instead
      // of only the original guess (see P0-1 in PRIORITIZED_FINDINGS.md).
      const attempts = buildFlibustaAttemptsFromVisionItem(bestItem);

      let flibustaResult = null;
      for (const a of attempts) {
        flibustaResult = await tryFlibustaFirst(ctx, a);
        if (flibustaResult?.book) break;
      }

      const userId = getUserId(ctx);
      const kindleButton = flibustaResult?.book ? buildKindleButton(db, userId, flibustaResult.book) : null;
      const handled = await replyWithFlibustaResult({
        ctx,
        flibustaResult,
        bestItem,
        toAbsoluteUrl,
        getUrl,
        cache,
        cacheKey: hash,
        extraButtons: kindleButton ? [kindleButton] : [],
      });

      if (handled) return;

      // 3) Fallback: Google Books confirm
      const guessedTitle = bestItem.title;
      const guessedAuthor = bestItem.author || null;
      const book = await findBookByTitleAuthor({ title: guessedTitle, author: guessedAuthor }, config.GOOGLE_BOOKS_API_KEY);

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
      if (config.DEBUG_ERRORS) {
        await ctx.reply(`Ошибка: ${msg}`, { message_thread_id: ctx.message?.message_thread_id });
      } else {
        await ctx.reply("Что-то пошло не так при обработке скрина. Попробуй еще раз.", {
          message_thread_id: ctx.message?.message_thread_id,
        });
      }
    }
  });
}
