// OpenAI Codex OAuth(ChatGPT Plus/Pro): PKCEフロー・トークン交換/リフレッシュ・ストア・ワイヤ変換
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAuthorizeUrl, createPKCE, openCallbackServer,
  exchangeCode, refreshToken, extractAccountId,
  resolveOAuthToken, readTokenStore, writeTokenStore, oauthHint,
} from "../src/model/openai-auth.js";
import { ChatGPTModel, codexUrl, toCodexRequest, codexUsage } from "../src/model/openai-chatgpt.js";

// 疑似JWT(署名検証はしない・payload部だけを見る)
function fakeJwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

test("buildAuthorizeUrl: PKCEとstateを含む認証URLを組み立てる", () => {
  const { verifier } = createPKCE();
  const url = new URL(buildAuthorizeUrl({ verifier, state: "abc123", redirectUri: "http://127.0.0.1:14546/auth/callback" }));
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.match(url.searchParams.get("client_id"), /^app_/);
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:14546/auth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge").length > 30);
  assert.equal(url.searchParams.get("state"), "abc123");
  assert.ok(url.searchParams.get("scope").includes("offline_access"));
});

test("openCallbackServer: codeとstateを検証して解決する(state不一致はreject)", async () => {
  const redirectUri = "http://127.0.0.1:14599/auth/callback";
  const opened = await openCallbackServer({ redirectUri, state: "st1", timeoutMs: 5000 });
  const p = opened.promise;
  await fetch("http://127.0.0.1:14599/auth/callback?code=xyz&state=st1");
  assert.deepEqual(await p, { code: "xyz" });
  opened.close();

  const opened2 = await openCallbackServer({ redirectUri, state: "st2", timeoutMs: 5000 });
  opened2.promise.catch(() => {}); // rejectはassert.rejectsで受け取る(unhandled防止)
  await fetch("http://127.0.0.1:14599/auth/callback?code=xyz&state=wrong");
  await assert.rejects(() => opened2.promise, /stateが不一致/);
  opened2.close();
});

test("exchangeCode/refreshToken: フォーム交換とリフレッシュ(リフレッシュ応答が返らない場合は既存を保持)", async () => {
  const origFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    bodies.push({ url: String(url), body: new URLSearchParams(opts.body) });
    const grant = bodies[bodies.length - 1].body.get("grant_type");
    if (grant === "authorization_code") {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }), refresh_token: "rt-old", expires_in: 3600 }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }), expires_in: 1800 }) };
  };
  try {
    const tokens = await exchangeCode("c1", "ver1", "http://127.0.0.1:14546/auth/callback");
    assert.equal(bodies[0].body.get("grant_type"), "authorization_code");
    assert.equal(bodies[0].body.get("code_verifier"), "ver1");
    assert.ok(tokens.access.length > 20);
    assert.equal(tokens.refresh, "rt-old");
    assert.ok(tokens.expires > Date.now());

    const r = await refreshToken("rt-old");
    assert.equal(bodies[1].body.get("grant_type"), "refresh_token");
    assert.equal(bodies[1].body.get("client_id"), bodies[0].body.get("client_id"), "同じclient_idを使う");
    assert.equal(r.refresh, "rt-old", "応答にrefresh_tokenが無ければ既存を保持");
    assert.equal(extractAccountId(tokens.access), "acc-1");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("resolveOAuthToken: 未認証はnull、期限切れは自動リフレッシュしてストアへ書き戻す", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-oauth-"));
  const file = "state/openai-oauth.json";
  const baseDirs = [dir];
  const storeRef = { provider: "openai", file };
  assert.equal(await resolveOAuthToken(storeRef, baseDirs), null, "未認証");

  // 有効なトークンを書く(期限まで10分)=リフレッシュせずそのまま返る
  const store = { openai: { access: "tok-a", refresh: "rt-1", expires: Date.now() + 10 * 60_000, accountId: "acc-1" } };
  writeTokenStore(file, store, baseDirs);
  assert.ok(existsSync(join(dir, "state", "openai-oauth.json")));
  const t = await resolveOAuthToken(storeRef, baseDirs);
  assert.equal(t.access, "tok-a");

  // 期限切れ → リフレッシュ(fetch差し替え)→ ストア更新
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const grant = new URLSearchParams(opts.body).get("grant_type");
    assert.equal(grant, "refresh_token");
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "tok-b", refresh_token: "rt-2", expires_in: 3600 }) };
  };
  try {
    writeTokenStore(file, { openai: { access: "tok-a", refresh: "rt-1", expires: Date.now() - 1000 } }, baseDirs);
    const t2 = await resolveOAuthToken(storeRef, baseDirs);
    assert.equal(t2.access, "tok-b");
    const saved = JSON.parse(readFileSync(join(dir, "state", "openai-oauth.json"), "utf8"));
    assert.equal(saved.openai.refresh, "rt-2");
    assert.ok(saved.openai.expires > Date.now());
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oauthHint: email優先、無ければaccountId末尾、未認証はnull", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-oauth-"));
  const baseDirs = [dir];
  const storeRef = { provider: "openai", file: "s.json" };
  assert.equal(oauthHint(storeRef, baseDirs), null);
  writeTokenStore(storeRef.file, { openai: { refresh: "r", accountId: "acc-abcdef" } }, baseDirs);
  assert.equal(oauthHint(storeRef, baseDirs), "…abcdef");
  rmSync(dir, { recursive: true, force: true });
});

test("codexUrl: baseUrlから/codex/responsesへ補完する", () => {
  assert.equal(codexUrl("https://chatgpt.com/backend-api"), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(codexUrl("https://chatgpt.com/backend-api/codex"), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(codexUrl("https://x/codex/responses/"), "https://x/codex/responses");
});

test("toCodexRequest: systemはinstructionsへ、tool_call/tool_resultはResponses形へ", () => {
  const cfg = { model: "gpt-6-astra", temperature: null };
  const body = toCodexRequest({
    cfg,
    messages: [
      { role: "system", content: "リーダー" },
      { role: "user", content: "見て" },
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "中身" },
    ],
    tools: [{ name: "read_file", description: "読む", parameters: { type: "object" } }],
  });
  assert.equal(body.model, "gpt-6-astra");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "リーダー");
  assert.deepEqual(body.input[0], { role: "user", content: [{ type: "input_text", text: "見て" }] });
  assert.deepEqual(body.input[1], { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' });
  assert.deepEqual(body.input[2], { type: "function_call_output", call_id: "c1", output: "中身" });
  assert.deepEqual(body.tools, [{ type: "function", name: "read_file", description: "読む", parameters: { type: "object" } }]);
});

test("ChatGPTModel.chat: SSEを変換しoutput_text/usage/tool_callを正規形へ(未認証は例外)", async () => {
  // 未認証(tokenFnがnull)
  const m1 = new ChatGPTModel({ tokenFn: async () => null });
  await assert.rejects(() => m1.chat({ messages: [{ role: "user", content: "x" }] }), /未認証/);

  // 正常系: ダミーSSE
  function sse(lines) {
    const enc = new TextEncoder();
    return {
      ok: true, status: 200,
      body: {
        getReader: () => {
          const items = lines.map((l) => enc.encode(l));
          let i = 0;
          return { read: async () => (i < items.length ? { done: false, value: items[i++] } : { done: true }) };
        },
      },
    };
  }
  const origFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, opts) => {
    urls.push({ url: String(url), headers: opts.headers });
    return sse([
      'data: {"type":"response.output_text.delta","delta":"こん"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"にちは"}\n\n',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"c9","name":"read_file"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"pa"}\n\n',
      'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"th\\":\\"a.txt\\"}"}}\n\n'.replace('}"}}\n\n', '"}}\n\n'),
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5},"output":[{"type":"message","content":[{"type":"output_text","text":"こんにちは"}]},{"type":"function_call","call_id":"c9","name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}]}}\n\n',
    ]);
  };
  try {
    const m = new ChatGPTModel({
      tokenFn: async () => ({ access: "tok", accountId: "acc-1" }),
      maxTokens: 2000,
    });
    const deltas = [];
    const r = await m.chat({ messages: [{ role: "user", content: "hi" }], onDelta: (d) => deltas.push(d) });
    assert.equal(r.content, "こんにちは");
    assert.deepEqual(r.toolCalls, [{ id: "c9", name: "read_file", arguments: { path: "a.txt" } }]);
    assert.equal(r.usage.promptTokens, 10);
    assert.equal(r.usage.completionTokens, 5);
    assert.deepEqual(deltas.map((d) => d.kind), ["say", "say"]);
    assert.match(urls[0].url, /\/codex\/responses$/);
    assert.equal(urls[0].headers.authorization, "Bearer tok");
    assert.equal(urls[0].headers["chatgpt-account-id"], "acc-1");
    assert.equal(urls[0].headers["openai-beta"], "responses=experimental");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("codexUsage: 単価があれば概算、無ければ0(サブスク)", () => {
  const u = { input_tokens: 1000, output_tokens: 500 };
  assert.equal(codexUsage(u, null).costUsd, 0);
  assert.equal(codexUsage(u, { input: 2, output: 10 }).costUsd, (1000 * 2 + 500 * 10) / 1e6);
});
