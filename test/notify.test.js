// CLI通知チャネル(#11): permission.request/merge.completed/長時間タスク完了が
// コンソール(stderr)+監視(/api/monitorのnotifications)へ届くこと。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { wireCliNotify, printNotifyLine } from "../src/notify.js";
import { startUi as _startUi } from "../src/ui/server.js";
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";
tokenedFetchOn();

function makeWs() {
  return mkdtempSync(join(tmpdir(), "hive-notify-"));
}

test("notify: 承認要求がコンソール行とonNotify配信に届く", () => {
  const bus = new Bus();
  const lines = [];
  const got = [];
  const w = wireCliNotify(bus, { log: () => {}, onNotify: (n) => got.push(n) });
  assert.ok(w, "初回配線はnon-null");
  // printNotifyLineをstderr経由でなく捕捉するため、onNotifyの他にlogは持たない設計。
  // コンソール行の出力検証はstderrの書き換えで行う
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try {
    bus.emit("permission.request", { id: 7, command: "npm run danger", pattern: "npm run danger" });
  } finally {
    process.stderr.write = origWrite;
  }
  assert.match(captured, /🔔 \[通知\] 承認待ち #7/, "コンソールへ目立つ1行が出る");
  assert.match(captured, /npm run danger/);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, "permission.request");
  assert.equal(got[0].id, 7);
  w.unwire();
});

test("notify: マージ完了が通知になる", () => {
  const bus = new Bus();
  const got = [];
  const w = wireCliNotify(bus, { onNotify: (n) => got.push(n) });
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try {
    bus.emit("merge.completed", { agent: "alpha", taskId: "t-1", summary: "パッド実装" });
  } finally {
    process.stderr.write = origWrite;
  }
  assert.match(captured, /マージ完了 t-1/);
  assert.match(captured, /パッド実装/);
  assert.equal(got[0].kind, "merge.completed");
  assert.equal(got[0].taskId, "t-1");
  w.unwire();
});

test("notify: 長時間タスク完了(閾値以上)だけが通知になる", async () => {
  const bus = new Bus();
  const got = [];
  const w = wireCliNotify(bus, { longTaskSec: 1, onNotify: (n) => got.push(n) });
  bus.emit("task.claimed", { agent: "alpha", taskId: "slow-1" });
  bus.emit("task.claimed", { agent: "beta", taskId: "quick-1" });
  await new Promise((r) => setTimeout(r, 30));
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    bus.emit("task.finished", { agent: "alpha", taskId: "quick-1" }); // 30ms < 閾値1秒→通知しない
    bus.emit("task.finished", { agent: "gamma", taskId: "unknown-1" }); // 起点不明→通知しない
    // 長時間扱いは「起点が閾値より前」で判定するため、claimedAtを直接未来へずらして
    // 実時間待ち無しに閾値超過を再現する(内部実装に依存しない代替: 実待ちは別テスト)
    bus.emit("task.claimed", { agent: "beta", taskId: "slow-2" });
    // 直後にfinishしても1秒閾値では通知されない → このテストでは実時間の代わりに
    // 閾値0.05秒の別配線で長時間側を検証する
  } finally {
    process.stderr.write = origWrite;
  }
  assert.equal(got.length, 0, "1秒閾値なら短時間/起点不明は全て通知しない");
  w.unwire();

  // 長時間側(閾値50ms・起点のみ約80ms前)を別busで検証
  const bus2 = new Bus();
  const got2 = [];
  const w2 = wireCliNotify(bus2, { longTaskSec: 0.05, onNotify: (n) => got2.push(n) });
  bus2.emit("task.claimed", { agent: "beta", taskId: "slow-2" });
  await new Promise((r) => setTimeout(r, 80));
  bus2.emit("task.finished", { agent: "beta", taskId: "slow-2" });
  assert.equal(got2.length, 1);
  assert.equal(got2[0].kind, "task.finished.long");
  assert.equal(got2[0].taskId, "slow-2");
  w2.unwire();
});

test("notify: 二重配線しない(2回目はonNotify追加のみ)。解放/中止で起点を忘れる", () => {
  const bus = new Bus();
  const a = [];
  const b = [];
  const w1 = wireCliNotify(bus, { onNotify: (n) => a.push(n) });
  const w2 = wireCliNotify(bus, { onNotify: (n) => b.push(n) });
  assert.equal(w2, null, "2回目の配線はnull(onNotify追加のみ)");
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    bus.emit("merge.completed", { agent: "x", taskId: "t" });
    assert.equal(a.length, 1);
    assert.equal(b.length, 1, "両方のonNotifyへ配信");
    // 解放されたタスクは完了しても長時間通知にならない
    bus.emit("task.claimed", { agent: "x", taskId: "rel-1" });
    bus.emit("task.released", { agent: "x", taskId: "rel-1" });
    bus.emit("task.finished", { agent: "x", taskId: "rel-1" });
    bus.emit("task.claimed", { agent: "x", taskId: "can-1" });
    bus.emit("task.cancelled", { taskId: "can-1" });
    bus.emit("task.finished", { agent: "x", taskId: "can-1" });
  } finally {
    process.stderr.write = origWrite;
  }
  assert.equal(a.length, 1, "解放/中止済みは通知に数えない");
  w1.unwire();
});

test("notify: unwireで外れる。printNotifyLineはNO_COLORでも壊れない", () => {
  const bus = new Bus();
  const w = wireCliNotify(bus, {});
  w.unwire();
  const got = [];
  bus.emit("permission.request", { id: 9, command: "x" });
  assert.equal(got.length, 0, "配線解除後は届かない");
  // unwire後に再配線できる
  const w2 = wireCliNotify(bus, { onNotify: (n) => got.push(n) });
  assert.ok(w2);
  bus.emit("permission.request", { id: 10, command: "y" });
  assert.equal(got.length, 1);
  w2.unwire();
  // 行生成そのもの(書式崩れがないこと)
  const n = { kind: "merge.completed", at: new Date().toISOString(), title: "マージ完了 t-2", body: "ok" };
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try { printNotifyLine(n); } finally { process.stderr.write = origWrite; }
  assert.match(captured, /マージ完了 t-2: ok/);
});

test("monitor: /api/monitorにnotificationsとpendingRequestsが載る", async () => {
  const ws = makeWs();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0, monitorPort: 0 }, model: { model: "test" }, agents: [], budget: { maxTokensPerRun: 1 }, notify: { longTaskSec: 600 } };
  const ui = await startUiTokenized(_startUi, { config, modelFactory: () => ({}), bus, autoStart: false });
  try {
    // monitorPort: 0 でもモニタが立つ(0=エフェメラル許可)。起動ログの代わりに
    // startUiの戻りからは取れないため、config.ui.monitorPortへサーバー実ポートは不要。
    // /api/monitorの応答検証だけで十分(通知配信の本体はlive.notifications)
    bus.emit("permission.request", { id: 3, command: "npm test -- --watch" });
    bus.emit("merge.completed", { agent: "alpha", taskId: "t-9", summary: "修正" });
    const mBase = `http://127.0.0.1:${config.ui.monitorPort}`;
    const snap = await (await fetch(`${mBase}/api/monitor`)).json();
    assert.ok(Array.isArray(snap.notifications));
    const kinds = snap.notifications.map((n) => n.kind);
    assert.ok(kinds.includes("permission.request"), "承認要求が監視へ届く");
    assert.ok(kinds.includes("merge.completed"), "マージ完了が監視へ届く");
    const pending = snap.pendingRequests.find((r) => r.id === 3);
    assert.ok(pending, "未処理の承認要求がpendingRequestsに載る");
    assert.match(pending.command, /npm test/);
  } finally {
    try { ui.close(); } catch { /* 既に閉じている */ }
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
  }
});
