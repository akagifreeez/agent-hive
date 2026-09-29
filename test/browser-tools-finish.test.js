// イシュー#10仕上げの検証:
// 1) tools.js への browser_fetch/browser_extract/browser_submit 登録確認(specs一覧とexecute)
// 2) /api/mcp GET応答の guidance フィールド(接続済みサーバー名 or 未接続案内)
// 外部サイトへ実アクセスしない(ローカルサーバーで検証)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { startUi as _startUi } from "../src/ui/server.js";
import { startUiTokenized } from "./helpers/hf-token.js";

const AGENT = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-bt-finish-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

function makeTools(ws) {
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  return createTools({ agent: AGENT, workspace: ws, board, tasks, bus });
}

test("tools登録: browser_fetch/extract/submitがspecs一覧にあり、executeで呼べる", async () => {
  const ws = mktmp();
  const tools = makeTools(ws);

  const names = tools.specs.map((s) => s.name);
  for (const n of ["browser_fetch", "browser_extract", "browser_submit"]) {
    assert.ok(names.includes(n), n + " がspecsに無い");
  }
  // パラメータ契約: 必須引数の宣言
  assert.deepEqual(tools.specs.find((s) => s.name === "browser_fetch").parameters.required, ["url"]);
  assert.deepEqual(tools.specs.find((s) => s.name === "browser_submit").parameters.required, ["html", "base_url"]);

  // ローカルサーバーで取得→抽出→相対URLエラー系を結合確認
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<html><head><title>検証頁</title></head><body><h1>見出しX</h1><a href="/next">次へ</a></body></html>');
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = "http://127.0.0.1:" + server.address().port;

  const f = await tools.execute("browser_fetch", { url: base + "/p.html" });
  assert.equal(f.ok, true);
  assert.match(f.text, /検証頁/);
  assert.match(f.text, /見出しX/);

  const e = await tools.execute("browser_extract", { url: base + "/p.html", selector: "h1" });
  assert.equal(e.ok, true);
  assert.match(e.text, /見出しX/);

  const bad = await tools.execute("browser_fetch", { url: "/relative-only" });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /http/);

  server.close();
  rmTree(ws);
});

test("/api/mcp GET: guidanceに未接続案内が出る(onMcpList空)", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "m" }, agents: [] };
  const ui = await startUiTokenized(_startUi, {
    config, modelFactory: () => ({}), bus, autoStart: false,
    onMcpList: () => [],
  });
  const base = "http://127.0.0.1:" + config.ui.port;
  const r = await fetch(base + "/api/mcp");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.servers, []);
  assert.match(String(body.guidance), /MCP未接続/);
  assert.match(String(body.guidance), /Playwright/);
  ui.close();
  rmTree(ws);
});

test("/api/mcp GET: guidanceに接続済みサーバー名が出る", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "m" }, agents: [] };
  const ui = await startUiTokenized(_startUi, {
    config, modelFactory: () => ({}), bus, autoStart: false,
    onMcpList: () => [{ name: "echo", command: "node", args: ["x.mjs"], envKeys: [], tools: ["echo"], started: true }],
  });
  const base = "http://127.0.0.1:" + config.ui.port;
  const r = await fetch(base + "/api/mcp");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.servers.map((x) => x.name), ["echo"]);
  assert.match(String(body.guidance), /MCP接続済み/);
  assert.match(String(body.guidance), /echo/);
  ui.close();
  rmTree(ws);
});
