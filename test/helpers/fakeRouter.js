import http from "node:http";

// A local stand-in for FreeLLMAPI: records every request body and answers
// with whatever the test's handler returns.
export async function startRouter(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    // `html` serves a non-API page, like FreeLLMAPI's dashboard outside /v1.
    const { status = 200, json = {}, html, headers = {} } = await handler(body, requests.length);
    res.writeHead(status, { "content-type": html !== undefined ? "text/html; charset=utf-8" : "application/json", ...headers });
    res.end(html !== undefined ? html : JSON.stringify(json));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    // closeAllConnections: the OpenAI SDK keeps connections alive, and a
    // plain close() would wait for them to time out.
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

export const completion = (content, routedVia = "google/gemini-3.5-flash") => ({
  headers: { "x-routed-via": routedVia },
  json: {
    id: "x",
    object: "chat.completion",
    created: 0,
    model: "auto",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  },
});

export const failure = (status, message = "upstream failed") => ({ status, json: { error: { message } } });

export const silentLogger = { warn() {}, log() {} };
