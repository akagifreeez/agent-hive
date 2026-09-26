// 設定ウィンドウ(本番実装)のサーバー側API検証: モデル/思考レベル・権限モード・フォルダ
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-settings-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

async function fetchJson(url, body = null) {
  const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  return { status: r.status, body: await r.json() };
}

test("設定API: /api/modelは思考レベルとモデルをruntimeへ届け、stateに反映する", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const calls = [];
  const config = {
    workspace: ws,
    ui: { port: 0 },
    model: { model: "base-model" },
    agents: [],
    budget: { maxTokensPerRun: 1 },
  };
  const ui = await startUi({
    config, modelFactory: () => ({}), bus, autoStart: false,
    onModel: (patch) => { calls.push(patch); return { ok: true, model: patch.model ?? "base-model", effort: patch.effort ?? null }; },
    onPermMode: (mode) => ({ ok: true, mode }),
  });
  const base = `http://127.0.0.1:${config.ui.port}`;

  const r = await fetchJson(`${base}/api/model`, { effort: "high" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.effort, "high");
  assert.deepEqual(calls, [{ effort: "high" }]);

  // ランナー側がmodel.changedを発火したら、stateのliveに載る(UIの/や設定が現在値を参照できる)
  bus.emit("model.changed", { model: "gpt-x", effort: "high" });
  const st = await fetchJson(`${base}/api/state`);
  assert.equal(st.body.live.modelEffort, "high");
  assert.equal(st.body.live.modelName, "gpt-x");

  // モデル名の変更も届く
  const r2 = await fetchJson(`${base}/api/model`, { model: "gpt-x" });
  assert.equal(r2.body.ok, true);
  assert.equal(calls.at(-1).model, "gpt-x");

  // 不正リクエストは400
  const bad = await fetch(`${base}/api/model`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(bad.status, 400);

  ui.close();
  rmTree(ws);
});

test("設定API: /api/permで権限モードが変わり、stateのpermModeに反映する", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const modes = [];
  const config = {
    workspace: ws,
    ui: { port: 0 },
    model: { model: "test" },
    agents: [],
    budget: { maxTokensPerRun: 1 },
  };
  const ui = await startUi({
    config, modelFactory: () => ({}), bus, autoStart: false,
    onPermMode: (mode) => { modes.push(mode); return { ok: true, mode }; },
  });
  const base = `http://127.0.0.1:${config.ui.port}`;

  const st0 = await fetchJson(`${base}/api/state`);
  assert.equal(st0.body.live.permMode, "normal");

  const r = await fetchJson(`${base}/api/perm`, { mode: "auto" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(modes, ["auto"]);

  // gate側がperm.modeを発火したらstateに反映
  bus.emit("perm.mode", { mode: "auto" });
  const st = await fetchJson(`${base}/api/state`);
  assert.equal(st.body.live.permMode, "auto");

  ui.close();
  rmTree(ws);
});

test("設定API: /api/folderでスレッドのフォルダを付け替えられる", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const reqs = [];
  const config = {
    workspace: ws,
    ui: { port: 0 },
    model: { model: "test" },
    agents: [],
    budget: { maxTokensPerRun: 1 },
  };
  const ui = await startUi({
    config, modelFactory: () => ({}), bus, autoStart: false,
    onFolder: (req) => { reqs.push(req); return { ok: true, name: req.project, folder: req.folder }; },
  });
  const base = `http://127.0.0.1:${config.ui.port}`;

  const r = await fetchJson(`${base}/api/folder`, { project: "demo", folder: "AI開発" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(reqs, [{ project: "demo", folder: "AI開発" }]);

  // 空文字はnull(未分類)として届く
  await fetchJson(`${base}/api/folder`, { project: "demo", folder: "" });
  assert.equal(reqs.at(-1).folder, null);

  // エラー時は400
  const cfg2 = { ...config, ui: { port: 0 } };
  const ui2 = await startUi({
    config: cfg2, modelFactory: () => ({}), bus, autoStart: false,
    onFolder: () => ({ error: "スレッド x は開いていません" }),
  });
  const base2 = `http://127.0.0.1:${cfg2.ui.port}`;
  const r2 = await fetchJson(`${base2}/api/folder`, { project: "x", folder: "f" });
  assert.equal(r2.status, 400);
  assert.ok(r2.body.error);

  ui.close();
  ui2.close();
  rmTree(ws);
});
