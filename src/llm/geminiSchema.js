// The Gemini responseSchemas in bookExtraction.js are the single source of
// truth for each response shape. These derive what the router path needs
// from them, so the direct and router paths can't drift apart.

// Gemini schema -> standard JSON Schema (for response_format json_schema).
// FreeLLMAPI turns it back into a Gemini responseSchema for Gemini models
// and passes or downgrades it for other providers.
export function toJsonSchema(schema) {
  const type = schema.type.toLowerCase();
  const out = { type: schema.nullable ? [type, "null"] : type };
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toJsonSchema(value)]));
  }
  if (schema.items) out.items = toJsonSchema(schema.items);
  if (schema.required) out.required = schema.required;
  return out;
}

// Gemini schema -> compact shape for a system prompt, e.g.
// {"title": string, "author": string|null, "evidence": string[]}
export function describeShape(schema) {
  if (schema.type === "OBJECT") {
    return `{${Object.entries(schema.properties)
      .map(([key, value]) => `"${key}": ${describeShape(value)}`)
      .join(", ")}}`;
  }
  if (schema.type === "ARRAY") {
    const inner = describeShape(schema.items);
    return schema.items.type === "OBJECT" ? `[${inner}]` : `${inner}[]`;
  }
  return `${schema.type.toLowerCase()}${schema.nullable ? "|null" : ""}`;
}
