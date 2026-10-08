// モデル周りの設定API: /api/models・/api/model-test(疎通プローブ)・/api/keyのプロバイダ指定
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";
tokenedFetchOn();

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-model-ui-"));
}

// 疑似JWT(署名検証はしない・payload部だけを見る)
function fakeJwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

function mkConfig(ws) {
  return {
    workspace: ws, ui: { port: 0 },
    models: {
      default: "prov/main",
      fallbacks: [],
      providers: {
        prov: { baseUrl: "http://x.invalid/v4", api: "openai-completions", auth: { value: "sk-value-key-9999" }, models: [{ id: "main", name: "Main" }] },
        nolock: { baseUrl: "http://x.invalid/v4", api: "openai-completions", models: [{ id: "m1" }] },
        envprov: { baseUrl: "http://x.invalid/v4", api: "openai-completions", auth: { env: "HIVE_MODEL_UI_ENVKEY" }, models: [{ id: "m2" }] },
        // builtinのopenaiを上書き: ストアfileをテスト固有にして本物のトークンと分離する
        openai: { baseUrl: "http://x.invalid/backend-api", api: "openai-chatgpt-responses", auth: { type: "oauth", file: "state/test-openai-oauth.json" }, models: [{ id: "gpt-6-astra", name: "GPT-6 Astra" }] },
      },
    },
    model: { model: "main" },
    agents: [], budget: { maxTokensPerRun: 1 },
  };
}

test("設定API: /api/models はproviders一覧・鍵hintを出し、生の鍵は出さない", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dataDir;
  try {
    const config = mkConfig(ws);
    const ui = await startUiTokenized(startUi, { config, bus: new Bus(), autoStart: false });
    const base = `http://127.0.0.1:${config.ui.port}`;
    const { model: m } = await (await fetch(base + "/api/models")).json();
    assert.equal(m.ref, "prov/main");
    assert.equal(m.name, "Main");
    const prov = m.providers.find((p) => p.id === "prov");
    assert.equal(prov.authHint, "…9999");
    assert.ok(!JSON.stringify(m).includes("sk-value-key-9999"), "生の鍵は出さない");
    assert.equal(m.providers.find((p) => p.id === "nolock").authHint, null);
    ui.close();
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("設定API: /api/model-test は鍵未設定でauth_missing、保存後に疎通OK(fetch差し替え)", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dataDir;
  const origFetch = globalThis.fetch;
  const bodies = [];
  try {
    const config = mkConfig(ws);
    const ui = await startUiTokenized(startUi, { config, bus: new Bus(), autoStart: false });
    const base = `http://127.0.0.1:${config.ui.port}`;
    const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-hive-token": ui.token }, body: JSON.stringify(body) });

    // 鍵なしプロバイダ: プローブはauth_missing(疎通テストはプロセス内fetchを使うため元のfetchを保護)
    const r1 = await (await post("/api/model-test", { provider: "nolock" })).json();
    assert.equal(r1.ok, false);
    assert.equal(r1.code, "auth_missing");

    // プロバイダ指定で鍵保存 → state/models-nolock.key に書かれる
    const rk = await (await post("/api/key", { provider: "nolock", key: "sk-nolock-key-4321" })).json();
    assert.equal(rk.ok, true);
    assert.ok(existsSync(join(dataDir, "state", "models-nolock.key")), "自動割り当て先に保存");
    assert.equal(readFileSync(join(dataDir, "state", "models-nolock.key"), "utf8").trim(), "sk-nolock-key-4321");

    // env運用中(env変数が実在)は書けない
    process.env.HIVE_MODEL_UI_ENVKEY = "sk-env-xxxx-123456";
    const re = await (await post("/api/key", { provider: "envprov", key: "sk-envprov-key-4321" })).json();
    assert.equal(re.ok, false);
    assert.match(re.error, /環境変数 HIVE_MODEL_UI_ENVKEY/);

    // 疎通: プローブのfetchだけ差し替える(UI宛のPOSTは素通ししないとプローブ応答がUIを拾う)
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("/api/")) return origFetch(url, opts);
      bodies.push({ url: String(url), body: JSON.parse(opts.body), headers: opts.headers });
      return { ok: true, json: async () => ({ choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    };
    const r2 = await (await post("/api/model-test", { provider: "prov" })).json();
    assert.equal(r2.ok, true);
    assert.equal(r2.ref, "prov/main");
    assert.equal(bodies[0].body.max_tokens, 16, "プローブは軽量(max_tokens=16)");
    assert.equal(bodies[0].body.messages[0].content, "ping");
    const r3 = await (await post("/api/model-test", { provider: "nolock" })).json();
    assert.equal(r3.ok, true, "保存した鍵でプローブが通る");
    assert.equal(r3.ref, "nolock/m1");
    assert.equal(bodies[1].headers.authorization, "Bearer sk-nolock-key-4321");

    ui.close();
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.HIVE_MODEL_UI_ENVKEY;
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("設定API: /api/model-test は未知プロバイダでconfigエラー", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dataDir;
  try {
    const config = mkConfig(ws);
    const ui = await startUiTokenized(startUi, { config, bus: new Bus(), autoStart: false });
    const base = `http://127.0.0.1:${config.ui.port}`;
    const r = await (await fetch(base + "/api/model-test", { method: "POST", headers: { "content-type": "application/json", "x-hive-token": ui.token }, body: JSON.stringify({ provider: "unknown-prov" }) })).json();
    assert.equal(r.ok, false);
    assert.equal(r.code, "config");
    ui.close();
  } finally {
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("設定API: 内蔵プロバイダ(anthropic)にも鍵を保存でき、暗黙ファイル経由で疎通する", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dataDir;
  const origFetch = globalThis.fetch;
  try {
    const config = mkConfig(ws);
    const ui = await startUiTokenized(startUi, { config, bus: new Bus(), autoStart: false });
    const base = `http://127.0.0.1:${config.ui.port}`;
    const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-hive-token": ui.token }, body: JSON.stringify(body) });

    // builtinのみのプロバイダ(設定JSONに明記なし)への保存が「未知のプロバイダ」にならない
    const rk = await (await post("/api/key", { provider: "anthropic", key: "sk-ant-api03-test-12345678" })).json();
    assert.equal(rk.ok, true, JSON.stringify(rk));
    assert.ok(existsSync(join(dataDir, "state", "models-anthropic.key")), "state配下の暗黙ファイルに保存");

    // プローブ: resolveAuthValueの暗黙ファイル経由で鍵が拾われ、anthropicワイヤが応答する
    globalThis.fetch = async (url, opts) => {
      const s = String(url);
      if (s.includes("/api/")) return origFetch(url, opts);
      if (s.includes("api.anthropic.com")) {
        return { ok: true, json: async () => ({ type: "message", content: [{ type: "text", text: "pong" }], usage: { input_tokens: 1, output_tokens: 1 } }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    };
    const r2 = await (await post("/api/model-test", { provider: "anthropic" })).json();
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.match(r2.ref, /^anthropic\/claude-/);

    ui.close();
  } finally {
    globalThis.fetch = origFetch;
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("設定API: /api/openai-auth は認証URLを発行し、手動貼り付けでトークン保存・疎通まで通る", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const prev = process.env.HIVE_DATA;
  process.env.HIVE_DATA = dataDir;
  const origFetch = globalThis.fetch;
  const tokenFetches = [];
  let sseCalls = 0;
  try {
    const config = mkConfig(ws);
    const ui = await startUiTokenized(startUi, { config, bus: new Bus(), autoStart: false });
    const base = `http://127.0.0.1:${config.ui.port}`;
    const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-hive-token": ui.token }, body: JSON.stringify(body) });

    // 認証URL発行(コールバックサーバが14546で立つ)
    const r1 = await (await post("/api/openai-auth", { provider: "openai" })).json();
    assert.equal(r1.ok, true);
    const authUrl = new URL(r1.authUrl);
    assert.equal(authUrl.origin + authUrl.pathname, "https://auth.openai.com/oauth/authorize");
    const state = authUrl.searchParams.get("state");
    assert.ok(state);

    // state不一致の貼り付けは拒否
    const bad = await (await post("/api/openai-auth", { provider: "openai", pasteUrl: `http://127.0.0.1:14546/auth/callback?code=c1&state=wrong` })).json();
    assert.equal(bad.ok, false);
    assert.match(bad.error, /state不一致/);

    // トークン交換とCodexワイヤを差し替え: 貼り付け→ストア保存→/api/modelsのauthHint→プローブ疎通
    globalThis.fetch = async (url, opts) => {
      const s = String(url);
      if (s.includes("/api/")) return origFetch(url, opts);
      if (s.includes("auth.openai.com")) {
        tokenFetches.push(new URLSearchParams(opts.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-9" }, email: "me@example.com" }), refresh_token: "rt-9", expires_in: 3600 }) };
      }
      // Codexワイヤ: 軽量SSE応答
      sseCalls++;
      const enc = new TextEncoder();
      return {
        ok: true, status: 200,
        body: { getReader: () => { const items = ['data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1},"output":[]}}\n\n'].map((l) => enc.encode(l)); let i = 0; return { read: async () => (i < items.length ? { done: false, value: items[i++] } : { done: true }) }; } },
      };
    };
    const paste = `http://127.0.0.1:14546/auth/callback?code=c1&state=${encodeURIComponent(state)}`;
    const r2 = await (await post("/api/openai-auth", { provider: "openai", pasteUrl: paste })).json();
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(tokenFetches.length, 1);
    assert.equal(tokenFetches[0].get("grant_type"), "authorization_code");

    // ストア保存+authHint(email)で見える
    const saved = JSON.parse(readFileSync(join(dataDir, "state", "test-openai-oauth.json"), "utf8"));
    assert.equal(saved.openai.email, "me@example.com");
    const { model: m1 } = await (await fetch(base + "/api/models")).json();
    const openaiP = m1.providers.find((p) => p.id === "openai");
    assert.equal(openaiP.auth, "oauth");
    assert.equal(openaiP.authHint, "me@example.com");

    // プローブ(Codexワイヤ)が疎通する
    const r3 = await (await post("/api/model-test", { provider: "openai" })).json();
    assert.equal(r3.ok, true, JSON.stringify(r3));
    assert.equal(r3.ref, "openai/gpt-6-astra");
    assert.equal(sseCalls, 1);

    ui.close();
  } finally {
    globalThis.fetch = origFetch;
    if (prev === undefined) delete process.env.HIVE_DATA;
    else process.env.HIVE_DATA = prev;
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
