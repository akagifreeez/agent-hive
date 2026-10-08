// 閉じたスレッドのエージェント残存を修正するテスト:
// thread.closedは「接頭辞一致」と「threadフィールド一致」の両方でメンバーを掃除する
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../../src/engine/board.js";
import { startUi } from "../../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-tclose-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

test("thread.closed: threadフィールドで紐付く汎用ID(impl-N等)も掃除される", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "m" }, agents: [] };
  const ui = await startUi({ config, modelFactory: () => ({}), bus, autoStart: false });

  // スレッドopen時に3ワーカー(接頭辞ID)が出現
  bus.emit("thread.opened", { name: "demo", goal: "g", agents: [{ id: "demo-alpha", displayName: "A" }, { id: "demo-beta", displayName: "B" }] });
  // 追加ワーカー(汎用ID、threadフィールドのみで帰属)が出現
  bus.emit("agent.spawned", { agent: { id: "impl-7", displayName: "追加", parent: "demo-alpha", thread: "demo" } });
  // 他スレッドの同名接頭辞は掃除対象外
  bus.emit("agent.spawned", { agent: { id: "other-impl-1", displayName: "他スレッド", parent: null, thread: "other" } });

  let s = await (await fetch(`http://127.0.0.1:${config.ui.port}/api/state`)).json();
  assert.ok(s.live.agents["demo-alpha"], "接頭辞ワーカーが登録済み");
  assert.ok(s.live.agents["impl-7"], "汎用IDワーカーが登録済み");
  assert.ok(s.live.agents["other-impl-1"], "他スレッドのワーカーが登録済み");

  bus.emit("thread.closed", { name: "demo" });

  s = await (await fetch(`http://127.0.0.1:${config.ui.port}/api/state`)).json();
  assert.equal(s.live.agents["demo-alpha"], undefined, "接頭辞一致で消える");
  assert.equal(s.live.agents["demo-beta"], undefined);
  assert.equal(s.live.agents["impl-7"], undefined, "thread一致でも消える(今回の修正点)");
  assert.ok(s.live.agents["other-impl-1"], "他スレッドのワーカーは残る");

  ui.close();
  rmTree(ws);
});
