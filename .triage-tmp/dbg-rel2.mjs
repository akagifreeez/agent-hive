import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";

const ws = mkdtempSync(join(tmpdir(), "hive-rel2-"));
const tasks = new TaskBlackboard(ws, new Bus());
tasks.create({ id: "t2", project: "x", body: "b" });
tasks.claim({ id: "a1", role: null });
mkdirSync(join(ws, "tasks", "done"), { recursive: true });
console.log("dirs ok");
// releaseOne直後のopen既存ケースを再現
writeFileSync(join(ws, "tasks", "claimed", "a2--t2.md"), "project: x\n\nb\n");
writeFileSync(join(ws, "tasks", "open", "t2.md"), "project: x\n\nb already open\n");
const ok = tasks.releaseOne("a2", "t2", "note");
console.log("releaseOne dup-open ->", ok);
console.log("claimed:", readdirSync(join(ws, "tasks", "claimed")));
console.log("open:", readdirSync(join(ws, "tasks", "open")));
console.log("done:", readdirSync(join(ws, "tasks", "done")));
rmSync(ws, { recursive: true, force: true });
