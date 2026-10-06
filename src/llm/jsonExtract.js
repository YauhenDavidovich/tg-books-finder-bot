// Shared JSON-recovery helpers for LLM responses - direct Gemini and the
// models routed through FreeLLMAPI. Gemini with a responseSchema returns
// clean JSON, but other models wrap it in prose, ```json fences or
// <think> blocks, and small output budgets can cut it off mid-object.

export function stripCodeFences(s) {
  return (s || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

// Reasoning models put their chain of thought before the answer. An
// unclosed block means the output budget ran out mid-thought, so there is
// no answer at all - drop everything after it.
export function stripThinking(s) {
  return String(s || "")
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
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

  // Trim the partial token the cut left at the tail until a closing bracket
  // can follow it: a trailing comma, a number cut mid-way ("0."), a literal
  // cut mid-way ("tru"), or - inside an object - a key whose value never
  // arrived ("b" / "b":).
  const inObject = stack[stack.length - 1] === "}";
  for (let prev = null; prev !== repaired; ) {
    prev = repaired;
    repaired = repaired
      .replace(/\s+$/, "")
      .replace(/,$/, "")
      .replace(/(\d)[.eE+-]+$/, "$1")
      .replace(/:\s*(?!(?:true|false|null)$)[a-z]+$/, ":");
    if (inObject) repaired = repaired.replace(/([{,])\s*"(?:[^"\\]|\\.)*"\s*:?$/, "$1");
  }

  while (stack.length) repaired += stack.pop();
  if (!repaired.endsWith("}")) repaired += "}";

  return repaired;
}

// Tries, in order: direct parse, extracted-object parse, repaired-truncated
// parse - on the first fenced block if there is one (closed or cut off),
// otherwise on the whole text, with <think> blocks removed. Throws if none
// succeed.
export function parseJsonLoose(candidateText) {
  const text = stripThinking(candidateText);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  const cleaned = stripCodeFences(fenced ? fenced[1] : text);

  try {
    return JSON.parse(cleaned);
  } catch {}

  const jsonOnly = extractJsonObject(cleaned);
  if (jsonOnly) {
    try {
      return JSON.parse(jsonOnly);
    } catch {}
  }

  const start = cleaned.indexOf("{");
  const repaired = start === -1 ? null : tryRepairTruncatedJson(cleaned.slice(start));
  if (repaired) {
    try {
      return JSON.parse(repaired);
    } catch {}
  }

  throw new Error(`No JSON object found in LLM response.\nCandidate text preview:\n${(candidateText || "").slice(0, 800)}`);
}
