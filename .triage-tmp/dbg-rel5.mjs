import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";

const ws = mkdtempSync(join(tmpdir(), "hive-rel5-"));
const tasks = new TaskBlackboard(ws, new Bus());
mkdirSync(join(ws, "tasks", "claimed"), { recursive: true });
writeFileSync(join(ws, "tasks", "claimed", "a2--t4.md"), "b\n");
writeFileSync(join(ws, "tasks", "open", "t4.md"), "open\n");
console.log("pre claimed:", readdirSync(join(ws, "tasks", "claimed")));
const r = tasks.releaseOne("a2", "t4", null);
console.log("no-note dup-open ->", r);
console.log("done:", readdirSync(join(ws, "tasks", "done")));
console.log("claimed:", readdirSync(join(ws, "tasks", "claimed")));
console.log("open:", readdirSync(join(ws, "tasks", "open")));
rmSync(ws, { recursive: true, force: true });
