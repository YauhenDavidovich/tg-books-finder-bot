// src/llm/client.js — единая точка вызова LLM для tg-books-finder-bot.
// FreeLLMAPI (OpenAI-совместимый роутер бесплатных моделей) + запасной путь
// на прямой Gemini (gemini-direct.js), когда роутер лежит, пул исчерпан или
// модель так и не вернула пригодный JSON.
//
// LLM_PROVIDER: freellmapi_with_fallback (по умолчанию) | freellmapi | direct.
// Без LLM_BASE_URL/LLM_API_KEY режим по умолчанию ходит только в Gemini,
// то есть ведёт себя как бот до перехода на роутер.

import OpenAI from "openai";
import { config } from "../config.js";
import { parseJsonLoose } from "./jsonExtract.js";

export const PROVIDERS = ["freellmapi_with_fallback", "freellmapi", "direct"];

// Ответы роутера, означающие «сейчас не могу», а не «плохой запрос»:
// пул исчерпан (429) или упал сам роутер/провайдер (5xx).
const ROUTER_DOWN_STATUSES = new Set([429, 500, 502, 503, 504]);

// --- Предохранитель: после 2 падений роутера подряд минуту ходим напрямую ---
const BREAK_AFTER = 2;
const COOLDOWN_MS = 60_000;

export const JSON_RULE = "Respond with ONLY a valid JSON object - no explanations, no markdown.";

export class LlmJsonError extends Error {
  constructor(message, { attempts = [] } = {}) {
    super(message);
    this.name = "LlmJsonError";
    this.attempts = attempts;
  }
}

function isConnectionError(err) {
  return err instanceof OpenAI.APIConnectionError; // сеть и таймаут (подкласс)
}

function isRouterDown(err) {
  return isConnectionError(err) || ROUTER_DOWN_STATUSES.has(err?.status);
}

function describeRouterError(err) {
  if (err instanceof OpenAI.APIConnectionTimeoutError) return "router timeout";
  if (isConnectionError(err)) return `router unreachable (${err.cause?.code || err.message})`;
  if (err?.status) {
    // The SDK's message already starts with the status ("503 all keys exhausted").
    const detail = String(err.message || "").replace(new RegExp(`^${err.status}\\s*`), "").slice(0, 200);
    return `router ${err.status}${detail ? `: ${detail}` : ""}`;
  }
  return String(err?.message || err);
}

function describeJsonError(err) {
  if (Array.isArray(err?.issues)) {
    return err.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  return String(err?.message || err).split("\n")[0];
}

/**
 * Опции вызова (все необязательные):
 * - system: system prompt для роутера
 * - maxTokens, temperature (по умолчанию 0), reasoningEffort: параметры роутера
 * - jsonSchema, schemaName: JSON Schema для response_format (только *Json)
 * - schema: zod-схема, которой валидируется `data` (только *Json)
 * - geminiSchema, geminiMaxTokens: параметры прямого Gemini (см. gemini-direct.js)
 * - directImage { base64, mimeType }: текстовый вызов на роутере, но Gemini
 *   получает ещё и картинку (V2 enrich: роутеру картинка не нужна, а
 *   Gemini-путь остаётся как был)
 */
export function createLlm({
  provider = "freellmapi_with_fallback",
  baseURL,
  apiKey,
  model = "auto",
  visionModel = "auto",
  timeoutMs = 30_000,
  jsonMode = "json_schema",
  debug = false,
  logger = console,
  now = Date.now,
} = {}) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown LLM_PROVIDER "${provider}" (expected: ${PROVIDERS.join(" | ")})`);
  }

  const router =
    provider !== "direct" && baseURL && apiKey
      ? new OpenAI({
          baseURL,
          apiKey,
          timeout: timeoutMs,
          // Фейловер между моделями делает сам роутер; ретрай SDK только
          // удвоил бы ожидание перед нашим фолбэком на Gemini.
          maxRetries: 0,
        })
      : null;

  if (provider === "freellmapi" && !router) {
    throw new Error("LLM_PROVIDER=freellmapi requires LLM_BASE_URL and LLM_API_KEY");
  }
  if (provider === "freellmapi_with_fallback" && !router) {
    logger.warn("[llm] LLM_BASE_URL/LLM_API_KEY not set - using direct Gemini only");
  }

  // --- Запасной путь: сюда передаются Gemini-функции из gemini-direct.js ---
  // setDirectFallback({
  //   text:   async (prompt, opts) => string | { text, model, finishReason },
  //   vision: async (imageBase64, mimeType, prompt, opts) => то же,
  // })
  let directFallback = null;
  function setDirectFallback(fns) {
    directFallback = fns;
  }

  let failures = 0;
  let openUntil = 0;

  const fallbackEnabled = () => provider === "freellmapi_with_fallback" && directFallback !== null;

  function shouldFallBack(err, kind) {
    if (isRouterDown(err)) return true;
    // Vision-запрос, попавший на модель без поддержки картинок, приходит
    // как 400 - Gemini на него ответить может.
    return kind === "vision" && err?.status === 400;
  }

  function noteRouterFailure(err) {
    if (!isRouterDown(err)) return;
    failures += 1;
    if (failures >= BREAK_AFTER) {
      failures = 0;
      openUntil = now() + COOLDOWN_MS;
      logger.warn(`[llm] router failed ${BREAK_AFTER} times in a row - direct Gemini for ${COOLDOWN_MS / 1000}s`);
    }
  }

  function responseFormat({ json, jsonSchema, schemaName }) {
    if (!json) return {};
    if (jsonSchema && jsonMode === "json_schema") {
      return { response_format: { type: "json_schema", json_schema: { name: schemaName || "response", schema: jsonSchema } } };
    }
    return { response_format: { type: "json_object" } };
  }

  async function callRouter({ kind, prompt, image, routerSuffix, opts }) {
    const text = routerSuffix ? `${prompt}\n\n${routerSuffix}` : prompt;
    const content = image
      ? [
          { type: "text", text },
          { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
        ]
      : text;

    const body = {
      model: kind === "vision" ? visionModel : model,
      messages: [...(opts.system ? [{ role: "system", content: opts.system }] : []), { role: "user", content }],
      temperature: opts.temperature ?? 0,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      ...responseFormat(opts),
    };

    const t0 = now();
    const { data, response } = await router.chat.completions.create(body).withResponse();
    const choice = data.choices?.[0];

    return {
      text: choice?.message?.content ?? "",
      model: response.headers.get("x-routed-via") ?? data.model ?? body.model,
      latencyMs: now() - t0,
      via: "freellmapi",
      finishReason: choice?.finish_reason ?? null,
    };
  }

  async function callDirect({ prompt, image, opts }, reason) {
    if (!directFallback) {
      throw new Error(`LLM unavailable (${reason || "no router"}) and no direct fallback configured`);
    }
    const img = image || opts.directImage;
    const t0 = now();
    const out = img
      ? await directFallback.vision(img.base64, img.mimeType, prompt, opts)
      : await directFallback.text(prompt, opts);
    const { text = "", model: directModel = "direct", finishReason = null } = typeof out === "string" ? { text: out } : out || {};

    return { text, model: directModel, latencyMs: now() - t0, via: "direct", finishReason, fallbackReason: reason || null };
  }

  async function run(req, { forceDirectReason = null } = {}) {
    let r;
    if (forceDirectReason) {
      logger.warn(`[llm] ${req.kind} -> direct Gemini: ${forceDirectReason}`);
      r = await callDirect(req, forceDirectReason);
    } else if (!router) {
      r = await callDirect(req, provider === "direct" ? null : "router not configured");
    } else if (provider === "freellmapi_with_fallback" && now() < openUntil) {
      r = await callDirect(req, "router circuit open");
    } else {
      try {
        r = await callRouter(req);
        failures = 0;
      } catch (err) {
        if (!(fallbackEnabled() && shouldFallBack(err, req.kind))) throw err;
        noteRouterFailure(err);
        const reason = describeRouterError(err);
        logger.warn(`[llm] ${req.kind} -> direct Gemini: ${reason}`);
        r = await callDirect(req, reason);
      }
    }

    if (debug) {
      logger.log(`[llm] ${req.kind} via=${r.via} model=${r.model} ${r.latencyMs}ms finish=${r.finishReason ?? "-"}`);
    }
    return r;
  }

  // ---------- JSON-ответы ----------

  async function completeJson(req) {
    const opts = { ...req.opts, json: true, system: [req.opts.system, JSON_RULE].filter(Boolean).join("\n\n") };
    const base = { ...req, opts };
    const attempts = [];

    const tryParse = (r, note = null) => {
      const attempt = {
        via: r.via,
        model: r.model,
        latencyMs: r.latencyMs,
        finishReason: r.finishReason,
        fallbackReason: r.fallbackReason ?? null,
        note,
        error: null,
      };
      attempts.push(attempt);
      try {
        const json = parseJsonLoose(r.text);
        const data = opts.schema ? opts.schema.parse(json) : json;
        return { ...r, data, attempts };
      } catch (err) {
        attempt.error = describeJsonError(err);
        logger.warn(`[llm] unusable JSON from ${r.via} model=${r.model} finish=${r.finishReason ?? "-"}: ${attempt.error}`);
        return null;
      }
    };

    let r = await run(base);
    let ok = tryParse(r);
    if (ok) return ok;

    if (r.via === "freellmapi") {
      // Один повтор через роутер с жёстким «только JSON» в самом запросе:
      // другая модель цепочки могла ответить прозой.
      r = await run({ ...base, routerSuffix: JSON_RULE });
      ok = tryParse(r, "retry: JSON only");
      if (ok) return ok;
    }

    if (r.via === "freellmapi" && fallbackEnabled()) {
      r = await run(base, { forceDirectReason: "unusable JSON from router" });
      ok = tryParse(r, "fallback after unusable JSON");
      if (ok) return ok;
    }

    const last = attempts[attempts.length - 1];
    throw new LlmJsonError(
      `LLM returned unusable JSON (${last.via} ${last.model}, finish=${last.finishReason ?? "-"}): ${last.error}\n` +
        `Response preview:\n${String(r.text || "").slice(0, 300) || "(empty)"}`,
      { attempts }
    );
  }

  // ---------- Публичный API ----------

  return {
    setDirectFallback,
    /** Текстовый запрос → { text, model, latencyMs, via, finishReason } */
    chat: (prompt, opts = {}) => run({ kind: "text", prompt, opts }),
    /** Запрос с картинкой (обложка) → { text, model, latencyMs, via, finishReason } */
    vision: (imageBase64, mimeType, prompt, opts = {}) =>
      run({ kind: "vision", prompt, image: { base64: imageBase64, mimeType }, opts }),
    /** → то же + { data, attempts }; кидает LlmJsonError, если пригодный JSON так и не пришёл */
    chatJson: (prompt, opts = {}) => completeJson({ kind: "text", prompt, opts }),
    visionJson: (imageBase64, mimeType, prompt, opts = {}) =>
      completeJson({ kind: "vision", prompt, image: { base64: imageBase64, mimeType }, opts }),
  };
}

// --- Экземпляр по умолчанию, из env (создаётся при первом обращении) ---

let defaultLlm = null;

export function getDefaultLlm() {
  defaultLlm ??= createLlm({
    provider: config.LLM_PROVIDER,
    baseURL: config.LLM_BASE_URL,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
    visionModel: config.LLM_VISION_MODEL,
    timeoutMs: config.LLM_TIMEOUT_MS,
    jsonMode: config.LLM_JSON_MODE,
    debug: config.LLM_DEBUG,
  });
  return defaultLlm;
}

export const setDirectFallback = (fns) => getDefaultLlm().setDirectFallback(fns);
export const chat = (...args) => getDefaultLlm().chat(...args);
export const vision = (...args) => getDefaultLlm().vision(...args);
export const chatJson = (...args) => getDefaultLlm().chatJson(...args);
export const visionJson = (...args) => getDefaultLlm().visionJson(...args);
