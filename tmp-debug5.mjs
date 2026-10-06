// markリスナが呼ばれているか直接観測
import { Bus } from "./src/engine/board.js";
import { wireStallNotify } from "./src/notify.js";
const bus = new Bus();
let markCalls = 0;
const origOn = bus.on.bind(bus);
bus.on = (type, fn) => {
  if (type === "board") {
    return origOn(type, (p) => { markCalls++; console.log("MARK called at", Date.now() % 100000); return fn(p); });
  }
  return origOn(type, fn);
};
const got = [];
const w = wireStallNotify(bus, { stallSec: 0.05, onNotify: (n) => got.push(n.kind) });
await new Promise((r) => setTimeout(r, 120));
console.log("stall1:", got.length);
bus.emit("board", { from: "x" });
console.log("after emit, markCalls:", markCalls);
await new Promise((r) => setTimeout(r, 120));
console.log("final:", got.length);
w.unwire();
