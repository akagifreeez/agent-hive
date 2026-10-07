// 仮説検証: readChunkWithIdleTimeoutのPromise.raceで、2回目呼び出しのtimeoutが前のレースに影響?
// 実際の consumeStream + readChunkWithIdleTimeout の組み合わせを最小再現
const streamIdleTimeoutMs = () => 10_000;
function readChunkWithIdleTimeout(reader) {
  const idle = streamIdleTimeoutMs();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("stall")), idle);
  });
  const readP = reader.read();
  readP.finally(() => clearTimeout(timer));
  return Promise.race([readP, timeout]);
}
async function consumeStream(res) {
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await readChunkWithIdleTimeout(reader);
      if (done) break;
      console.log("chunk", value?.length);
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  return "done";
}
const encoder = new TextEncoder();
let sent = 0;
const chunks = ['data: a\n\n', "data: [DONE]\n\n"];
const res = { body: { getReader: () => ({ read: async () => {
  if (sent < chunks.length) return { done: false, value: encoder.encode(chunks[sent++]) };
  throw null; // ← テストがthrowするのはnull
} }) } };
try {
  const r = await consumeStream(res);
  console.log("RESULT", r);
} catch (e) {
  console.log("THROWN:", JSON.stringify(e?.message ?? e));
}
process.exit(0);
