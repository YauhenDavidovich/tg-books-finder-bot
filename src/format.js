export function normalizeLines(text) {
    const lines = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
  
    // выкидываем явный мусор из рилсов и списков
    const trash = [
      "part", "топ", "top", "подпис", "subscribe", "лайк", "like",
      "сохрани", "save", "reels", "instagram"
    ];
  
    const filtered = lines.filter(l => {
      const low = l.toLowerCase();
      if (low.length < 4) return false;
      if (trash.some(t => low.includes(t))) return false;
      if (/^\d+$/.test(low)) return false;
      if (/^(https?:\/\/|www\.)/.test(low)) return false;
      return true;
    });
  
    // иногда OCR режет название на 2 строки, тут простая склейка коротких строк
    const merged = [];
    for (const line of filtered) {
      const prev = merged[merged.length - 1];
      if (prev && prev.length < 18 && line.length < 30) {
        merged[merged.length - 1] = `${prev} ${line}`.replace(/\s+/g, " ").trim();
      } else {
        merged.push(line);
      }
    }
  
    // дедуп по нижнему регистру
    const seen = new Set();
    return merged.filter(l => {
      const key = l.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 12);
  }
  
  export function shortText(s, max = 240) {
    if (!s) return null;
    const plain = s.replace(/\s+/g, " ").trim();
    if (plain.length <= max) return plain;
    return plain.slice(0, max - 1).trim() + "…";
  }