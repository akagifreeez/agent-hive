// fetch中断(long-run-resilience)の検証: ストリーム途中切断をアダプタのリトライ契約へ
// 正規化し、リトライし切ったら行動化エラーを返す(プロセスは落とさない)。
// 受け入れ基準: 切断ダミー応答でリトライ/行動化エラーを返すこと(テスト固定)・依存ゼロ。
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIModel, setModelSleep, RETRY_MAX_RETRIES, isStreamAbortError, translateStreamAbortError } from "../src/model/openai.js";

const MODEL = () => new OpenAIModel({ baseUrl: "http://mock.local", apiKey: "test-key", model: "mock", maxTokens: 16 });

/** 途中で読み出しが壊れるSSEレスポンス(切断ダミー)。n回目のreadでrejectする */
function brokenSseResponse(failAtRead, err) {
  const enc = new TextEncoder();
  let reads = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          reads++;
          if (reads >= failAtRead) throw err;
          return { done: false, value: enc.encode('data: {"choices":[{"delta":{"content":"先頭断片"}}]}\n\n') };
        },
      }),
    },
  };
}

test("isStreamAbortError: undici中断系(TypeError: terminated/fetch failed+cause/AbortError)を正規化判定", () => {
  assert.equal(isStreamAbortError(new TypeError("terminated")), true, "Fetch.onAbortedの実形");
  const e = new TypeError("fetch failed");
  e.cause = new Error("connect ECONNRESET 1.2.3.4:443");
  assert.equal(isStreamAbortError(e), true, "cause連鎖のECONNRESET");
  const ab = new Error("This operation was aborted");
  ab.name = "AbortError";
  assert.equal(isStreamAbortError(ab), true);
  assert.equal(isStreamAbortError(new Error("other side closed")), true, "premature close系");
  assert.equal(isStreamAbortError(new Error("APIキーが拒否されました(401)")), false, "非中断系は誤検出しない");
});

/** 通常のJSON応答(リトライ後の正常系ダミー) */
function okJsonResponse(content = "復帰") {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content, tool_calls: [] } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
  };
}

test("ストリーム途中切断ダミー: 未達リトライなら成功へ復帰する(リトライ契約に乗る)", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  setModelSleep(() => Promise.resolve()); // バックオフ待ちを即時化(テスト速度)
  const termin = new TypeError("terminated");
  globalThis.fetch = async (url, opts) => {
    calls.push(1);
    if (calls.length === 1) return brokenSseResponse(2, termin); // 1チャンク読んだ後に切断
    return okJsonResponse("復帰");
  };
  try {
    const deltas = [];
    const r = await MODEL().chat({ messages: [{ role: "user", content: "hi" }], onDelta: (d) => deltas.push(d) });
    assert.equal(calls.length, 2, "切断後に1回リトライして計2呼出");
    assert.equal(r.content, "復帰", "リトライで正常応答へ復帰する");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("ストリーム途中切断ダミー: リトライし切ったら行動化エラー(プロセスは落ちない)", async () => {
  const termin = new TypeError("terminated");
  const origFetch = globalThis.fetch;
  setModelSleep(() => Promise.resolve());
  let calls = 0;
  globalThis.fetch = async () => { calls++; return brokenSseResponse(1, termin); };
  try {
    await assert.rejects(
      () => MODEL().chat({ messages: [{ role: "user", content: "hi" }], onDelta: null }),
      (err) => {
        assert.match(err.message, /ストリームが切断されました/, "行動化できる文面へ正規化される");
        assert.match(err.message, /リトライ10回/, "リトライし切ったことが分かる");
        assert.match(err.message, /terminated/, "原因も保持する");
        return true;
      },
    );
    assert.equal(calls, RETRY_MAX_RETRIES + 1, "初回+最大リトライ数まで試す");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("行動化エラー文面: translateStreamAbortErrorは次の行動を示す", () => {
  const msg = translateStreamAbortError(new TypeError("terminated"));
  assert.match(msg, /ネットワーク瞬断/);
  assert.match(msg, /次の行動を決めてください/);
  assert.match(msg, /terminated/);
});
