// flibustaReply.js
import { Markup } from "telegraf";

function sliceText(v, max = 500) {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
}
function safeThreadId(ctx) {
  return ctx?.message?.message_thread_id;
}
function asNonEmptyString(v) {
  const s = String(v ?? "").trim();
  return s ? s : "";
}

export function buildFlibustaReplyPayload({
  flibustaResult,
  bestItem,
  toAbsoluteUrl,
  getUrl,
  maxGenres = 3,
  maxEvidence = 3,
  maxDesc = 500,
}) {
  const book = flibustaResult?.book;
  const info = flibustaResult?.info;
  if (!book) return null;

  const genres =
    Array.isArray(info?.genres) && info.genres.length
      ? info.genres.slice(0, maxGenres).map((g) => g?.title).filter(Boolean).join(", ")
      : null;

  const desc = sliceText(info?.description, maxDesc);
  const authorSuffix = book.author ? `, ${book.author}` : "";

  const evidence =
    Array.isArray(bestItem?.evidence) && bestItem.evidence.length
      ? bestItem.evidence.slice(0, maxEvidence).join(" | ")
      : "-";

  const buttons = [];

  const flibustaPage = asNonEmptyString(book.link) ? toAbsoluteUrl(book.link) : "";
  if (flibustaPage) buttons.push(Markup.button.url("Флибуста", flibustaPage));

  const id = String(book.id);
  const mobiRaw = getUrl(id, "mobi");
  const epubRaw = getUrl(id, "epub");
  const mobi = mobiRaw ? toAbsoluteUrl(mobiRaw) : "";
  const epub = epubRaw ? toAbsoluteUrl(epubRaw) : "";

  if (mobi) buttons.push(Markup.button.url("Скачать MOBI", mobi));
  if (epub) buttons.push(Markup.button.url("Скачать EPUB", epub));

  const extra = buttons.length
    ? Markup.inlineKeyboard([buttons.slice(0, 2), buttons.slice(2, 4)].filter((row) => row.length))
    : undefined;

  const text =
    `Нашёл во Флибусте:\n\n• ${book.title}${authorSuffix}\n` +
    `\nУверенность: ${(bestItem?.confidence ?? 0).toFixed(2)}\n` +
    `Доказательства: ${evidence}` +
    (genres ? `\nЖанры: ${genres}` : "") +
    (desc ? `\n\nОписание:\n${desc}` : "");

  return { text, extra };
}

export async function replyWithFlibustaResult({
  ctx,
  flibustaResult,
  bestItem,
  toAbsoluteUrl,
  getUrl,
  cache,
  cacheKey,
}) {
  const payload = buildFlibustaReplyPayload({
    flibustaResult,
    bestItem,
    toAbsoluteUrl,
    getUrl,
  });

  if (!payload) return false;

  const threadId = safeThreadId(ctx);

  await ctx.reply(payload.text, {
    ...(payload.extra ? payload.extra : {}),
    ...(threadId ? { message_thread_id: threadId } : {}),
  });

  if (cache && cacheKey != null) {
    cache.set(cacheKey, { text: payload.text, extra: payload.extra ? payload.extra : {} });
  }

  return true;
}