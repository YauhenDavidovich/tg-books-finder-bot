import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import crypto from "crypto";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";

// ✅ Флибуста, единственная точка импорта flibusta-api сидит внутри провайдера
import { searchBooks, searchByAuthor, getBookInfo, getUrl } from "./providers/flibustaProvider.js";

import { geminiExtractBookFromImageBuffer } from "./geminiVision.js";
import { findBookByTitleAuthor, findBooksByQuery } from "./books.js";
import { geminiExtractBookQueryFromText, geminiDebugBookQueryFromText } from "./geminiTextSearch.js";
import { replyWithFlibustaResult } from "./helpers/flibustaReply.js";

const bot = new Telegraf(process.env.BOT_TOKEN);

const ALLOWED_THREAD_ID = 0;
const BOOKS_KEY = process.env.GOOGLE_BOOKS_API_KEY || "";
const OWNER_ID = Number(process.env.OWNER_ID || 0);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ACCESS_FILE = process.env.ACCESS_FILE || path.join(__dirname, "../data/access.json");
const KINDLE_FILE = process.env.KINDLE_FILE || path.join(__dirname, "../data/kindle.json");

const cache = new Map();

let RAW_MODE = process.env.RAW_MODE === "1"; // /raw on|off тоже работает
let FLIBUSTA_DEBUG = process.env.FLIBUSTA_DEBUG === "1"; // /fdebug on|off тоже работает
let GEMINI_DEBUG = process.env.GEMINI_DEBUG === "1"; // /gdebug on|off

const MAX_TG_LEN = 3800;
const FLIBUSTA_BASE_URL = (process.env.FLIBUSTA_BASE_URL || "https://flibusta.is").replace(/\/+$/, "");

const accessStore = {
  allowed: new Set(),
  pending: {},
};

const kindleStore = {
  emails: {},
};

const pendingFind = new Map();
const pendingKindle = new Map();
const kindleSendStore = new Map();

async function loadAccessStore() {
  try {
    const raw = await fs.readFile(ACCESS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const allowed = Array.isArray(parsed?.allowed) ? parsed.allowed.map((x) => Number(x)).filter(Boolean) : [];
    const pending = parsed?.pending && typeof parsed.pending === "object" ? parsed.pending : {};

    accessStore.allowed = new Set(allowed);
    accessStore.pending = pending;
  } catch {
    await saveAccessStore();
  }
}

async function saveAccessStore() {
  const dir = path.dirname(ACCESS_FILE);
  await fs.mkdir(dir, { recursive: true });
  const payload = {
    allowed: [...accessStore.allowed],
    pending: accessStore.pending,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(ACCESS_FILE, JSON.stringify(payload, null, 2), "utf8");
}

async function loadKindleStore() {
  try {
    const raw = await fs.readFile(KINDLE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    kindleStore.emails = parsed?.emails && typeof parsed.emails === "object" ? parsed.emails : {};
  } catch {
    await saveKindleStore();
  }
}

async function saveKindleStore() {
  const dir = path.dirname(KINDLE_FILE);
  await fs.mkdir(dir, { recursive: true });
  const payload = {
    emails: kindleStore.emails || {},
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(KINDLE_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function getUserId(ctx) {
  return Number(ctx.from?.id || 0);
}

function isOwner(userId) {
  return Boolean(OWNER_ID) && Number(userId) === OWNER_ID;
}

function isAllowedUser(userId) {
  if (!userId) return false;
  if (isOwner(userId)) return true;
  return accessStore.allowed.has(Number(userId));
}

function parseTargetUserId(ctx) {
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

function getKindleEmail(userId) {
  if (!userId) return "";
  return String(kindleStore.emails?.[String(userId)] || "").trim();
}

function isValidKindleEmail(email) {
  const s = String(email || "").trim().toLowerCase();
  if (!s) return false;
  const basic = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  if (!basic) return false;
  return s.endsWith("@kindle.com") || s.endsWith("@free.kindle.com");
}

function requestAccessKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("✅ Запросить доступ", "acc:req")]]);
}

async function requestAccess(ctx) {
  const userId = getUserId(ctx);
  if (!userId) return;

  if (isAllowedUser(userId)) {
    await ctx.reply("У тебя уже есть доступ ✅", { message_thread_id: ctx.message?.message_thread_id });
    return;
  }

  const existingToken = Object.keys(accessStore.pending).find((t) => Number(accessStore.pending[t]?.userId) === userId);
  if (existingToken) {
    await ctx.reply("Заявка уже отправлена. Жди подтверждения владельца 👌", {
      message_thread_id: ctx.message?.message_thread_id,
    });
    return;
  }

  const token = crypto.randomBytes(8).toString("hex");
  accessStore.pending[token] = {
    userId,
    firstName: String(ctx.from?.first_name || ""),
    lastName: String(ctx.from?.last_name || ""),
    username: String(ctx.from?.username || ""),
    createdAt: new Date().toISOString(),
  };
  await saveAccessStore();

  if (OWNER_ID) {
    const who = `${accessStore.pending[token].firstName} ${accessStore.pending[token].lastName}`.trim() || "Unknown";
    const uname = accessStore.pending[token].username ? `@${accessStore.pending[token].username}` : "(без username)";
    await bot.telegram.sendMessage(
      OWNER_ID,
      `Новая заявка на доступ:\n${who} ${uname}\nuser_id: ${userId}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Approve", `acc:approve:${token}`),
          Markup.button.callback("❌ Reject", `acc:reject:${token}`),
        ],
      ])
    );

    await ctx.reply("Заявка отправлена владельцу. После одобрения бот начнёт отвечать 🙌", {
      message_thread_id: ctx.message?.message_thread_id,
    });
    return;
  }

  await ctx.reply("OWNER_ID не настроен. Передай владельцу, чтобы добавил OWNER_ID в .env", {
    message_thread_id: ctx.message?.message_thread_id,
  });
}

async function ensureAllowedOrRequest(ctx) {
  const userId = getUserId(ctx);
  if (isAllowedUser(userId)) return true;

  await ctx.reply("Сейчас бот работает по доступу. Нажми кнопку, и я отправлю заявку владельцу.", {
    ...requestAccessKeyboard(),
    message_thread_id: ctx.message?.message_thread_id,
  });
  return false;
}

// --- helpers

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
  if (!ALLOWED_THREAD_ID) return true;
  const threadId = ctx.message?.message_thread_id;
  return Number(threadId) === ALLOWED_THREAD_ID;
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function scoreMatch(candidate, title, author) {
  const ct = norm(candidate?.title);
  const ca = norm(candidate?.author);
  const qt = norm(title);
  const qa = norm(author);

  let score = 0;

  if (qt && ct === qt) score += 6;
  else if (qt && (ct.includes(qt) || qt.includes(ct))) score += 4;

  // token overlap helps with partial/missing words (e.g. "перевал середине пути")
  if (qt && ct) {
    const qTokens = qt.split(/\s+/).filter(Boolean);
    const cTokens = new Set(ct.split(/\s+/).filter(Boolean));
    if (qTokens.length) {
      const matched = qTokens.filter((t) => cTokens.has(t)).length;
      const ratio = matched / qTokens.length;
      if (ratio >= 0.8) score += 2;
      else if (ratio >= 0.6) score += 1;
    }
  }

  if (qa && ca === qa) score += 4;
  else if (qa && (ca.includes(qa) || qa.includes(ca))) score += 2;

  return score;
}

function shortTitle(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const cut = s.split(/[.:—–(]| - /)[0].trim();
  return cut.length >= 4 ? cut : s;
}

function sanitizeFilename(name, ext) {
  const base = String(name || "book")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "book";
  return `${base}.${ext}`;
}

function buildKindleButton(ctx, book) {
  const userId = getUserId(ctx);
  const email = getKindleEmail(userId);
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

function formatFlibustaList(list, limit = 5) {
  if (!Array.isArray(list) || list.length === 0) return "пусто";
  return list
    .slice(0, limit)
    .map((b, i) => {
      const id = b?.id ?? "?";
      const t = String(b?.title ?? "").slice(0, 120);
      const a = String(b?.author ?? "").slice(0, 80);
      return `${i + 1}) ${id} | ${t}${a ? `, ${a}` : ""}`;
    })
    .join("\n");
}

async function replyChunked(ctx, text) {
  const threadId = ctx.message?.message_thread_id;
  if (!text) return;

  if (text.length <= MAX_TG_LEN) {
    await ctx.reply(text, { message_thread_id: threadId });
    return;
  }

  await ctx.reply(text.slice(0, MAX_TG_LEN), { message_thread_id: threadId });
  await ctx.reply(text.slice(MAX_TG_LEN, MAX_TG_LEN * 2), { message_thread_id: threadId });
}

function toAbsoluteUrl(url) {
  const s = String(url ?? "").trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return `${FLIBUSTA_BASE_URL}${s}`;
  return "";
}

async function sendToKindle({ toEmail, fileUrl, filename }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass || !from) {
    throw new Error("SMTP not configured");
  }

  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({
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
  });
}

// универсальный подбор попыток для Флибусты (упрощённый, без *_ru и без variants)
function buildFlibustaAttemptsFromQuery(q, input) {
  const attempts = [];
  const add = (title, author = null) => {
    const t = String(title || "").trim();
    const a = String(author || "").trim();
    if (!t) return;
    attempts.push({ title: t, author: a || null });
  };

  // 1) самое сильное: title + author
  if (q?.title) add(q.title, q.author || null);

  // 2) title без автора
  if (q?.title) add(q.title, null);

  // 3) query
  if (q?.query) add(q.query, null);

  // 4) последний шанс: original input
  if (input) add(input, null);

  // дедуп по "title|author"
  const seen = new Set();
  const uniq = [];
  for (const a of attempts) {
    const key = `${norm(a.title)}|${norm(a.author || "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(a);
  }

  return uniq;
}

async function tryFlibustaFirst(ctx, { title, author }) {
  const fullTitle = String(title ?? "").trim();
  const qAuthor = String(author ?? "").trim();
  const tShort = shortTitle(fullTitle);

  if (!tShort) return null;

  const queriesRaw = [qAuthor ? `${tShort} ${qAuthor}` : tShort, tShort, fullTitle].filter(Boolean);
  const queries = [...new Set(queriesRaw)];

  let candidates = [];

  for (const q of queries) {
    const list = await searchBooks(q, 40);

    if (FLIBUSTA_DEBUG) {
      const text =
        `FLIBUSTA searchBooks("${q}") -> ${Array.isArray(list) ? list.length : 0}\n` +
        formatFlibustaList(list, 5);
      await replyChunked(ctx, text);
    }

    if (Array.isArray(list) && list.length) candidates = candidates.concat(list);
  }

  if ((!candidates || candidates.length === 0) && qAuthor) {
    const byA = await searchByAuthor(qAuthor, 80);

    if (FLIBUSTA_DEBUG) {
      const text =
        `FLIBUSTA searchByAuthor("${qAuthor}") -> ${Array.isArray(byA) ? byA.length : 0}\n` +
        formatFlibustaList(byA, 5);
      await replyChunked(ctx, text);
    }

    if (Array.isArray(byA) && byA.length) candidates = candidates.concat(byA);
  }

  if (!candidates.length) return null;

  const uniq = [];
  const seen = new Set();
  for (const b of candidates) {
    const key = String(b?.id ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(b);
  }

  let best = null;
  let bestScore = -1;

  for (const b of uniq) {
    const s = scoreMatch(b, tShort, qAuthor);
    if (s > bestScore) {
      bestScore = s;
      best = b;
    }
  }

  const minScore = qAuthor ? 4 : 4;

  if (FLIBUSTA_DEBUG) {
    const picked = best
      ? `bestScore=${bestScore}, minScore=${minScore}\nBEST: ${best.id} | ${best.title}${best.author ? `, ${best.author}` : ""}`
      : `BEST: null`;
    await replyChunked(ctx, `FLIBUSTA picked:\n${picked}`);
  }

  if (!best || bestScore < minScore) return null;

  const info = await getBookInfo(best.id);
  return { book: best, info, score: bestScore };
}

async function handleFindQuery(ctx, input) {
  // 0) Gemini raw debug: показываем candidateText и finishReason
  if (GEMINI_DEBUG) {
    try {
      const dbg = await geminiDebugBookQueryFromText(input);
      const bodyPreview = String(dbg?.rawBody || "").slice(0, 2000);
      const candPreview = String(dbg?.candidateText || "").slice(0, 2000);
      const info =
        `GEMINI DEBUG\n` +
        `finishReason: ${dbg?.finishReason || "-"}\n` +
        `status: ${dbg?.status ?? "-"}\n\n` +
        `candidateText:\n${candPreview || "(empty)"}\n\n` +
        `rawBody preview:\n${bodyPreview || "(empty)"}`;

      await replyChunked(ctx, info);
    } catch (e) {
      await replyChunked(ctx, `GEMINI DEBUG ERROR:\n${String(e?.message || e).slice(0, 3500)}`);
    }
  }

  // 1) Gemini parsed JSON
  const q = await geminiExtractBookQueryFromText(input);
  const conf = Number(q?.confidence ?? 0) || 0;

  if (!q?.query) {
    await ctx.reply("Мало деталей. Добавь 2–3 штуки: страна, время, профессия героя, конфликт, жанр.", {
      message_thread_id: ctx.message?.message_thread_id,
    });
    return;
  }

  if (conf < 0.25) {
    await ctx.reply(`Уверенность низкая (${conf.toFixed(2)}), но я всё равно попробую поискать.`, {
      message_thread_id: ctx.message?.message_thread_id,
    });
  }

  const pseudoBestItem = {
    confidence: q.confidence ?? 0,
    evidence: [q.title ? `title:${q.title}` : null, q.author ? `author:${q.author}` : null, q.query ? `query:${q.query}` : null].filter(Boolean),
  };

  // 2) PRIORITY: Flibusta
  const attempts = buildFlibustaAttemptsFromQuery(q, input);

  let flibustaResult = null;
  for (const a of attempts) {
    flibustaResult = await tryFlibustaFirst(ctx, a);
    if (flibustaResult?.book) break;
  }

  const cacheKey = `find:${norm(`${q.title || ""} ${q.author || ""} ${q.query || ""}`)}`;

  const kindleButton = flibustaResult?.book ? buildKindleButton(ctx, flibustaResult.book) : null;
  const handled = await replyWithFlibustaResult({
    ctx,
    flibustaResult,
    bestItem: pseudoBestItem,
    toAbsoluteUrl,
    getUrl,
    cache,
    cacheKey,
    extraButtons: kindleButton ? [kindleButton] : [],
  });

  if (handled) return;

  // 3) Fallback: Google Books
  const parts = [];
  if (q.title) parts.push(`intitle:"${q.title}"`);
  if (q.author) parts.push(`inauthor:"${q.author}"`);
  if (!parts.length) parts.push(q.query);

  const finalQuery = parts.join(" ").trim();
  const results = await findBooksByQuery(finalQuery, BOOKS_KEY);

  if (!results.length) {
    await ctx.reply(`Не нашёл по запросу: ${q.query}\nПопробуй: больше деталей или имя автора.`, {
      message_thread_id: ctx.message?.message_thread_id,
    });
    return;
  }

  const top = results[0];
  const url = top.canonicalLink || `https://www.google.com/search?q=${encodeURIComponent(finalQuery)}`;
  const extra = Markup.inlineKeyboard([[Markup.button.url("Открыть", url)]]);

  const author = top.authors?.[0] ? `, ${top.authors[0]}` : "";

  await ctx.reply(`Похоже на:\n• ${top.title || q.query}${author}\n\nЗапрос: ${q.query}\nУверенность: ${(q.confidence ?? 0).toFixed(2)}`, {
    ...extra,
    message_thread_id: ctx.message?.message_thread_id,
  });
}

// --- commands

bot.action("acc:req", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await requestAccess(ctx);
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
    const req = accessStore.pending[token];
    if (!req) {
      await ctx.answerCbQuery("Заявка уже обработана");
      return;
    }

    const userId = Number(req.userId);

    if (action === "approve") {
      accessStore.allowed.add(userId);
      delete accessStore.pending[token];
      await saveAccessStore();

      await ctx.editMessageText(`✅ Доступ выдан пользователю ${userId}`);
      await ctx.answerCbQuery("Одобрено");
      await bot.telegram.sendMessage(userId, "✅ Доступ одобрен. Можешь отправлять текст или фото книги.");
      return;
    }

    delete accessStore.pending[token];
    await saveAccessStore();
    await ctx.editMessageText(`❌ Доступ отклонён для ${userId}`);
    await ctx.answerCbQuery("Отклонено");
    await bot.telegram.sendMessage(userId, "❌ Заявка отклонена владельцем.");
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery("Ошибка");
  }
});

bot.action(/^kindle:send:([a-f0-9]+)$/, async (ctx) => {
  try {
    const actorId = getUserId(ctx);
    const token = ctx.match?.[1];
    const payload = kindleSendStore.get(token);

    if (!payload) {
      await ctx.answerCbQuery("Ссылка устарела", { show_alert: true });
      return;
    }

    if (!actorId || payload.userId !== actorId) {
      await ctx.answerCbQuery("Эта кнопка не для вас", { show_alert: true });
      return;
    }

    const email = getKindleEmail(actorId);
    if (!email) {
      await ctx.answerCbQuery("Сначала укажи Kindle email", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery("Отправляю на Kindle...");

    await sendToKindle({
      toEmail: email,
      fileUrl: payload.fileUrl,
      filename: payload.filename,
    });

    await ctx.reply(`Отправил на Kindle: ${email}`, {
      message_thread_id: ctx.message?.message_thread_id,
    });
  } catch (e) {
    console.error(e);
    const msg = String(e?.message || e);
    const hint = msg.includes("SMTP")
      ? "SMTP не настроен. Нужны SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM в .env"
      : "Не удалось отправить на Kindle";
    await ctx.reply(hint, { message_thread_id: ctx.message?.message_thread_id });
  }
});

bot.command("users", async (ctx) => {
  const actorId = getUserId(ctx);
  if (!isOwner(actorId)) return;

  const allowed = [...accessStore.allowed].sort((a, b) => a - b);
  const pending = Object.values(accessStore.pending);
  const lines = [
    `Owner: ${OWNER_ID || "не задан"}`,
    `Allowed (${allowed.length}): ${allowed.length ? allowed.join(", ") : "—"}`,
    `Pending (${pending.length}): ${
      pending.length ? pending.map((p) => `${p.userId}${p.username ? `(@${p.username})` : ""}`).join(", ") : "—"
    }`,
    "",
    "Manual control:",
    "/allow <user_id> (или reply на сообщение)",
    "/deny <user_id> (или reply на сообщение)",
  ];

  await ctx.reply(lines.join("\n"), { message_thread_id: ctx.message?.message_thread_id });
});

bot.command("allow", async (ctx) => {
  const actorId = getUserId(ctx);
  if (!isOwner(actorId)) return;

  const targetId = parseTargetUserId(ctx);
  if (!targetId) {
    await ctx.reply("Используй: /allow <user_id> или reply на сообщение пользователя", {
      message_thread_id: ctx.message?.message_thread_id,
    });
    return;
  }

  accessStore.allowed.add(Number(targetId));

  // remove pending requests for same user (if any)
  for (const token of Object.keys(accessStore.pending)) {
    if (Number(accessStore.pending[token]?.userId) === Number(targetId)) {
      delete accessStore.pending[token];
    }
  }

  await saveAccessStore();

  await ctx.reply(`✅ Добавил в allowlist: ${targetId}`, {
    message_thread_id: ctx.message?.message_thread_id,
  });

  try {
    await bot.telegram.sendMessage(targetId, "✅ Доступ выдан владельцем. Можно пользоваться ботом.");
  } catch {}
});

bot.command("deny", async (ctx) => {
  const actorId = getUserId(ctx);
  if (!isOwner(actorId)) return;

  const targetId = parseTargetUserId(ctx);
  if (!targetId) {
    await ctx.reply("Используй: /deny <user_id> или reply на сообщение пользователя", {
      message_thread_id: ctx.message?.message_thread_id,
    });
    return;
  }

  accessStore.allowed.delete(Number(targetId));

  for (const token of Object.keys(accessStore.pending)) {
    if (Number(accessStore.pending[token]?.userId) === Number(targetId)) {
      delete accessStore.pending[token];
    }
  }

  await saveAccessStore();

  await ctx.reply(`❌ Убрал доступ: ${targetId}`, {
    message_thread_id: ctx.message?.message_thread_id,
  });

  try {
    await bot.telegram.sendMessage(targetId, "❌ Доступ отозван владельцем.");
  } catch {}
});

bot.start(async (ctx) => {
  if (!(await ensureAllowedOrRequest(ctx))) return;

  const userId = getUserId(ctx);
  const hasKindle = userId ? Boolean(getKindleEmail(userId)) : false;
  const kindleLabel = hasKindle ? "✏️ Изменить Kindle email" : "📩 Kindle email";
  const kb = Markup.keyboard([["🔎 Find", kindleLabel]]).resize();
  await ctx.reply(
    "Нажми 🔎 Find и пришли описание книги (кратко: сюжет/цитата/название/автор).\n\nЕсли отправишь фото обложки — я попробую найти книгу по картинке.",
    { ...kb, message_thread_id: ctx.message?.message_thread_id }
  );
});

bot.hears("🔎 Find", async (ctx) => {
  if (!(await ensureAllowedOrRequest(ctx))) return;
  const userId = getUserId(ctx);
  if (userId) pendingFind.set(userId, true);
  await ctx.reply("Введи описание книги или название и автора — я начну поиск.", {
    message_thread_id: ctx.message?.message_thread_id,
  });
});

bot.hears(["📩 Kindle email", "✏️ Изменить Kindle email"], async (ctx) => {
  if (!(await ensureAllowedOrRequest(ctx))) return;
  const userId = getUserId(ctx);
  if (userId) pendingKindle.set(userId, true);
  await ctx.reply("Пришли свой Kindle email (например, name@kindle.com).", {
    message_thread_id: ctx.message?.message_thread_id,
  });
});

bot.command("find", async (ctx) => {
  try {
    if (!(await ensureAllowedOrRequest(ctx))) return;

    const input = (ctx.message?.text || "").split(" ").slice(1).join(" ").trim();
    if (!input) {
      const userId = getUserId(ctx);
      if (userId) pendingFind.set(userId, true);
      await ctx.reply("Введи описание книги или название и автора — я начну поиск.", {
        message_thread_id: ctx.message?.message_thread_id,
      });
      return;
    }

    await handleFindQuery(ctx, input);
  } catch (e) {
    console.error(e);
    const msg = String(e?.message || e).slice(0, 1600);
    await ctx.reply(`Ошибка: ${msg}`, { message_thread_id: ctx.message?.message_thread_id });
  }
});

// --- main

bot.on("text", async (ctx) => {
  try {
    if (!isAllowedTopic(ctx)) return;
    if (!(await ensureAllowedOrRequest(ctx))) return;

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

      kindleStore.emails[String(userId)] = email;
      await saveKindleStore();

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
    await handleFindQuery(ctx, text);
  } catch (e) {
    console.error(e);
    const msg = String(e?.message || e).slice(0, 1600);
    await ctx.reply(`Ошибка: ${msg}`, { message_thread_id: ctx.message?.message_thread_id });
  }
});

bot.on("photo", async (ctx) => {
  try {
    if (!isAllowedTopic(ctx)) return;
    if (!(await ensureAllowedOrRequest(ctx))) return;

    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];
    const buffer = await downloadTelegramFile(ctx, best.file_id);

    const hash = sha256(buffer);
    const cached = cache.get(hash);
    if (cached && !RAW_MODE) {
      await ctx.reply(cached.text, { ...cached.extra, message_thread_id: ctx.message.message_thread_id });
      return;
    }

    // 1) Gemini Vision: image -> JSON
    const extracted = await geminiExtractBookFromImageBuffer(buffer, "image/jpeg");

    if (RAW_MODE) {
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

    const guessedTitle = bestItem.title;
    const guessedAuthor = bestItem.author || null;

    // 2) PRIORITY: Flibusta
    const flibustaResult = await tryFlibustaFirst(ctx, { title: guessedTitle, author: guessedAuthor });

    const kindleButton = flibustaResult?.book ? buildKindleButton(ctx, flibustaResult.book) : null;
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
    const book = await findBookByTitleAuthor({ title: guessedTitle, author: guessedAuthor }, BOOKS_KEY);

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
    if (process.env.DEBUG_ERRORS === "1") {
      await ctx.reply(`Ошибка: ${msg}`, { message_thread_id: ctx.message?.message_thread_id });
    } else {
      await ctx.reply("Что-то пошло не так при обработке скрина. Попробуй еще раз.", {
        message_thread_id: ctx.message?.message_thread_id,
      });
    }
  }
});

await loadAccessStore();
await loadKindleStore();
if (OWNER_ID) {
  accessStore.allowed.add(OWNER_ID);
  await saveAccessStore();
}

bot.telegram
  .setMyCommands([
    { command: "find", description: "Найти книгу по описанию" },
    { command: "users", description: "Список доступов (owner)" },
    { command: "allow", description: "Выдать доступ (owner)" },
    { command: "deny", description: "Забрать доступ (owner)" },
  ])
  .catch((e) => console.error("setMyCommands failed:", e?.message || e));

bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));