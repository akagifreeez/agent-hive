import { OpenAIModel, setModelSleep } from "../src/model/openai.js";
setModelSleep((ms) => Promise.resolve());
const encoder = new TextEncoder();
let sent = 0;
const chunks = ['data: {"choices":[{"delta":{"content":"par"}}]}\n\n'];
globalThis.fetch = async () => ({
  ok: true, status: 200, headers: { get: () => null },
  body: { getReader: () => ({ read: async () => {
    if (sent < chunks.length) return { done: false, value: encoder.encode(chunks[sent++]) };
    throw Object.assign(new TypeError("terminated"), { code: undefined });
  } }) },
});
const m = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m", timeoutMs: 1000 });
const r = await m.chat({ messages: [{ role: "user", content: "hi" }], onDelta: () => {} });
console.log("OK content=", r.content);
process.exit(0);
