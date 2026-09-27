// ブラウザで開く: devserver起動後にURLをOS既定ブラウザへ渡す処理の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { openInBrowser, defaultOpenCommand } from "../src/engine/browser.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUi } from "../src/ui/server.js";
import { Bus } from "../src/engine/board.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

test("defaultOpenCommand: プラットフォーム別コマンドを返す", () => {
  const c = defaultOpenCommand("http://127.0.0.1:1234/");
  assert.equal(typeof c.cmd, "string");
  assert.ok(c.args.flat().includes("http://127.0.0.1:1234/"));
});

test("openInBrowser: runnerを差し替えるとURLが渡る(実ブラウザを開かない)", async () => {
  const seen = [];
  const ok = await openInBrowser("http://example.test/", (url) => { seen.push(url); return { cmd: "true", args: [] }; });
  assert.equal(ok, true);
  assert.deepEqual(seen, ["http://example.test/"]);
});

test("openInBrowser: 失敗時はfalse(UIは壊れない)", async () => {
  const ok = await openInBrowser("http://example.test/", () => { throw new Error("no browser"); });
  assert.equal(ok, false);
});

test("devserver起動時にブラウザオープンが呼ばれる(open:falseで抑止できる)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-open-"));
  try {
    writeFileSync(join(ws, "dummy-server.mjs"), "import { createServer } from 'node:http';const s=createServer((q,r)=>r.writeHead(200).end('ok'));s.listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port));process.on('SIGTERM',()=>process.exit(0));");
    writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { serve: "node dummy-server.mjs" } }));
    const config = { workspace: ws, ui: { port: 0 }, model: { model: "t" }, agents: [], budget: { maxTokensPerRun: 1 } };
    const ui = await startUi({ config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
    const base = `http://127.0.0.1:${config.ui.port}`;
    const post = (b) => fetch(`${base}/api/devserver`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

    // open:false で起動 → ブラウザを開かずURLだけ返る
    const r = await post({ action: "start", script: "serve", open: false });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.ok);
    assert.ok(body.url.startsWith("http://"));
    assert.notEqual(body.opened, true);

    // 停止して後片付け
    await post({ action: "stop" });
    ui.close();
  } finally { rmTree(ws); }
});
