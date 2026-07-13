// Node 18+ ships a global fetch, so no fetch import/dependency is needed here.
// Wraps fetch with an AbortController so a hanging upstream (Gemini, Google
// Books, Telegram file download) can't stall a request indefinitely -
// previously only the Kindle-send path had any timeout at all.
export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
