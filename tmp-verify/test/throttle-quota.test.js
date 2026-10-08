// クォータ窓の検知と共有待ち(G3・dsh-vs-hive比較doc):
// GLMの5時間上限はレート制限ヘッダを出さず(2026-10-06実測)、429本文に
// 「reset at HH:MM:SS」で返る。これを読んで、アダプタは短いリトライを打ち切り、
// throttleが同プロバイダ全エージェントをリセット時刻まで待たせる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIModel, parseQuotaResetMs, setModelSleep } from "../src/model/openai.js";
import {
  noteProviderRateLimited,
  gateProvider,
  providerRateLimits,
  resetProviderThrottleForTest,
  THROTTLE_QUOTA_MAX_MS,
} from "../src/model/throttle.js";

const GLM_BODY = '{"error":{"code":1308,"message":"Usage limit reached for 5 hour. reset at 19:11:09"}}';

function quotaResponse() {
  return { ok: false, status: 429, headers: { get: () => null }, text: async () => GLM_BODY };
}
function okResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  };
}
function plain429() {
  return { ok: false, status: 429, headers: { get: () => null }, text: async () => "rate limited" };
}

test("quota: GLM本文のreset at時刻をローカル時刻として読む", () => {
  const now = new Date(2026, 9, 6, 10, 0, 0).getTime();
  assert.equal(parseQuotaResetMs(GLM_BODY, now), new Date(2026, 9, 6, 19, 11, 9).getTime());
});

test("quota: 時刻が過ぎていれば翌日の同時刻として読む", () => {
  const now = new Date(2026, 9, 6, 20, 0, 0).getTime();
  assert.equal(parseQuotaResetMs(GLM_BODY, now), new Date(2026, 9, 7, 19, 11, 9).getTime());
});

test("quota: 該当文の無い本文はnull", () => {
  assert.equal(parseQuotaResetMs("rate limited"), null);
  assert.equal(parseQuotaResetMs(""), null);
  assert.equal(parseQuotaResetMs(null), null);
});

test("quota: throttleはクォータ窓まで全エージェントを待たせる(5分上限を超える待ち)", async () => {
  resetProviderThrottleForTest();
  const sleeps = [];
  setModelSleep(async (ms) => sleeps.push(ms));
  try {
    const now = Date.now();
    const e = noteProviderRateLimited("http://q1", undefined, { quotaUntilMs: now + 60_000 });
    assert.ok(e.until >= now + 59_000 && e.until <= now + 61_000, `untilはリセット時刻: ${e.until - now}`);
    assert.equal(e.quotaUntil, e.until);
    await gateProvider("http://q1", { jitter: false });
    assert.ok(sleeps.at(-1) > 0 && sleeps.at(-1) <= 60_000, `リセット明けまで待つ: ${sleeps.at(-1)}`);
  } finally {
    setModelSleep((ms) => new Promise((r) => setTimeout(r, ms)));
    resetProviderThrottleForTest();
  }
});

test("quota: 大値のクォータ窓は6時間で刈る。短いRetry-Afterで短縮もされない", () => {
  resetProviderThrottleForTest();
  const now = Date.now();
  const big = noteProviderRateLimited("http://q2", undefined, { quotaUntilMs: now + 100 * 3_600_000 });
  assert.ok(big.until - now <= THROTTLE_QUOTA_MAX_MS + 1000, "上限(6時間)で刈る");
  const shorter = noteProviderRateLimited("http://q2", 1_000);
  assert.equal(shorter.until, big.until, "単調延長のみで短縮しない");
  resetProviderThrottleForTest();
});

test("quota: アダプタはクォータ窓の429で即打ち切りし(リトライせず)、throttleへ窓を記録する", async () => {
  resetProviderThrottleForTest();
  const origFetch = globalThis.fetch;
  const sleeps = [];
  setModelSleep(async (ms) => sleeps.push(ms));
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return quotaResponse();
  };
  try {
    const model = new OpenAIModel({ baseUrl: "http://glm-q", apiKey: "k", model: "m", timeoutMs: 1000 });
    await assert.rejects(
      () => model.chat({ messages: [{ role: "user", content: "hi" }] }),
      /クォータ上限/,
    );
    assert.equal(calls, 1, "リトライで再試行しない(10回回しても窓は明けない)");
    assert.equal(sleeps.length, 0, "待ちの代わりに即打ち切りする");
    const entry = providerRateLimits().get("http://glm-q");
    assert.ok(entry?.quotaUntil, "throttleへクォータ窓が記録されている");
    assert.ok(entry.until > Date.now() + 5 * 60_000, "5分上限を超える窓になっている");
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r) => setTimeout(r, ms)));
    resetProviderThrottleForTest();
  }
});

test("quota: reset atを持たない普通の429は従来どおりリトライする(回帰確認)", async () => {
  resetProviderThrottleForTest();
  const origFetch = globalThis.fetch;
  const sleeps = [];
  setModelSleep(async (ms) => sleeps.push(ms));
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls <= 2 ? plain429() : okResponse();
  };
  try {
    const model = new OpenAIModel({ baseUrl: "http://plain-429", apiKey: "k", model: "m", timeoutMs: 1000 });
    const r = await model.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.content, "ok");
    assert.equal(calls, 3, "2回の429を挟んで3発目で成功");
    assert.ok(sleeps.length >= 2, "リトライの待ちが発生している");
    assert.equal(providerRateLimits().get("http://plain-429")?.quotaUntil ?? null, null, "クォータ窓は立たない");
  } finally {
    globalThis.fetch = origFetch;
    setModelSleep((ms) => new Promise((r) => setTimeout(r, ms)));
    resetProviderThrottleForTest();
  }
});
