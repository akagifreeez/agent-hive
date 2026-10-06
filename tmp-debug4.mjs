import { Bus } from "./src/engine/board.js";
import { wireStallNotify } from "./src/notify.js";
const bus = new Bus();
const got = [];
const w = wireStallNotify(bus, { stallSec: 0.05, onNotify: (n) => got.push(n.kind) });
await new Promise((r) => setTimeout(r, 120));  // 静止1回目
console.log(got.length); // 1
await new Promise((r) => setTimeout(r, 120));  // まだ無音
console.log(got.length); // 1 (繰り返しなし)
bus.emit("board", { from: "x" });  // 活動
await new Promise((r) => setTimeout(r, 120));
console.log(got.length, "← ここが2なら活動がmarkされていない"); 
w.unwire();
