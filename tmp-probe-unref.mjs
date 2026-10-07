import { wireCliNotify, wireStallNotify } from "./src/notify.js";
import { Bus } from "./src/engine/board.js";

const mode = process.argv[2] === "false" ? false : true;
const bus = new Bus();
const w1 = wireCliNotify(bus, {});
const w2 = wireStallNotify(bus, { enabled: mode, stallSec: 0.05 });
setTimeout(() => { try { w1.unwire(); } catch {} try { w2.unwire(); } catch {} }, 50);
