// /api/devserver: ダミーHTTPサーバーの起動/停止の疎通テスト
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-devserver-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

async function waitUntil(fn, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

test("/api/devserver: ダミーHTTPサーバーの起動/停止/重複起動防止", async () => {
  const ws = mktmp();
  // port:0でlistenし、実際のポートをファイルに書くダミーサーバー
  writeFileSync(join(ws, "dummy-server.mjs"), `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const srv = createServer((req, res) => { res.writeHead(200); res.end("ok"); });
srv.listen(0, "127.0.0.1", () => {
  writeFileSync(new URL("./dummy-port.txt", import.meta.url), String(srv.address().port));
});
`);
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "m" }, agents: [] };
  const ui = await startUi({ config, modelFactory: () => ({}), bus, autoStart: false });
  const base = `http://127.0.0.1:${config.ui.port}`;

  // 起動
  const r1 = await fetch(`${base}/api/devserver`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "dummy-server.mjs" }) });
  assert.equal(r1.status, 200);
  const started = await r1.json();
  assert.equal(started.ok, true);
  assert.ok(started.pid > 0);

  // 疎通: ダミーサーバーがポートを書くのを待ってHTTP GET
  const portFile = join(ws, "dummy-port.txt");
  assert.ok(await waitUntil(() => { try { return readPort(portFile) > 0; } catch { return false; } }), "ダミーサーバーがlistenする");
  const port = readPort(portFile);
  const ping = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(ping.status, 200);
  assert.equal(await ping.text(), "ok");

  // 重複起動防止: 同じscriptは同じpid
  const r2 = await fetch(`${base}/api/devserver`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "dummy-server.mjs" }) });
  const again = await r2.json();
  assert.equal(again.alreadyRunning, true);
  assert.equal(again.pid, started.pid);

  // 停止
  const r3 = await fetch(`${base}/api/devserver?script=${encodeURIComponent("dummy-server.mjs")}`, { method: "DELETE" });
  const stopped = await r3.json();
  assert.equal(stopped.ok, true);
  // 停止後の疎通は失敗する
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));

  // ワークスペース外は拒否
  const r4 = await fetch(`${base}/api/devserver`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "../outside.mjs" }) });
  assert.equal(r4.status, 400);

  ui.close();
  rmTree(ws);
});

function readPort(p) {
  return Number(readFileSync(p, "utf8").trim());
}
