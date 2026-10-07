import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";

const ws = mkdtempSync(join(tmpdir(), "hive-rel6-"));
const tasks = new TaskBlackboard(ws, new Bus());
console.log("this.done =", tasks.done);
writeFileSync(join(ws, "tasks", "claimed", "a2--t5.md"), "b\n");
writeFileSync(join(ws, "tasks", "open", "t5.md"), "open\n");
const src = join(tasks.claimed, "a2--t5.md");
console.log("src exists:", (await import("node:fs")).existsSync(src));
try {
  const { renameSync } = await import("node:fs");
  renameSync(src, join(tasks.done, src.split(/[\/]/).pop()));
  console.log("manual rename OK; done:", readdirSync(join(ws, "tasks", "done")));
} catch (e) {
  console.log("manual rename ERR:", e.code, "|", e.message.slice(0, 160));
}
rmSync(ws, { recursive: true, force: true });
