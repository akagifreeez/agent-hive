// UIサーバーの /api/tasks create が depends_on を通すことの検証(イシュー#2)。
// server.js の handleTaskAction から depends_on が落ちると、UIフォームからの依存指定が
// 黙って無視される(保存されずclaim判定も効かない)ため、HTTP経由で担保する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi as _startUi } from "../src/ui/server.js";
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";
import { readMeta } from "../src/engine/tasks.js";
tokenedFetchOn();

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-depends-ui-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

test("UI: /api/tasks create に depends_on を付けるとメタ行に保存されclaim判定が効く", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "test-model" }, agents: [] };
  const ui = await startUiTokenized(_startUi, { config, modelFactory: () => ({}), bus, autoStart: false });
  const port = config.ui.port, token = ui.token;
  const post = (payload) => fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hive-token": token, origin: "http://localhost" },
    body: JSON.stringify(payload),
  });

  // 先行タスクと、それに依存する後続タスクをUI APIで起票
  const r1 = await (await post({ action: "create", id: "ui-p", body: "先行" })).json();
  assert.deepEqual(r1, { ok: true, id: "ui-p" });
  const r2 = await (await post({ action: "create", id: "ui-q", body: "後続", depends_on: ["ui-p"] })).json();
  assert.deepEqual(r2, { ok: true, id: "ui-q" });

  // depends_onがメタ行に保存されている
  const meta = readMeta(join(ws, "tasks", "open", "ui-q.md"));
  assert.deepEqual(meta.dependsOn, ["ui-p"], "UIから指定したdepends_onがメタ行へ保存される");

  // 依存が未完了の間は後続をclaimできない(TaskBlackboardの判定まで繋がる)
  const { TaskBlackboard } = await import("../src/engine/tasks.js");
  const tasks = new TaskBlackboard(ws, bus);
  assert.ok(tasks.claim({ id: "w", role: null }), "依存の無い先行はclaim可");
  assert.equal(tasks.claim({ id: "w2", role: null }), null, "UI経由で作った依存付きタスクは未完了依存でclaim不可");

  ui.close();
  rmTree(ws);
});

test("UI: depends_on 無しのcreateは従来通り動く(後方互換)", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "test-model" }, agents: [] };
  const ui = await startUiTokenized(_startUi, { config, modelFactory: () => ({}), bus, autoStart: false });
  const port = config.ui.port, token = ui.token;
  const post = (payload) => fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hive-token": token, origin: "http://localhost" },
    body: JSON.stringify(payload),
  });
  const r = await (await post({ action: "create", id: "plain-ui", body: "依存なし" })).json();
  assert.deepEqual(r, { ok: true, id: "plain-ui" });
  const meta = readMeta(join(ws, "tasks", "open", "plain-ui.md"));
  assert.deepEqual(meta.dependsOn, []);
  ui.close();
  rmTree(ws);
});
