// リトライループの原因を特定: 1回目terminated→リトライ→2回目OKのはずが「途切れました:null」
// 仮説: finallyのreader.cancel()が例外を投げる? それともretryのcontinue後に古いres/readChunkが残る?
import { OpenAIModel, setModelSleep } from "../src/model/openai.js";
setModelSleep((ms) => Promise.resolve());
const encoder = new TextEncoder();
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  const n = calls;
  const chunks = n === 1
    ? ['data: {"choices":[{"delta":{"content":"par"}}]}\n\n']
    : ['data: {"choices":[{"delta":{"content":"tial"}}]}\n\n', "data: [DONE]\n\n"];
  let sent = 0;
  const err = n === 1 ? Object.assign(new TypeError("terminated"), { code: undefined }) : null;
  return {
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader: () => ({ read: async () => {
      if (sent < chunks.length) return { done: false, value: encoder.encode(chunks[sent++]) };
      throw err;
    } }) },
  };
};
const m = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m", timeoutMs: 1000 });
try {
  const r = await m.chat({ messages: [{ role: "user", content: "hi" }], onDelta: () => {} });
  console.log("OK calls=", calls, "content=", r.content);
} catch (e) {
  console.log("CAUGHT calls=", calls, "msg=", e.message);
}
process.exit(0);
