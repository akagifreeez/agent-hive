// consumeStream内で例外が正しく出るか。2回目のreadでnullをthrowすると?
async function t(abortErr) {
  const encoder = new TextEncoder();
  let sent = 0;
  const chunks = ['data: {"choices":[{"delta":{"content":"tial"}}]}\n\n', "data: [DONE]\n\n"];
  const res = { ok: true, status: 200, headers: { get: () => null },
    body: { getReader: () => ({ read: async () => {
      if (sent < chunks.length) return { done: false, value: encoder.encode(chunks[sent++]) };
      throw abortErr;
    } }) } };
  const { consumeStreamForTest } = await import("../src/model/openai.js").catch(() => ({}));
  return { res };
}
const { res } = await t(null);
// readがnullをthrowしたら for-await ではどう観測される?
try {
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    console.log("chunk", value.length);
  }
  console.log("normal EOF");
} catch (e) {
  console.log("THROWN:", JSON.stringify(e?.message), e?.constructor?.name);
}
process.exit(0);
