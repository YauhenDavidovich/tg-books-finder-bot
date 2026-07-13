export function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function scoreMatch(candidate, title, author) {
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

export function shortTitle(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const cut = s.split(/[.:—–(]| - /)[0].trim();
  return cut.length >= 4 ? cut : s;
}
