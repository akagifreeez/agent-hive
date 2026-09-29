// createModelFactory: アダプタdispatch・agent上書き・fallback・鍵/形式エラー・state概要
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModelFactory, modelStateInfo, resolveDefaultSpec } from "../src/model/factory.js";
import { OpenAIModel, FallbackModel, extractUsage } from "../src/model/openai.js";

// auth.valueで鍵を渡す(環境変数・ファイルに依存しない)
function mkCfg(over = {}) {
  return {
    models: {
      default: "prov/main-model",
      fallbacks: ["prov/backup-model"],
      providers: {
        prov: {
          id: "prov", baseUrl: "https://api.example/v4", api: "openai-completions",
          auth: { value: "test-key-123456" },
          params: { reasoningEffort: "low", webSearch: true },
          models: [
            { id: "main-model", name: "Main", contextWindow: 100000, maxTokens: 3000, cost: { input: 1, output: 2 } },
            { id: "backup-model" },
          ],
        },
      },
    },
    model: { model: "main-model" },
    ...over,
  };
}

test("createModelFactory: 既定モデルがアダプタへ正しく渡る", () => {
  const c = mkCfg();
  c.models.fallbacks = []; // フォールバック無し=素のアダプタ
  const m = createModelFactory(c)();
  assert.ok(m instanceof OpenAIModel);
  assert.equal(m.baseUrl, "https://api.example/v4");
  assert.equal(m.model, "main-model");
  assert.equal(m.maxTokens, 3000);
  assert.equal(m.reasoningEffort, "low");
  assert.equal(m.webSearch, true);
  assert.deepEqual(m.costRates, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
});

test("createModelFactory: fallbacksがあるとFallbackModelで包む", () => {
  const m = createModelFactory(mkCfg())();
  assert.ok(m instanceof FallbackModel);
  assert.ok(m.primary instanceof OpenAIModel);
});

test("createModelFactory: agent.modelのベアIDは既定プロバイダ補完・agent値が優先される", () => {
  // webSearch:false はnullishでないのでprovider params(true)より優先される(旧実装と同じ)
  const m = createModelFactory(mkCfg())({ model: "backup-model", reasoningEffort: "high", webSearch: false });
  assert.ok(m instanceof FallbackModel);
  assert.equal(m.primary.model, "backup-model");
  assert.equal(m.primary.reasoningEffort, "high");
  assert.equal(m.primary.webSearch, false);
});

test("createModelFactory: 未知のワイヤ形式はエラー", () => {
  const c = mkCfg();
  c.models.providers.prov.api = "some-unknown-api";
  assert.throws(() => createModelFactory(c)(), /未対応のワイヤ形式 "some-unknown-api"/);
});

test("createModelFactory: 鍵が無いプロバイダはエラーでプロバイダ名を出す", () => {
  const c = mkCfg();
  delete c.models.providers.prov.auth;
  assert.throws(() => createModelFactory(c)(), /プロバイダ "prov" のAPIキーが未設定/);
});

test("modelStateInfo: ref/providersを返し、生の鍵は含まない", () => {
  const info = modelStateInfo(mkCfg());
  assert.equal(info.name, "Main");
  assert.equal(info.ref, "prov/main-model");
  assert.deepEqual(info.fallbacks, ["prov/backup-model"]);
  // 内蔵カタログ(zai)が常に入るので設定のprovを検索して検証する
  const prov = info.providers.find((p) => p.id === "prov");
  assert.ok(prov);
  assert.equal(prov.auth, "value");
  assert.deepEqual(prov.models, ["main-model", "backup-model"]);
  assert.ok(!JSON.stringify(info).includes("test-key-123456"), "生の鍵をstateに載せない");
});

test("resolveDefaultSpec: 既定モデルのSpecを返し、壊れた設定ではnull", () => {
  assert.equal(resolveDefaultSpec(mkCfg()).model.id, "main-model");
  assert.equal(resolveDefaultSpec({ models: { default: "nope/m", providers: {} } }), null);
  assert.equal(resolveDefaultSpec({}), null);
});

test("extractUsage: カタログ単価での概算はusage.costが無い場合のみ", () => {
  const r = extractUsage({ prompt_tokens: 1000, completion_tokens: 500 }, { input: 1, output: 2 });
  assert.equal(r.costUsd, (1000 * 1 + 500 * 2) / 1e6);
  assert.equal(extractUsage({ prompt_tokens: 1000, completion_tokens: 500, cost: 0.009 }, { input: 1, output: 2 }).costUsd, 0.009, "実費があれば優先");
  assert.equal(extractUsage({ prompt_tokens: 10 }, null).costUsd, 0, "単価が無ければ0のまま");
});
