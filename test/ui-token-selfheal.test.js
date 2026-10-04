// トークン自己修復(hfetch)のテスト:
// トークンはサーバー起動ごとに再生成されるため、開きっぱなしのタブは再起動後に全POSTが403になる。
// hfetchは403時に同一オリジンの最新ページ(/)から実トークンを引き取り、1回だけ再試行する。
// index.htmlからhfetchを抽出し、fetchを差し替えたvmで実挙動を検証する(応答はstatusだけ参照する最小スタブ)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "src/ui/public/index.html"), "utf8");

function extractHfetch() {
  const marker = 'window.HIVE_TOKEN = "__HIVE_TOKEN__";';
  const start = html.indexOf(marker);
  assert.ok(start >= 0, "トークン割り当て行がindex.htmlに存在する");
  const fnStart = html.indexOf("function hfetch(", start);
  assert.ok(fnStart > start, "hfetchがindex.htmlに存在する");
  const end = html.indexOf("\n}", fnStart);
  assert.ok(end > fnStart, "hfetchの閉じ波括弧(カラム0)が見つかる");
  return html.slice(start, end + 2);
}

function makeStub({ pageToken, postTokens }) {
  const calls = [];
  const fetchStub = async (url, opts = {}) => {
    if (url === "/") return { status: 200, text: async () => `window.HIVE_TOKEN = ${JSON.stringify(pageToken)};` };
    const token = opts.headers?.["x-hive-token"];
    calls.push(token);
    if (token === postTokens.ok) return { status: 200, ok: true };
    return { status: 403, ok: false };
  };
  return { calls, fetchStub };
}

function loadHfetch(pageToken) {
  const { fetchStub, calls } = makeStub({ pageToken, postTokens: { ok: "fresh-token" } });
  const sandbox = { window: {}, fetch: fetchStub, JSON, console };
  // サーバー配信時に実トークンへ置換されるのと同じ形で初期トークンを埋め込む
  const src = extractHfetch().replace('"__HIVE_TOKEN__"', JSON.stringify("old-token"));
  vm.runInNewContext(`${src}\nglobalThis.__hfetch = hfetch;`, sandbox);
  return { hfetch: sandbox.__hfetch, sandbox, calls };
}

test("hfetch: 403時にページから新トークンを引き取り1回だけ再試行して成功する", async () => {
  const { hfetch, sandbox, calls } = loadHfetch("fresh-token");
  const r = await hfetch("/api/say", { method: "POST" });
  assert.equal(r.status, 200);
  assert.equal(sandbox.window.HIVE_TOKEN, "fresh-token");
  // 旧トークンで1回403→新トークンで1回
  assert.deepEqual(calls, ["old-token", "fresh-token"]);
});

test("hfetch: ページのトークンが変わっていなければ403をそのまま返す(再試行しない)", async () => {
  const { hfetch, sandbox, calls } = loadHfetch("old-token");
  const r = await hfetch("/api/say", { method: "POST" });
  assert.equal(r.status, 403);
  assert.equal(sandbox.window.HIVE_TOKEN, "old-token");
  assert.deepEqual(calls, ["old-token"]);
});

test("hfetch: GETは再試行対象外(403でもページを取りに行かない)", async () => {
  const { hfetch, calls } = loadHfetch("fresh-token");
  const r = await hfetch("/api/say", { method: "GET" });
  assert.equal(r.status, 403);
  assert.deepEqual(calls, [undefined]); // GETはトークンheader無しの1回だけ
});

test("index.html: hfetchの自己修復配線が存在する(403→再取得→再試行)", () => {
  assert.match(html, /status !== 403/);
  assert.match(html, /cache: "no-store"/);
  assert.match(html, /x-hive-token": fresh/);
});
