// node:test runner配下でどうなるか: test登録だけして中でtask blackboardを作る
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";

test("runner配下でのtask動作", async () => {
  const base = mkdtempSync(join(tmpdir(), "runner-"));
  try {
    const ws = join(base, "wt");
    mkdirSync(ws, { recursive: true });
    const bus = new Bus();
    const tasks = new TaskBlackboard(ws, bus);
    const created = tasks.create({ id: "t1", role: null, body: "b" });
    assert.ok(created, "create成功");
    assert.equal(readdirSync(join(ws, "tasks/open")).join(","), "t1.md", "open即時");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
