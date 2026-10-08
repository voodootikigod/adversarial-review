// Local HTTP stub for the API providers (T50 item 6).
//
// One node:http server on 127.0.0.1:<random port>. Each provider has its own
// path prefix and FIFO reply queue:
//   anthropic  /anthropic/v1  POST /v1/messages
//   openai     /openai/v1     POST /v1/chat/completions
//   gateway    /gateway/v1    POST /v1/chat/completions
//   gemini     /gemini        POST /v1beta/models/<model>:generateContent
// (the exact URLs llmCall in src/llm.js builds from <PROVIDER>_BASE_URL).
// Every request is recorded { provider, path (relative to the prefix), body
// (parsed JSON, or the raw string), rawBody }.
//
// A request with an empty queue, a request under no provider prefix, or a
// request to a path the client never builds is answered 418
// `parity-stub: unexpected request` and recorded in stub.unexpected. 418 is
// NOT retryable in llmCall (only 429 and >=500 are, 3 attempts with 1 s/2 s
// backoff), so an unexpected request costs exactly one request; a row that
// exercises a 5xx must queue every retried reply explicitly.
import http from "node:http";
import { countAssertion } from "./rows.mjs";

export const PROVIDERS = Object.freeze({
  anthropic: { prefix: "/anthropic", base: "/anthropic/v1", envBase: "ANTHROPIC_BASE_URL", envKey: "ANTHROPIC_API_KEY", route: (p) => p === "/v1/messages" },
  openai: { prefix: "/openai", base: "/openai/v1", envBase: "OPENAI_BASE_URL", envKey: "OPENAI_API_KEY", route: (p) => p === "/v1/chat/completions" },
  gateway: { prefix: "/gateway", base: "/gateway/v1", envBase: "AI_GATEWAY_BASE_URL", envKey: "AI_GATEWAY_API_KEY", route: (p) => p === "/v1/chat/completions" },
  gemini: { prefix: "/gemini", base: "/gemini", envBase: "GEMINI_BASE_URL", envKey: "GEMINI_API_KEY", route: (p) => /^\/v1beta\/models\/[^/]+:generateContent$/.test(p) }
});

const UNEXPECTED = "parity-stub: unexpected request";

export function anthropicReply(resultObj) {
  return {
    status: 200,
    body: {
      id: "msg_parity",
      type: "message",
      role: "assistant",
      model: "parity-model",
      content: [{ type: "tool_use", id: "toolu_parity", name: "submit_review", input: resultObj }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 }
    }
  };
}

export function openaiReply(resultObj) {
  return {
    status: 200,
    body: {
      id: "chatcmpl-parity",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(resultObj) }, finish_reason: "stop" }]
    }
  };
}

export function geminiReply(resultObj) {
  return {
    status: 200,
    body: { candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(resultObj) }] }, finishReason: "STOP" }] }
  };
}

export function rawReply(status, text) {
  return { status, raw: String(text) };
}

function matchProvider(url) {
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (url === p.prefix || url.startsWith(p.prefix + "/")) return { name, rel: url.slice(p.prefix.length) || "/" };
  }
  return null;
}

export async function createStub() {
  const queues = Object.fromEntries(Object.keys(PROVIDERS).map((k) => [k, []]));
  const requests = [];
  const unexpected = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body = rawBody;
      try { body = JSON.parse(rawBody); } catch { /* keep raw */ }
      const url = (req.url || "/").split("?")[0];
      const m = matchProvider(url);
      const reject = (provider, p) => {
        unexpected.push({ provider, path: p, method: req.method, body, rawBody });
        res.writeHead(418, { "content-type": "text/plain" });
        res.end(UNEXPECTED);
      };
      if (!m || req.method !== "POST" || !PROVIDERS[m.name].route(m.rel)) {
        return reject(m ? m.name : null, url);
      }
      const reply = queues[m.name].shift();
      if (!reply) return reject(m.name, url);
      requests.push({ provider: m.name, path: m.rel, body, rawBody });
      if (reply.raw !== undefined) {
        res.writeHead(reply.status, { "content-type": "text/plain" });
        res.end(reply.raw);
      } else {
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  return {
    port,
    requests,
    unexpected,
    base(provider) {
      const p = PROVIDERS[provider];
      if (!p) throw new Error(`unknown stub provider ${provider}`);
      return `http://127.0.0.1:${port}${p.base}`;
    },
    enqueue(provider, ...replies) {
      if (!queues[provider]) throw new Error(`unknown stub provider ${provider}`);
      queues[provider].push(...replies);
    },
    pending(provider) {
      return queues[provider].length;
    },
    assertNoUnexpected() {
      countAssertion();
      if (unexpected.length) {
        throw new Error(`stub received ${unexpected.length} unexpected request(s): ` +
          unexpected.map((u) => `${u.method} ${u.path}`).join(", "));
      }
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    }
  };
}

export function providerEnv(stub, provider) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown stub provider ${provider}`);
  return { [p.envBase]: stub.base(provider), [p.envKey]: "dummy" };
}
