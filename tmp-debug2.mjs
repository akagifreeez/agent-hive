// debug: emit→listener呼ばれるか
import { Bus } from "./src/engine/board.js";
const bus = new Bus();
bus.on("board", (p) => console.log("GOT board event"));
bus.emit("board", { from: "x" });
console.log("emitted");
