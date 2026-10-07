import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBoard } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";
const ws = mkdtempSync(join(tmpdir(), "hive-rel3-"));
const t = new TaskBoard(ws, new Bus());
console.log("exists done dir:", readdirSync(join(ws, "tasks")));
rmSync(ws, { recursive: true, force: true });
