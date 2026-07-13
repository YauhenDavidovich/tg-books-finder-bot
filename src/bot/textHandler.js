import { Markup } from "telegraf";
import { isAllowedTopic } from "../core/telegramUtils.js";
import { ensureAllowedOrRequest, getUserId } from "../access/accessControl.js";
import { isValidKindleEmail, setKindleEmail } from "../kindle/kindleEmail.js";
import { pendingFind, pendingKindle } from "./pendingState.js";
import { enforceDailyLimit } from "./dailyLimit.js";
import { handleFindQuery } from "../core/findFlow.js";

export function registerTextHandler(bot, db, cache) {
  bot.on("text", async (ctx) => {
    try {
      if (!isAllowedTopic(ctx)) return;
      if (!(await ensureAllowedOrRequest(bot, db, ctx))) return;

      const text = String(ctx.message?.text || "").trim();
      if (!text) return;
      if (text.startsWith("/")) return; // commands handled separately

      const userId = getUserId(ctx);
      const isPendingFind = userId ? pendingFind.get(userId) : false;
      const isPendingKindle = userId ? pendingKindle.get(userId) : false;

      if (isPendingKindle) {
        if (userId) pendingKindle.delete(userId);
        const email = text.trim().toLowerCase();
        if (!isValidKindleEmail(email)) {
          await ctx.reply("Это не похоже на Kindle email. Он должен заканчиваться на @kindle.com или @free.kindle.com", {
            message_thread_id: ctx.message?.message_thread_id,
          });
          return;
        }

        setKindleEmail(db, userId, email);

        const kb = Markup.keyboard([["🔎 Find", "✏️ Изменить Kindle email"]]).resize();
        await ctx.reply(`Готово! Kindle email сохранён: ${email}`, {
          ...kb,
          message_thread_id: ctx.message?.message_thread_id,
        });
        return;
      }

      if (!isPendingFind) {
        await ctx.reply("Нажми 🔎 Find, затем отправь описание книги — я начну поиск.", {
          message_thread_id: ctx.message?.message_thread_id,
        });
        return;
      }

      if (userId) pendingFind.delete(userId);
      if (!(await enforceDailyLimit(ctx, db))) return;
      await handleFindQuery({ ctx, input: text, db, cache });
    } catch (e) {
      console.error(e);
      const msg = String(e?.message || e).slice(0, 1600);
      await ctx.reply(`Ошибка: ${msg}`, { message_thread_id: ctx.message?.message_thread_id });
    }
  });
}
