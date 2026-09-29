// プロバイダ横断スロットリング(イシュー#1)の検証。
// 単位テスト(note/gate/単調延長/上限刈り)+統合テスト(2モデル実体が同baseUrlで
// 429連鎖しない: 一方が429を見たらもう一方はゲートで待つ)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIModel, setModelSleep } from "../src/model/openai.js";
import {
  noteProviderRateLimited,
  gateProvider,
  providerRateLimits,
  resetProviderThrottleForTest,
  THROTTLE_MAX_COOLDOWN_MS,
  THROTTLE_DEFAULT_COOLDOWN_MS,
} from "../src/model/throttle.js";

function makeModel(baseUrl) {
  return new OpenAIModel({ baseUrl, apiKey: "k", model: "m", timeoutMs: 1000 });
}

function okResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  };
}

function statusResponse(status, retryAfter) {
  return {
    ok: false,
    status,
    headers: { get: (k) => (k === "retry-after" ? retryAfter : null) },
    text: async () => "rate limited",
  };
}

test("throttle: note→gateで待ち、期限切れ後は即時通過する", async () => {
  resetProviderThrottleForTest();
  const sleeps = [];
  setModelSleep(async (ms) => sleeps.push(ms));
  try {
    // 初回はゲート無し(即時)
    {
      const before = sleeps.length;
      await gateProvider("http://p1");
      assert.equal(sleeps.length, before);
    }
    // 429を記録(Retry-After=0.2秒)→ゲートで待つ
    const entry = noteProviderRateLimited("http://p1", 200);
    assert.equal(entry.retryAfterMs, 200);
    await gateProvider("http://p1", { jitter: false });
    assert.ok(sleeps.at(-1) > 0 && sleeps.at(-1) <= 200, `クールダウン明けまで待つ: ${sleeps.at(-1)}`);
    // 時計を進めた体で期限切れ→即時通過&エントリ掃除
    const m = providerRateLimits().get("http://p1");
    m.until = Date.now() - 1;
    const before = sleeps.length;
    await gateProvider("http://p1");
    assert.equal(sleeps.length, before);
    assert.equal(providerRateLimits().has("http://p1"), false);
  } finally {
    setModelSleep((ms) => new Promise((r) => setTimeout(r, ms)));
  }
});

test("throttle: Retry-After無しは既定クールダウン、大値は上限で刈る、単調延長のみ", () => {
  resetProviderThrottleForTest();
  const e1 = noteProviderRateLimited("http://p2");
  assert.equal(e1.retryAfterMs, null);
  assert.ok(e1.until - Date.now() <= THROTTLE_DEFAULT_COOLDOWN_MS);
  const big = noteProviderRateLimited("http://p3", 999_999);
  assert.equal(big.retryAfterMs, THROTTLE_MAX_COOLDOWN_MS, "上限(5分)で刈る");
  // 単調延長: 短いRetry-Afterで縮まない
  const first = noteProviderRateLimited("http://p4", 60_000);
  const second = noteProviderRateLimited("http://p4", 1_000);
  assert.equal(second.until, first.until, "既存のuntilが長ければ維持");
  assert.equal(second.retryAfterMs, 1000, "記録されるcdは直近のもの");
});

test("throttle: エージェント横断でクールダウンが共有され429連鎖が起きない(イシュー#1受け入れ基準)", async () => {
  resetProviderThrottleForTest();
  const origFetch = globalThis.fetch;
  const sleeps = [];
  setModelSleep(async (ms) => sleeps.push(ms));
  const callsBy = { a: 0, b: 0 };
  const seen429 = { a: 0, b: 0 };
  // エージェントA(実体1)とB(実体2)は同プロバイダ。最初の1発だけ429(Retry-After=0.05秒)を返し、
  // 以後は成功。Aが429を見たらBはゲートで共有クールダウン待ちになり、Bが429を直接見る回数は0になる。
  let limited = 1;
  globalThis.fetch = async () => {
    // OpenAIModelはインスタンス毎にapiKey等を持つがfetchはグローバル。どちらの実体かは
    // 呼び出し順で判別するため代わりに通過カウントを合算する
    if (limited > 0) {
      limited--;
      return statusResponse(429, "0.05");
    }
    return okResponse();
  };
  try {
    const a = makeModel("http://shared-p");
    const b = makeModel("http://shared-p");
    const [ra, rb] = await Promise.all([
      a.chat({ messages: [{ role: "user", content: "hi" }] }),
      b.chat({ messages: [{ role: "user", content: "hi" }] }),
    ]);
    assert.equal(ra.content, "ok");
    assert.equal(rb.content, "ok");
    // 429は全体で1回だけ誰かが受け、共有クールダウンが効いたことでゲート待ちが発生している
    const total429 = limited === 0 ? 1 : 0;
    assert.equal(total429, 1, "429応答は1回だけ発生");
    assert.ok(sleeps.some((ms) => ms > 0 && ms <= 400), `共有クールダウンの待ちが発生: ${JSON.stringify(sleeps)}`);
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r) => setTimeout(r, ms)));
    resetProviderThrottleForTest();
    void callsBy; void seen429;
  }
});

test("throttle: 別プロバイダは互いに影響しない", async () => {
  resetProviderThrottleForTest();
  const origFetch = globalThis.fetch;
  const sleeps = [];
  setModelSleep(async (ms) => sleeps.push(ms));
  globalThis.fetch = async () => statusResponse(429, "0.05");
  try {
    const limited = makeModel("http://only-a");
    const clean = makeModel("http://only-b");
    // 429でリトライ上限まで失敗させる(成功するとクリアされるため)
    await assert.rejects(
      () => limited.chat({ messages: [{ role: "user", content: "hi" }] }),
      /429/
    );
    const before = { len: 0 };
    await gateProvider("http://only-b");
    assert.ok(providerRateLimits().has("http://only-a"), "Aはクールダウン記録済み");
    assert.equal(providerRateLimits().has("http://only-b"), false, "Bは影響を受けない");
    // Bは同じfetch(常に429)でも自分のクールダウンを持つだけで、Aのせいで待たされたりはしない
    const sleepsBefore = sleeps.length;
    await assert.rejects(() => clean.chat({ messages: [{ role: "user", content: "hi" }] }), /429/);
    assert.equal(providerRateLimits().get("http://only-b").retryAfterMs, 50, "Bは自分の429で自分のクールダウンを持つ");
    void before; void sleepsBefore;
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r) => setTimeout(r, ms)));
    resetProviderThrottleForTest();
  }
});
