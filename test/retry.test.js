// v6.2: モデルAPIリトライ(ZCode retry-policy/failure-classifierの移植)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAIModel,
  computeRetryDelay,
  isRetryableStatus,
  setModelSleep,
  RETRY_MAX_RETRIES,
} from "../src/model/openai.js";

function makeModel() {
  return new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m", timeoutMs: 1000 });
}

test("computeRetryDelay: 指数バックオフ+60秒キャップ+jitter、Retry-After優先(ZCode準拠)", () => {
  // jitter無しで純粋な遅延列を確認: 2s→4s→…→60sキャップ
  assert.equal(computeRetryDelay(1, undefined, false), 2000);
  assert.equal(computeRetryDelay(2, undefined, false), 4000);
  assert.equal(computeRetryDelay(5, undefined, false), 32000);
  assert.equal(computeRetryDelay(6, undefined, false), 60000); // 64sは60sにキャップ
  assert.equal(computeRetryDelay(10, undefined, false), 60000);
  // Retry-Afterは5分以内なら優先
  assert.equal(computeRetryDelay(1, 30000, false), 30000);
  assert.equal(computeRetryDelay(3, 0, false), 0);
  // 5分超かつ指数遅延より長い場合は採用せずバックオフに落ちる
  assert.equal(computeRetryDelay(1, 600000, false), 2000);
  // jitterありは範囲内(50〜100%)
  const d = computeRetryDelay(2);
  assert.ok(d >= 2000 && d <= 4000, `jitter範囲内: ${d}`);
});

test("isRetryableStatus: 429/529/5xxは可、401/403/400/422は不可(ZCode準拠)", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(529), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(502), true);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(422), false);
  assert.equal(isRetryableStatus(404), false);
});

test("chat: 429をRetry-After付きで受けたらリトライして成功する", async () => {
  const origFetch = globalThis.fetch;
  const sleeps = [];
  setModelSleep(async (ms) => sleeps.push(ms));
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls <= 2) {
      return { ok: false, status: 429, headers: { get: (k) => (k === "retry-after" ? "0" : null) }, text: async () => "rate limited" };
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    };
  };
  try {
    const r = await makeModel().chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.content, "ok");
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [0, 0]); // Retry-After: 0 が優先される
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r2) => setTimeout(r2, ms)));
  }
});

test("chat: 401はリトライせず即座に失敗する", async () => {
  const origFetch = globalThis.fetch;
  const sleeps = [];
  setModelSleep(async (ms) => sleeps.push(ms));
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 401, headers: { get: () => null }, text: async () => "bad key" };
  };
  try {
    await assert.rejects(
      () => makeModel().chat({ messages: [{ role: "user", content: "hi" }] }),
      /401/
    );
    assert.equal(calls, 1); // 認証系は1回きり
    assert.equal(sleeps.length, 0);
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r2) => setTimeout(r2, ms)));
  }
});

test("chat: リトライ上限に達したら失敗する(最大リトライ+1回)", async () => {
  const origFetch = globalThis.fetch;
  const sleeps = [];
  setModelSleep(async (ms) => sleeps.push(ms)); // 待ち時間を実質ゼロに
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 503, headers: { get: () => null }, text: async () => "down" };
  };
  try {
    await assert.rejects(() => makeModel().chat({ messages: [{ role: "user", content: "hi" }] }), /503/);
    assert.equal(calls, RETRY_MAX_RETRIES + 1);
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r2) => setTimeout(r2, ms)));
  }
});

test("chat: 空応答(テキストもツールもusageも無し)は1回だけリトライする", async () => {
  const origFetch = globalThis.fetch;
  setModelSleep(async () => {});
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ choices: [{ message: { content: null } }] }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "返事" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  try {
    const r = await makeModel().chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.content, "返事");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r2) => setTimeout(r2, ms)));
  }
});
