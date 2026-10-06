// Owner-facing summary of the LLM steps behind one search: which path
// answered (via), the model the router picked, latency, and the retries or
// fallbacks taken when an answer was unusable.
export function formatLlmSteps(steps, { withText = false } = {}) {
  const lines = ["LLM DEBUG"];

  for (const s of steps || []) {
    const attempts = s.attempts || [];
    attempts.forEach((a, i) => {
      const label = attempts.length > 1 ? `${s.step} #${i + 1}` : s.step;
      let line = `${label}: via=${a.via} model=${a.model} ${a.latencyMs}ms finish=${a.finishReason ?? "-"}`;
      if (a.note) line += ` [${a.note}]`;
      if (a.fallbackReason) line += `\n  fallback: ${a.fallbackReason}`;
      if (a.error) line += `\n  ✗ ${a.error}`;
      lines.push(line);
    });
    if (s.error) lines.push(`${s.step}: ✗ ${s.error}`);
    if (withText && s.text) lines.push("", `${s.step} response:`, s.text.slice(0, 2000));
  }

  return lines.join("\n");
}
