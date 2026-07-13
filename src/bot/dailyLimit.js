import { config } from "../config.js";
import { getUserId, isOwner } from "../access/accessControl.js";
import { incrementAndCheck } from "../storage/limitsRepo.js";

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export async function enforceDailyLimit(ctx, db) {
  const userId = getUserId(ctx);
  if (!userId) return false;
  if (isOwner(userId)) return true;

  const { allowed } = incrementAndCheck(db, userId, dayKey(), config.DAILY_LIMIT);

  if (!allowed) {
    await ctx.reply(`Лимит ${config.DAILY_LIMIT} запросов в сутки для пользователя. Попробуй завтра.`, {
      message_thread_id: ctx.message?.message_thread_id,
    });
    return false;
  }

  return true;
}
