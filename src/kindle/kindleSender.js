import crypto from "crypto";
import { Markup } from "telegraf";
import { Resend } from "resend";
import nodemailer from "nodemailer";
import { getUrl, toAbsoluteUrl } from "../providers/flibustaProvider.js";
import { getKindleEmail } from "./kindleEmail.js";
import { fetchWithTimeout } from "../core/fetchWithTimeout.js";

// Short-lived pending "send to kindle" click tokens - fine to keep in-memory
// only, unlike access/kindle-email/limits state these don't need to survive
// a restart.
const kindleSendStore = new Map();

function sanitizeFilename(name, ext) {
  const base = String(name || "book")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "book";
  return `${base}.${ext}`;
}

export function buildKindleButton(db, userId, book) {
  const email = getKindleEmail(db, userId);
  if (!email) return null;

  const id = String(book?.id || "");
  if (!id) return null;

  const epub = toAbsoluteUrl(getUrl(id, "epub"));
  const mobi = toAbsoluteUrl(getUrl(id, "mobi"));
  const fileUrl = epub || mobi;
  if (!fileUrl) return null;

  const ext = epub ? "epub" : "mobi";
  const filename = sanitizeFilename(book?.title || "book", ext);
  const token = crypto.randomBytes(8).toString("hex");

  kindleSendStore.set(token, {
    userId,
    email,
    fileUrl,
    filename,
    createdAt: Date.now(),
  });

  return Markup.button.callback("📩 Send to Kindle", `kindle:send:${token}`);
}

export function getKindleSendPayload(token) {
  return kindleSendStore.get(token);
}

export async function sendToKindle({ toEmail, fileUrl, filename }) {
  const resendKey = process.env.RESEND_API_KEY;
  const resendFrom = process.env.RESEND_FROM || "onboarding@resend.dev";

  const res = await fetchWithTimeout(fileUrl, {}, 20000);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  if (resendKey) {
    const resend = new Resend(resendKey);
    await Promise.race([
      resend.emails.send({
        from: resendFrom,
        to: [toEmail],
        subject: "Convert",
        text: "Send to Kindle",
        attachments: [
          {
            filename,
            content: buffer,
          },
        ],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("RESEND timeout")), 20000)),
    ]);
    return;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass || !from) {
    throw new Error("SMTP not configured");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 20000,
  });

  await Promise.race([
    transporter.sendMail({
      from,
      to: toEmail,
      subject: "Convert",
      text: "Send to Kindle",
      attachments: [
        {
          filename,
          content: buffer,
        },
      ],
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("SMTP timeout")), 20000)),
  ]);
}

export async function testDelivery() {
  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await Promise.race([
      resend.emails.send({
        from: process.env.RESEND_FROM || "onboarding@resend.dev",
        to: [process.env.SMTP_USER || "davidovichyauhen@gmail.com"],
        subject: "SMTP test",
        text: "Resend OK",
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("RESEND timeout")), 20000)),
    ]);
    return "✅ RESEND OK";
  }

  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    const e = new Error("SMTP_USER/SMTP_PASS не заданы");
    e.isConfigMissing = true;
    throw e;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 20000,
  });

  await Promise.race([
    transporter.verify(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("SMTP timeout")), 20000)),
  ]);

  return "✅ SMTP OK";
}

export function kindleErrorHint(e) {
  const msg = String(e?.message || e).toLowerCase();

  if (msg.includes("resend")) return "Resend не отвечает или ключ неверный. Проверь RESEND_API_KEY/RESEND_FROM";
  if (msg.includes("smtp")) return "SMTP не настроен. Нужны SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM в .env";
  if (msg.includes("535") || msg.includes("auth")) return "SMTP авторизация не прошла. Проверь SMTP_USER/SMTP_PASS (app password)";
  if (msg.includes("550") || msg.includes("whitelist")) return "Amazon отклонил письмо. Добавь адрес отправителя в Approved Personal Document Email List";
  if (msg.includes("timed out") || msg.includes("timeout")) return "Таймаут при отправке. Попробуй ещё раз или проверь SMTP/Resend";
  if (msg.includes("file") && msg.includes("size")) return "Файл слишком большой для отправки на Kindle";

  return "Не удалось отправить на Kindle";
}
