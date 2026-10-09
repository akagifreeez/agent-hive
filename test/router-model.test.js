// ターン毎モデルルーティング(RouterModel)の回帰・結合テスト。
// 検証はすべて実行を伴わないダミーモデルで行う(既存方針: assistant-history.test.jsと同じ)。
// カバー: (1)重い条件→strong / 通常→primary (2)config未設定=全てprimary(回帰)
// (3)FallbackModel併用: primary失敗→フォールバック (4)usage-trace/session-logへの判定根拠記録
// (5)/api/routing: GET現在値・POSTでhive.local.json永続化・config/localの実効状態
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { runAgentLoop } from "../src/engine/loop.js";
import { RouterModel } from "../src/model/router.js";
import { FallbackModel } from "../src/model/openai.js";
import { routingDecision, defaultRouterConfig, normalizeRoutingConfig } from "../src/model/router-config.js";
import { startUi } from "../src/ui/server.js";
import { startUiTokenized, tokenedFetchOn } from "./helpers/hf-token.js";
tokenedFetchOn();

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");

function mkAgent(overrides = {}) {
  return { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA, ...overrides };
}

function mkModel(calls, script) {
  return {
    maxTokens: 4000,
    async chat(opts) {
      calls.push(opts);
      const i = calls.length - 1;
      return { content: script(i, opts), reasoning: null, toolCalls: [], raw: null, usage: { promptTokens: 1, completionTokens: 1 }, searches: null };
    },
  };
}

function cfgEnabled(over = {}) {
  return { ...defaultRouterConfig(), enabled: true, ...over };
}

// ---------- 単体: 判定と委譲 ----------

test("router: 重い条件(ロールreview)はstrongへ、通常はprimaryへ委譲する", async () => {
  const primCalls = [], strongCalls = [];
  const primary = mkModel(primCalls, () => "軽量応答");
  const strong = mkModel(strongCalls, () => "重量応答");
  const r = new RouterModel({ primary, strong, routing: cfgEnabled(), role: "impl" });
  const r1 = await r.chat({ messages: [{ role: "user", content: "軽い質問" }], tools: [] });
  assert.equal(primCalls.length, 1, "primaryへ委譲");
  assert.equal(strongCalls.length, 0);
  assert.equal(r1.router.selected, "flash");
  assert.equal(r1.router.reason, "default");
  const r2 = await r.chat({ messages: [{ role: "user", content: "検証してください" }], tools: [], role: "review" });
  assert.equal(strongCalls.length, 1, "reviewはstrongへ委譲");
  assert.equal(primCalls.length, 1);
  assert.equal(r2.router.selected, "5.3");
  assert.equal(r2.router.reason, "role");
});

test("router: config未設定(enabled=false)は全てprimaryへ(回帰: 現状どおり)", async () => {
  const primCalls = [], strongCalls = [];
  const primary = mkModel(primCalls, () => "応答");
  const strong = mkModel(strongCalls, () => "応答");
  const r = new RouterModel({ primary, strong, routing: defaultRouterConfig(), role: "review" });
  const res = await r.chat({ messages: [{ role: "user", content: "任意" }], tools: [] });
  assert.equal(primCalls.length, 1);
  assert.equal(strongCalls.length, 0);
  assert.equal(res.router.selected, "flash");
  assert.equal(res.router.reason, "disabled");
});

test("router: 重い文脈(実測promptTokens超過)と品質シグナル(空応答連続)でstrongへ", async () => {
  const primCalls = [], strongCalls = [];
  const primary = {
    maxTokens: 4000,
    async chat() {
      primCalls.push(1);
      return { content: "", toolCalls: [], usage: { promptTokens: 70000, completionTokens: 0 } };
    },
  };
  const strong = mkModel(strongCalls, () => "重量応答");
  const r = new RouterModel({ primary, strong, routing: cfgEnabled({ heavyPromptTokens: 60000, heavyQualityStrikes: 2 }), role: "impl" });
  await r.chat({ messages: [{ role: "user", content: "1" }], tools: [] });
  await r.chat({ messages: [{ role: "user", content: "2" }], tools: [] });
  assert.ok(strongCalls.length >= 1, "2回目は実測トークン超過でstrongへ");
  assert.equal(primCalls.length, 1);
  const r2 = new RouterModel({ primary, strong, routing: cfgEnabled({ heavyQualityStrikes: 2 }), role: "impl" });
  await r2.chat({ messages: [], tools: [] });
  await r2.chat({ messages: [], tools: [] });
  assert.ok(strongCalls.length >= 2, "空応答連続でstrongへ引き上げ");
});

test("router: 判定はLLM呼出を追加しない(委譲先への呼出数=呼出数)", async () => {
  const primCalls = [], strongCalls = [];
  const primary = mkModel(primCalls, () => "a");
  const strong = mkModel(strongCalls, () => "b");
  const r = new RouterModel({ primary, strong, routing: cfgEnabled(), role: "impl" });
  for (let i = 0; i < 3; i++) await r.chat({ messages: [{ role: "user", content: "x" }], tools: [] });
  assert.equal(primCalls.length + strongCalls.length, 3, "余分な呼出が発生しない");
});

test("routingDecision: 純関数の判定理由(1語)を返す", () => {
  const cfg = cfgEnabled();
  assert.deepEqual(routingDecision({ role: "review" }, { lastPromptTokens: 0, qualityStrikes: 0 }, cfg), { heavy: true, reason: "role" });
  assert.deepEqual(routingDecision({ messages: [] }, { lastPromptTokens: 70000, qualityStrikes: 0 }, cfg), { heavy: true, reason: "prompt" });
  assert.deepEqual(routingDecision({ messages: [] }, { lastPromptTokens: 0, qualityStrikes: 1 }, cfg), { heavy: true, reason: "quality" });
  assert.deepEqual(routingDecision({ messages: [] }, { lastPromptTokens: 0, qualityStrikes: 0 }, cfg), { heavy: false, reason: "default" });
  assert.deepEqual(routingDecision({ messages: [], tools: new Array(9) }, { lastPromptTokens: 0, qualityStrikes: 0 }, cfg), { heavy: true, reason: "tools" });
  assert.deepEqual(routingDecision({}, {}, defaultRouterConfig()), { heavy: false, reason: "disabled" });
});

test("normalizeRoutingConfig: 異常値は既定へ落とし、enabledは真偽のみ", () => {
  const n = normalizeRoutingConfig({ enabled: "yes", heavyPromptTokens: -5, roles: ["REVIEW", ""], heavyModel: "x/heavy" });
  assert.equal(n.enabled, false);
  assert.equal(n.heavyPromptTokens, defaultRouterConfig().heavyPromptTokens);
  assert.deepEqual(n.heavyRoles, ["review"]);
  assert.equal(n.heavyModelRef, "x/heavy");
  assert.deepEqual(normalizeRoutingConfig(undefined), defaultRouterConfig());
});

// ---------- FallbackModelとの共存 ----------

test("router+FallbackModel: 選択経路のprimary失敗→フォールバックが従来どおり働く", async () => {
  const fbCalls = [], strongCalls = [];
  const brokenPrimary = { maxTokens: 100, async chat() { throw new Error("primary落ちた"); } };
  const fallback = mkModel(fbCalls, () => "フォールバック応答");
  const withFallback = new FallbackModel({ primary: brokenPrimary, fallbacks: [fallback] });
  const strong = mkModel(strongCalls, () => "重量応答");
  const r = new RouterModel({ primary: withFallback, strong, routing: cfgEnabled(), role: "impl" });
  const res = await r.chat({ messages: [{ role: "user", content: "q" }], tools: [] });
  assert.equal(res.content, "フォールバック応答", "Router→Fallback→fallback実体へ届く");
  assert.equal(fbCalls.length, 1);
  assert.equal(strongCalls.length, 0);
  assert.equal(res.router.selected, "flash", "判定根拠はRouterの選択を維持");
  const res2 = await r.chat({ messages: [{ role: "user", content: "q" }], tools: [], role: "review" });
  assert.equal(res2.content, "重量応答");
  assert.equal(strongCalls.length, 1);
});

test("router: 全経路が絶望したらエラーを投げる(握りつぶさない)", async () => {
  const broken = { maxTokens: 1, async chat() { throw new Error("だめ"); } };
  const r = new RouterModel({ primary: broken, strong: broken, routing: cfgEnabled(), role: "impl" });
  await assert.rejects(() => r.chat({ messages: [], tools: [] }), /だめ/);
});

// ---------- 結合: loop経由の記録(usage-trace / session-log) ----------

function mkWsFixtures() {
  const ws = mkdtempSync(join(tmpdir(), "hive-router-loop-"));
  mkdirSync(join(ws, "agents"), { recursive: true });
  writeFileSync(join(ws, "agents", "alpha.md"), "あなたは実装です。ロール: impl\n");
  return ws;
}

test("router+loop: usage-traceとsession-logのレコードにrouter判定根拠が残る", async () => {
  const ws = mkWsFixtures();
  const bus = new Bus();
  const board = new Board(bus, "__main__", join(ws, "state", "board.jsonl"));
  const tasks = new TaskBlackboard(ws, bus);
  const primary = mkModel([], () => "通常応答です");
  const strong = mkModel([], () => "重量応答");
  const model = new RouterModel({ primary, strong, routing: cfgEnabled(), role: "impl" });
  try {
    const r = await runAgentLoop({ agent: mkAgent(), model, tools: { specs: [], execute: async () => ({ ok: true, text: "" }) }, board, tasks, bus, maxTurns: 2 });
    assert.equal(r.ok, true);
    const slog = join(ws, "state", "session-log", "session.jsonl");
    assert.ok(existsSync(slog), "session-logが書かれる");
    const chatRecs = readFileSync(slog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.kind === "chat");
    assert.ok(chatRecs.length >= 1);
    assert.equal(chatRecs[0].response.router.selected, "flash");
    assert.equal(chatRecs[0].response.router.reason, "default");
    const trace = join(ws, "state", "usage-trace", "usage-trace.jsonl");
    assert.ok(existsSync(trace), "usage-traceが書かれる");
    const recs = readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(recs.length >= 1);
    assert.equal(recs[0].router.selected, "flash");
    assert.equal(recs[0].router.reason, "default");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("router無効のモデル(RouterModel未使用)ではrouter記録が付かない(既存形を維持)", async () => {
  const ws = mkWsFixtures();
  const bus = new Bus();
  const board = new Board(bus, "__main__", join(ws, "state", "board.jsonl"));
  const tasks = new TaskBlackboard(ws, bus);
  const model = mkModel([], () => "応答");
  try {
    const r = await runAgentLoop({ agent: mkAgent(), model, tools: { specs: [], execute: async () => ({ ok: true, text: "" }) }, board, tasks, bus, maxTurns: 2 });
    assert.equal(r.ok, true);
    const slog = join(ws, "state", "session-log", "session.jsonl");
    const chatRecs = readFileSync(slog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.kind === "chat");
    assert.equal(chatRecs[0].response.router, undefined, "無効時はrouterキー自体が無い");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------- UI: /api/routing GET/POST + 永続化 ----------

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-routing-ui-"));
}

function mkConfig(ws, routing) {
  return {
    workspace: ws, ui: { port: 0 },
    models: {
      default: "prov/main",
      fallbacks: [],
      providers: { prov: { baseUrl: "http://x.invalid/v4", api: "openai-completions", auth: { value: "sk-value-key-9999" }, models: [{ id: "main", name: "Main" }] } },
      ...(routing !== undefined ? { routing } : {}),
    },
    agents: [], budget: { maxTokensPerRun: 1 },
  };
}

test("ui /api/routing: GETは実効状態、POSTはhive.local.jsonへ永続化する", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dataDir;
  try {
    const config = mkConfig(ws, { enabled: false });
    const ui = await startUiTokenized(startUi, { config, bus: new Bus(), autoStart: false });
    const base = "http://127.0.0.1:" + config.ui.port;
    const r = await (await fetch(base + "/api/routing")).json();
    assert.equal(r.enabled, false, "初期値はconfig値(OFF)");
    assert.equal(r.reflectTiming, "restart", "反映タイミング(再起動後)を明記");
    const w = await (await fetch(base + "/api/routing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) })).json();
    assert.equal(w.ok, true);
    const local = JSON.parse(readFileSync(join(dataDir, "hive.local.json"), "utf8"));
    assert.equal(local.models.routing.enabled, true, "hive.local.jsonへ永続化");
    const w2 = await (await fetch(base + "/api/routing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: "yes" }) }));
    assert.equal(w2.status, 400, "boolean以外は400");
    ui.close();
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("config側routing有効+local未設定なら有効のまま。/api/models もrouting状態を公開", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dataDir;
  try {
    const config = mkConfig(ws, { enabled: true });
    const ui = await startUiTokenized(startUi, { config, bus: new Bus(), autoStart: false });
    const base = "http://127.0.0.1:" + config.ui.port;
    const r = await (await fetch(base + "/api/routing")).json();
    assert.equal(r.enabled, true, "config有効がそのまま実効状態");
    const { model: m } = await (await fetch(base + "/api/models")).json();
    assert.equal(m.routing.enabled, true, "/api/modelsもroutingを公開(UIスイッチの初期表示用)");
    ui.close();
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("実効状態の同期: POST直後のGET・/api/modelsが同じ値を返す(スイッチ表示が戻らない)", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dataDir;
  try {
    // configは未設定(undefined)→ 初期実効状態はOFF(回帰)。POST true→GET true、POST false→GET false
    const config = mkConfig(ws, undefined);
    const ui = await startUiTokenized(startUi, { config, bus: new Bus(), autoStart: false });
    const base = "http://127.0.0.1:" + config.ui.port;
    const get = async () => (await (await fetch(base + "/api/routing")).json()).enabled;
    const modelsEnabled = async () => (await (await fetch(base + "/api/models")).json()).model.routing.enabled;
    assert.equal(await get(), false, "初期値はOFF(config未設定)");
    await (await fetch(base + "/api/routing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) })).json();
    assert.equal(await get(), true, "POST直後のGETはtrue(同期)");
    assert.equal(await modelsEnabled(), true, "/api/modelsも同期(UIがsyncRoutingSwitchで再取得しても表示が戻らない)");
    await (await fetch(base + "/api/routing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).json();
    assert.equal(await get(), false, "OFFへの再POSTも同期");
    assert.equal(await modelsEnabled(), false, "/api/modelsもOFFへ同期");
    ui.close();
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
