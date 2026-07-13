// Shared JSON-recovery helpers for Gemini responses. Previously geminiVision.js
// had its own strip/extract/repair pipeline while geminiTextSearch.js did a
// bare JSON.parse with no fallback, so a stray ```json fence or truncated
// output would crash text search but not image search. Both call sites now
// go through the same recovery pipeline.

export function stripCodeFences(s) {
  return (s || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

export function extractJsonObject(s) {
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

// Attempts to repair a truncated JSON object: closes open strings/brackets.
export function tryRepairTruncatedJson(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str.startsWith("{")) return null;

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
    }
  }

  let repaired = str;

  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, "");
  while (stack.length) repaired += stack.pop();
  if (!repaired.endsWith("}")) repaired += "}";

  return repaired;
}

// Tries, in order: direct parse, fence-stripped parse, extracted-object
// parse, repaired-truncated-object parse. Throws if none succeed.
export function parseJsonLoose(candidateText) {
  const cleaned = stripCodeFences(candidateText);

  try {
    return JSON.parse(cleaned);
  } catch {}

  const jsonOnly = extractJsonObject(cleaned);
  if (jsonOnly) {
    try {
      return JSON.parse(jsonOnly);
    } catch {}
  }

  const repaired = tryRepairTruncatedJson(cleaned);
  if (repaired) {
    try {
      return JSON.parse(repaired);
    } catch {}
  }

  throw new Error(`No JSON object found in Gemini response.\nCandidate text preview:\n${(candidateText || "").slice(0, 800)}`);
}
