import { Markup } from "telegraf";
import {
  getUserId,
  isOwner,
  ensureAllowedOrRequest,
  parseTargetUserId,
  allowUserByAdmin,
  denyUserByAdmin,
  usersReportText,
} from "../access/accessControl.js";
import { getKindleEmail } from "../kindle/kindleEmail.js";
import { testDelivery } from "../kindle/kindleSender.js";
import { pendingFind, pendingKindle } from "./pendingState.js";
import { handleFindQuery } from "../core/findFlow.js";
import { enforceDailyLimit } from "./dailyLimit.js";

export function registerCommands(bot, db, cache) {
  bot.start(async (ctx) => {
    try {
      if (!(await ensureAllowedOrRequest(bot, db, ctx))) return;

      const userId = getUserId(ctx);
      const hasKindle = userId ? Boolean(getKindleEmail(db, userId)) : false;
      const kindleLabel = hasKindle ? "✏️ Изменить Kindle email" : "📩 Kindle email";
      const kb = Markup.keyboard([["🔎 Find", kindleLabel]]).resize();
      await ctx.reply(
        "Нажми 🔎 Find и пришли описание книги (кратко: сюжет/цитата/название/автор).\n\nЕсли отправишь фото обложки — я попробую найти книгу по картинке.",
        { ...kb, message_thread_id: ctx.message?.message_thread_id }
      );
    } catch (e) {
      console.error(e);
    }
  });

  bot.hears("🔎 Find", async (ctx) => {
    try {
      if (!(await ensureAllowedOrRequest(bot, db, ctx))) return;
      const userId = getUserId(ctx);
      if (userId) pendingFind.set(userId, true);
      await ctx.reply("Введи описание книги или название и автора — я начну поиск.", {
        message_thread_id: ctx.message?.message_thread_id,
      });
    } catch (e) {
      console.error(e);
    }
  });

  bot.hears(["📩 Kindle email", "✏️ Изменить Kindle email"], async (ctx) => {
    try {
      if (!(await ensureAllowedOrRequest(bot, db, ctx))) return;
      const userId = getUserId(ctx);
      if (userId) pendingKindle.set(userId, true);
      await ctx.reply("Пришли свой Kindle email (например, name@kindle.com).", {
        message_thread_id: ctx.message?.message_thread_id,
      });
    } catch (e) {
      console.error(e);
    }
  });

  bot.command("find", async (ctx) => {
    try {
      if (!(await ensureAllowedOrRequest(bot, db, ctx))) return;

      const input = (ctx.message?.text || "").split(" ").slice(1).join(" ").trim();
      if (!input) {
        const userId = getUserId(ctx);
        if (userId) pendingFind.set(userId, true);
        await ctx.reply("Введи описание книги или название и автора — я начну поиск.", {
          message_thread_id: ctx.message?.message_thread_id,
        });
        return;
      }

      if (!(await enforceDailyLimit(ctx, db))) return;
      await handleFindQuery({ ctx, input, db, cache });
    } catch (e) {
      console.error(e);
      const msg = String(e?.message || e).slice(0, 1600);
      await ctx.reply(`Ошибка: ${msg}`, { message_thread_id: ctx.message?.message_thread_id });
    }
  });

  bot.command("users", async (ctx) => {
    try {
      const actorId = getUserId(ctx);
      if (!isOwner(actorId)) return;

      await ctx.reply(usersReportText(db), { message_thread_id: ctx.message?.message_thread_id });
    } catch (e) {
      console.error(e);
    }
  });

  bot.command("allow", async (ctx) => {
    try {
      const actorId = getUserId(ctx);
      if (!isOwner(actorId)) return;

      const targetId = parseTargetUserId(ctx);
      if (!targetId) {
        await ctx.reply("Используй: /allow <user_id> или reply на сообщение пользователя", {
          message_thread_id: ctx.message?.message_thread_id,
        });
        return;
      }

      allowUserByAdmin(db, targetId);

      await ctx.reply(`✅ Добавил в allowlist: ${targetId}`, { message_thread_id: ctx.message?.message_thread_id });

      try {
        await bot.telegram.sendMessage(targetId, "✅ Доступ выдан владельцем. Можно пользоваться ботом.");
      } catch {}
    } catch (e) {
      console.error(e);
    }
  });

  bot.command("deny", async (ctx) => {
    try {
      const actorId = getUserId(ctx);
      if (!isOwner(actorId)) return;

      const targetId = parseTargetUserId(ctx);
      if (!targetId) {
        await ctx.reply("Используй: /deny <user_id> или reply на сообщение пользователя", {
          message_thread_id: ctx.message?.message_thread_id,
        });
        return;
      }

      denyUserByAdmin(db, targetId);

      await ctx.reply(`❌ Убрал доступ: ${targetId}`, { message_thread_id: ctx.message?.message_thread_id });

      try {
        await bot.telegram.sendMessage(targetId, "❌ Доступ отозван владельцем.");
      } catch {}
    } catch (e) {
      console.error(e);
    }
  });

  bot.command("smtp_test", async (ctx) => {
    try {
      const actorId = getUserId(ctx);
      if (!isOwner(actorId)) return;

      const message = await testDelivery();
      await ctx.reply(message, { message_thread_id: ctx.message?.message_thread_id });
    } catch (e) {
      if (e?.isConfigMissing) {
        await ctx.reply(e.message, { message_thread_id: ctx.message?.message_thread_id });
        return;
      }
      await ctx.reply(`❌ SMTP FAIL: ${String(e?.message || e).slice(0, 500)}`, {
        message_thread_id: ctx.message?.message_thread_id,
      });
    }
  });
}
