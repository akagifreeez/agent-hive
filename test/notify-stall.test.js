// 通知チャネルの停止系テスト(notify-idle-stall)。
// 停止3種(自動継続停止 round.stalled/ツール失敗停止/予算停止)がwireStallNotify経由で
// onNotifyへ届くこと、設定OFF(enabled:false)のときは何も届かないこと、
// ラウンド静止(全活動がstallSec無音)が1回だけ通知され(静止中の繰り返し無し)、
// 活動再開後に再静止したらまた1回通知されることを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../src/engine/board.js";
import { wireStallNotify } from "../src/notify.js";

test("stall: 自動継続停止(round.stalled)が通知になる", () => {
  const bus = new Bus();
  const got = [];
  const w = wireStallNotify(bus, { onNotify: (n) => got.push(n) });
  bus.emit("round.stalled", { agent: "alpha", reason: "着地ゼロ(進捗なし)", rounds: 3 });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, "round.stall");
  assert.equal(got[0].agent, "alpha");
  assert.match(got[0].title, /着地ゼロ/);
  w.unwire();
});

test("stall: ツール失敗停止と予算停止(agent.status)が通知になる", () => {
  const bus = new Bus();
  const got = [];
  const w = wireStallNotify(bus, { onNotify: (n) => got.push(n) });
  bus.emit("agent.status", { agent: "beta", status: "tool-fail-loop" });
  bus.emit("agent.status", { agent: "gamma", status: "budget-stop" });
  bus.emit("agent.status", { agent: "alpha", status: "working" }); // 停止以外は通知しない
  const kinds = got.map((n) => n.kind).sort();
  assert.deepEqual(kinds, ["budget.stop", "tool.fail.stall"]);
  assert.equal(got.filter((n) => n.kind === "tool.fail.stall")[0].agent, "beta");
  w.unwire();
});

test("stall: enabled:false では停止イベントでも通知しない(設定OFF尊重)", () => {
  const bus = new Bus();
  const got = [];
  const w = wireStallNotify(bus, { enabled: false, onNotify: (n) => got.push(n) });
  bus.emit("round.stalled", { agent: "alpha", reason: "ハード上限", rounds: 3 });
  bus.emit("agent.status", { agent: "beta", status: "tool-fail-loop" });
  bus.emit("agent.status", { agent: "gamma", status: "budget-stop" });
  assert.equal(got.length, 0, "OFF時は停止3種どれも通知しない");
  w.unwire();
});

test("stall: ラウンド静止は1回だけ通知し、静止中は繰り返さない。活動再開で再武装", async () => {
  const bus = new Bus();
  const got = [];
  const w = wireStallNotify(bus, { stallSec: 0.05, onNotify: (n) => got.push(n) });
  // 活動なしで閾値(50ms)超過まで待つ→1回目の静止通知
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(got.length, 1, "静止1回目");
  assert.equal(got[0].kind, "idle.stall");
  // さらに待っても(静止継続でも)2通目は出ない
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(got.length, 1, "静止中の繰り返し通知はしない");
  // 活動があれば再武装され、再び静止するとまた1回だけ通知
  bus.emit("board", { from: "alpha", text: "作業再開" });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(got.length, 1, "活動直後は静止扱いにしない");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(got.length, 2, "再静止したらまた1回通知");
  assert.equal(got[1].kind, "idle.stall");
  w.unwire();
});

test("stall: unwireで静止タイマーと停止リスナが外れる(二重通知しない)", async () => {
  const bus = new Bus();
  const got = [];
  const w = wireStallNotify(bus, { stallSec: 0.05, onNotify: (n) => got.push(n) });
  w.unwire();
  bus.emit("round.stalled", { agent: "alpha", reason: "着地ゼロ", rounds: 1 });
  bus.emit("agent.status", { agent: "beta", status: "tool-fail-loop" });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(got.length, 0, "解放後は何も通知しない");
});
