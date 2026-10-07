import { OpenAIModel, setModelSleep, RETRY_MAX_RETRIES } from "./src/model/openai.js";
function brokenSseResponse(failAtRead, err) {
  const enc = new TextEncoder();
  let reads = 0;
  return {
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader: () => ({ read: async () => { reads++; if (reads >= failAtRead) throw err; return { done: false, value: enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n') }; } }) },
  };
}
setModelSleep(() => Promise.resolve());
const termin = new TypeError("terminated");
let calls = 0;
globalThis.fetch = async () => { calls++; console.log("call", calls); return brokenSseResponse(1, termin); };
const model = new OpenAIModel({ baseUrl: "http://mock.local", apiKey: "k", model: "m", maxTokens: 16 });
try {
  const r = await model.chat({ messages: [{ role: "user", content: "hi" }], onDelta: null });
  console.log("unexpected OK", r.content);
} catch (e) {
  console.log("ERR:", e.message.slice(0, 120));
}
console.log("calls:", calls);
process.exit(0);
