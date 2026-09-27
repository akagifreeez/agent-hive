// devserver API: package.json の scripts を検出し、ダミーHTTPサーバーを起動/停止できること
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUi } from "../src/ui/server.js";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  return { status: r.status, body: await r.json() };
}

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "hive-devserver-"));
  // ダミーHTTPサーバースクリプト: 起動したら固定ポートで応答する
  writeFileSync(join(ws, "dummy-server.mjs"), `
import { createServer } from "node:http";
const s = createServer((req, res) => { res.writeHead(200).end("dummy-ok"); });
s.listen(0, "127.0.0.1", () => console.log("PORT=" + s.address().port));
process.on("SIGTERM", () => { s.close(); process.exit(0); });
`);
  writeFileSync(join(ws, "package.json"), JSON.stringify({
    name: "dummy", type: "module",
    scripts: { serve: "node dummy-server.mjs", build: "echo built" },
  }));
  return ws;
}

test("devserver: scripts一覧の検出、起動でHTTP疎通、stopで停止", async () => {
  const ws = makeWorkspace();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const config = {
    workspace: ws,
    ui: { port: 0 },
    model: { model: "test" },
    agents: [],
    budget: { maxTokensPerRun: 1 },
  };
  const ui = await startUi({ config, modelFactory: () => ({}), bus, autoStart: false });
  const base = `http://127.0.0.1:${config.ui.port}`;

  // scripts検出(GET /api/scripts。/api/devserverはGETで起動中サーバー一覧を返す)
  const list = await fetchJson(`${base}/api/scripts`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.scripts.map((s) => s.name), ["serve", "build"]);

  // 起動
  const started = await fetchJson(`${base}/api/devserver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "start", script: "serve" }),
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.ok(started.body.ok);
  assert.ok(started.body.pid > 0);
  assert.ok(typeof started.body.url === "string" && started.body.url.startsWith("http://"));

  // 二重起動は同じプロセスを返す(alreadyRunning)
  const dup = await fetchJson(`${base}/api/devserver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "start", script: "serve" }),
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.alreadyRunning, true);
  assert.equal(dup.body.pid, started.body.pid);

  // 停止
  const stopped = await fetchJson(`${base}/api/devserver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "stop", script: "serve" }),
  });
  assert.equal(stopped.status, 200);
  assert.ok(stopped.body.ok);

  // 停止後の二重停止はエラー
  const dupStop = await fetchJson(`${base}/api/devserver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "stop", script: "serve" }),
  });
  assert.equal(dupStop.body.ok, false);

  ui.close();
  rmTree(ws);
});
