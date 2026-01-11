// src/providers/flibustaProvider.js

import {
    searchBooks as searchBooksApi,
    searchByAuthor as searchByAuthorApi,
    getBookInfo as getBookInfoApi,
    downBook as downBookApi,
    getUrl as getUrlApi
  } from "flibusta-api";
  
  // --- helpers
  
  function normalizeText(text) {
    return String(text ?? "").trim();
  }
  
  function normalizeLimit(limit, fallback) {
    const n = Number(limit);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(Math.floor(n), 100));
  }
  
  function normalizeId(id) {
    const s = String(id ?? "").trim();
    return s && /^[0-9]+$/.test(s) ? s : null;
  }
  
  function toTelegramErrorMessage(action, err) {
    const raw =
      err?.message ||
      err?.cause?.message ||
      (typeof err === "string" ? err : "");
  
    const msg = String(raw).toLowerCase();
  
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return `⏳ Флибуста сейчас отвечает слишком долго. Попробуй ещё раз через минуту.`;
    }
  
    if (
      msg.includes("enotfound") ||
      msg.includes("eai_again") ||
      msg.includes("dns") ||
      msg.includes("network") ||
      msg.includes("fetch") ||
      msg.includes("socket") ||
      msg.includes("connect")
    ) {
      return `🌐 Проблема с сетью при запросе к Флибусте. Попробуй ещё раз.`;
    }
  
    if (msg.includes("403") || msg.includes("forbidden")) {
      return `🚫 Доступ к Флибусте сейчас закрыт. Часто помогает VPN или другая сеть.`;
    }
  
    if (msg.includes("429") || msg.includes("too many")) {
      return `🐢 Слишком много запросов к Флибусте. Подожди минуту и повтори.`;
    }
  
    if (msg.includes("5") || msg.includes("server")) {
      return `⚠️ Флибуста временно недоступна. Попробуй чуть позже.`;
    }
  
    return `⚠️ Не получилось ${action}. Попробуй ещё раз чуть позже.`;
  }
  
  async function safeCall(action, fn) {
    try {
      return await fn();
    } catch (err) {
      const e = new Error(toTelegramErrorMessage(action, err));
      e.cause = err;
      e.isUserFacing = true;
      throw e;
    }
  }
  
  // --- API
  
  export async function searchBooks(text, limit = 20) {
    const q = normalizeText(text);
    if (!q) return [];
  
    const lim = normalizeLimit(limit, 20);
  
    return safeCall("найти книги", () => searchBooksApi(q, lim));
  }
  
  export async function searchByAuthor(text, limit = 10) {
    const q = normalizeText(text);
    if (!q) return [];
  
    const lim = normalizeLimit(limit, 10);
  
    return safeCall("найти автора", () => searchByAuthorApi(q, lim));
  }
  
  export async function getBookInfo(id) {
    const num = Number(id);
    if (!Number.isFinite(num) || num <= 0) return undefined;
  
    return safeCall("получить информацию о книге", () => getBookInfoApi(num));
  }
  
  export async function downBook(id, format = "mobi") {
    const bookId = normalizeId(id);
    if (!bookId) {
      const e = new Error("⚠️ Не вижу корректный ID книги. Он должен быть числом.");
      e.isUserFacing = true;
      throw e;
    }
  
    return safeCall("скачать книгу", () => downBookApi(bookId, format));
  }
  
  export function getUrl(id, format = "mobi") {
    const bookId = normalizeId(id);
    if (!bookId) return "";
  
    return getUrlApi(bookId, format);
  }