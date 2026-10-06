// emit board の直後に checkStall 相当を自前で回し、lastActivity更新の即時性を検証
import { Bus } from "./src/engine/board.js";
import { wireStallNotify } from "./src/notify.js";
const bus = new Bus();
const got = [];
const w = wireStallNotify(bus, { stallSec: 0.05, onNotify: (n) => got.push(n.kind) });
await new Promise((r) => setTimeout(r, 120));
console.log("stall1:", got.length);
// 静止検出後すぐ(同ティック内)にemit
setImmediate(() => {
  bus.emit("board", { from: "x" });
  console.log("emitted at", Date.now() % 100000);
});
await new Promise((r) => setTimeout(r, 30));
console.log("t+30ms:", got.length, "期待1(活動で再武装されたので通知なし)");
await new Promise((r) => setTimeout(r, 100));
console.log("final:", got.length, "期待2(再静止)");
w.unwire();
