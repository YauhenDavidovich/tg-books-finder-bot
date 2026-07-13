import * as kindleRepo from "../storage/kindleRepo.js";

export function getKindleEmail(db, userId) {
  return kindleRepo.getKindleEmail(db, userId);
}

export function setKindleEmail(db, userId, email) {
  kindleRepo.setKindleEmail(db, userId, email);
}

export function isValidKindleEmail(email) {
  const s = String(email || "").trim().toLowerCase();
  if (!s) return false;
  const basic = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  if (!basic) return false;
  return s.endsWith("@kindle.com") || s.endsWith("@free.kindle.com");
}
