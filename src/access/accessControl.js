import crypto from "crypto";
import { Markup } from "telegraf";
import { config } from "../config.js";
import * as accessRepo from "../storage/accessRepo.js";

export function getUserId(ctx) {
  return Number(ctx.from?.id || 0);
}

export function isOwner(userId) {
  return Boolean(config.OWNER_ID) && Number(userId) === config.OWNER_ID;
}

export function isAllowedUser(db, userId) {
  if (!userId) return false;
  if (isOwner(userId)) return true;
  return accessRepo.isAllowedUser(db, Number(userId));
}

export function isDebugAllowed(ctx) {
  return isOwner(getUserId(ctx));
}

export function requestAccessKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("✅ Запросить доступ", "acc:req")]]);
}

export function parseTargetUserId(ctx) {
  const arg = String(ctx.message?.text || "")
    .split(" ")
    .slice(1)
    .join(" ")
    .trim();

  if (/^\d+$/.test(arg)) return Number(arg);

  const replied = Number(ctx.message?.reply_to_message?.from?.id || 0);
  if (replied) return replied;

  return 0;
}

export async function requestAccess(bot, db, ctx) {
  const userId = getUserId(ctx);
  if (!userId) return;

  const threadId = ctx.message?.message_thread_id;

  if (isAllowedUser(db, userId)) {
    await ctx.reply("У тебя уже есть доступ ✅", { message_thread_id: threadId });
    return;
  }

  const existingToken = accessRepo.findPendingTokenByUserId(db, userId);
  if (existingToken) {
    await ctx.reply("Заявка уже отправлена. Жди подтверждения владельца 👌", { message_thread_id: threadId });
    return;
  }

  const meta = {
    firstName: String(ctx.from?.first_name || ""),
    lastName: String(ctx.from?.last_name || ""),
    username: String(ctx.from?.username || ""),
  };

  const token = crypto.randomBytes(8).toString("hex");
  accessRepo.upsertPendingUser(db, userId, meta);
  accessRepo.addPendingRequest(db, token, userId);

  if (config.OWNER_ID) {
    const who = `${meta.firstName} ${meta.lastName}`.trim() || "Unknown";
    const uname = meta.username ? `@${meta.username}` : "(без username)";
    await bot.telegram.sendMessage(
      config.OWNER_ID,
      `Новая заявка на доступ:\n${who} ${uname}\nuser_id: ${userId}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Approve", `acc:approve:${token}`),
          Markup.button.callback("❌ Reject", `acc:reject:${token}`),
        ],
      ])
    );

    await ctx.reply("Заявка отправлена владельцу. После одобрения бот начнёт отвечать 🙌", {
      message_thread_id: threadId,
    });
    return;
  }

  await ctx.reply("OWNER_ID не настроен. Передай владельцу, чтобы добавил OWNER_ID в .env", {
    message_thread_id: threadId,
  });
}

export async function ensureAllowedOrRequest(bot, db, ctx) {
  const userId = getUserId(ctx);
  if (isAllowedUser(db, userId)) return true;

  await ctx.reply("Сейчас бот работает по доступу. Нажми кнопку, и я отправлю заявку владельцу.", {
    ...requestAccessKeyboard(),
    message_thread_id: ctx.message?.message_thread_id,
  });
  return false;
}

export function approveRequest(db, token) {
  const req = accessRepo.getPendingRequest(db, token);
  if (!req) return null;

  accessRepo.addAllowed(db, req.userId, req);
  accessRepo.deletePendingRequest(db, token);
  return req;
}

export function rejectRequest(db, token) {
  const req = accessRepo.getPendingRequest(db, token);
  if (!req) return null;

  accessRepo.deletePendingRequest(db, token);
  return req;
}

export function allowUserByAdmin(db, targetId) {
  accessRepo.addAllowed(db, targetId);
  accessRepo.deletePendingRequestsByUserId(db, targetId);
}

export function denyUserByAdmin(db, targetId) {
  accessRepo.removeAllowed(db, targetId);
  accessRepo.deletePendingRequestsByUserId(db, targetId);
}

export function usersReportText(db) {
  const allowed = accessRepo.listAllowed(db);
  const pending = accessRepo.listPendingRequests(db);

  return [
    `Owner: ${config.OWNER_ID || "не задан"}`,
    `Allowed (${allowed.length}): ${allowed.length ? allowed.join(", ") : "—"}`,
    `Pending (${pending.length}): ${
      pending.length ? pending.map((p) => `${p.userId}${p.username ? `(@${p.username})` : ""}`).join(", ") : "—"
    }`,
    "",
    "Manual control:",
    "/allow <user_id> (или reply на сообщение)",
    "/deny <user_id> (или reply на сообщение)",
  ].join("\n");
}
