import { config } from "../config.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

export async function replyChunked(ctx, text, maxLen = config.MAX_TG_LEN) {
  const threadId = ctx.message?.message_thread_id;
  if (!text) return;

  if (text.length <= maxLen) {
    await ctx.reply(text, { message_thread_id: threadId });
    return;
  }

  await ctx.reply(text.slice(0, maxLen), { message_thread_id: threadId });
  await ctx.reply(text.slice(maxLen, maxLen * 2), { message_thread_id: threadId });
}

export function isAllowedTopic(ctx) {
  if (!config.ALLOWED_THREAD_ID) return true;
  const threadId = ctx.message?.message_thread_id;
  return Number(threadId) === config.ALLOWED_THREAD_ID;
}

export async function downloadTelegramFile(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetchWithTimeout(link.href, {}, 20000);
  if (!res.ok) throw new Error("Failed to download file");
  return Buffer.from(await res.arrayBuffer());
}
