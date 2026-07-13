import { getUserId, isOwner, requestAccess, approveRequest, rejectRequest } from "../access/accessControl.js";
import { getKindleEmail } from "../kindle/kindleEmail.js";
import { getKindleSendPayload, sendToKindle, kindleErrorHint, buildKindleButton } from "../kindle/kindleSender.js";
import { getCandidatePickPayload, clearCandidatePick, fetchFlibustaResultForCandidate } from "../core/findFlow.js";
import { replyWithFlibustaResult } from "../helpers/flibustaReply.js";
import { toAbsoluteUrl, getUrl } from "../providers/flibustaProvider.js";

export function registerActions(bot, db) {
  bot.action("acc:req", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await requestAccess(bot, db, ctx);
    } catch (e) {
      console.error(e);
    }
  });

  bot.action(/^acc:(approve|reject):([a-f0-9]+)$/, async (ctx) => {
    try {
      const actorId = getUserId(ctx);
      if (!isOwner(actorId)) {
        await ctx.answerCbQuery("Только владелец может это делать", { show_alert: true });
        return;
      }

      const action = ctx.match?.[1];
      const token = ctx.match?.[2];

      if (action === "approve") {
        const req = approveRequest(db, token);
        if (!req) {
          await ctx.answerCbQuery("Заявка уже обработана");
          return;
        }

        await ctx.editMessageText(`✅ Доступ выдан пользователю ${req.userId}`);
        await ctx.answerCbQuery("Одобрено");
        await bot.telegram.sendMessage(req.userId, "✅ Доступ одобрен. Можешь отправлять текст или фото книги.");
        return;
      }

      const req = rejectRequest(db, token);
      if (!req) {
        await ctx.answerCbQuery("Заявка уже обработана");
        return;
      }

      await ctx.editMessageText(`❌ Доступ отклонён для ${req.userId}`);
      await ctx.answerCbQuery("Отклонено");
      await bot.telegram.sendMessage(req.userId, "❌ Заявка отклонена владельцем.");
    } catch (e) {
      console.error(e);
      await ctx.answerCbQuery("Ошибка");
    }
  });

  bot.action(/^kindle:send:([a-f0-9]+)$/, async (ctx) => {
    try {
      const actorId = getUserId(ctx);
      const token = ctx.match?.[1];
      const payload = getKindleSendPayload(token);

      if (!payload) {
        await ctx.answerCbQuery("Ссылка устарела", { show_alert: true });
        return;
      }

      if (!actorId || payload.userId !== actorId) {
        await ctx.answerCbQuery("Эта кнопка не для вас", { show_alert: true });
        return;
      }

      const email = getKindleEmail(db, actorId);
      if (!email) {
        await ctx.answerCbQuery("Сначала укажи Kindle email", { show_alert: true });
        return;
      }

      await ctx.answerCbQuery("Отправляю на Kindle...");

      const progress = await ctx.reply("⌛ Отправляю книгу на Kindle...", {
        message_thread_id: ctx.message?.message_thread_id,
      });

      await sendToKindle({
        toEmail: email,
        fileUrl: payload.fileUrl,
        filename: payload.filename,
      });

      try {
        await ctx.telegram.editMessageText(
          ctx.chat?.id,
          progress?.message_id,
          undefined,
          `✅ Книга отправлена на Kindle: ${email}`
        );
      } catch {
        await ctx.reply(`✅ Книга отправлена на Kindle: ${email}`, {
          message_thread_id: ctx.message?.message_thread_id,
        });
      }
    } catch (e) {
      console.error(e);
      await ctx.reply(`❌ ${kindleErrorHint(e)}`, { message_thread_id: ctx.message?.message_thread_id });
    }
  });

  bot.action(/^flib:pick:([a-f0-9]+):(\d+|none)$/, async (ctx) => {
    try {
      const actorId = getUserId(ctx);
      const token = ctx.match?.[1];
      const choice = ctx.match?.[2];
      const payload = getCandidatePickPayload(token);

      if (!payload) {
        await ctx.answerCbQuery("Список устарел", { show_alert: true });
        return;
      }

      if (!actorId || payload.userId !== actorId) {
        await ctx.answerCbQuery("Это не для вас", { show_alert: true });
        return;
      }

      clearCandidatePick(token);
      await ctx.answerCbQuery();

      if (choice === "none") {
        await payload.onNone(ctx);
        return;
      }

      const picked = payload.candidates[Number(choice)];
      if (!picked) {
        await ctx.reply("Некорректный выбор.", { message_thread_id: ctx.message?.message_thread_id });
        return;
      }

      const flibustaResult = await fetchFlibustaResultForCandidate(picked);
      const kindleButton = buildKindleButton(db, actorId, flibustaResult.book);

      await replyWithFlibustaResult({
        ctx,
        flibustaResult,
        bestItem: payload.bestItem,
        toAbsoluteUrl,
        getUrl,
        cache: payload.cache,
        cacheKey: payload.cacheKey,
        extraButtons: kindleButton ? [kindleButton] : [],
      });
    } catch (e) {
      console.error(e);
      await ctx.answerCbQuery("Ошибка").catch(() => {});
    }
  });
}
