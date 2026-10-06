import { Bus } from "./src/engine/board.js";
import { wireStallNotify } from "./src/notify.js";
const bus = new Bus();
const got = [];
const w = wireStallNotify(bus, { stallSec: 0.05, onNotify: (n) => got.push(n.kind) });
// 直後に活動→静止扱いがリセットされるか(=markが届いているか)を、
// 閾値を超える前のタイミングで確認
await new Promise((r) => setTimeout(r, 10));
bus.emit("board", { from: "x" });
await new Promise((r) => setTimeout(r, 30));
console.log("t=40ms (last activity 30ms ago):", got.length); // まだ静止でない→0
await new Promise((r) => setTimeout(r, 40));
console.log("t=80ms (last activity 70ms ago):", got.length); // 静止→1
w.unwire();
