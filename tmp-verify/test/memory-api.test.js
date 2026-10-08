// /api/memory(期限切れフラグ付きメモリ一覧)とモニタスナップショットの監査件数の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { startUi, buildMonitorSnapshot } from "../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-memapi-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

test("GET /api/memory: メモリ一覧にexpiredフラグが付く(isMemoryExpired使用)", async () => {
  const ws = mktmp();
  try {
    mkdirSync(join(ws, "memory"), { recursive: true });
    writeFileSync(join(ws, "memory", "fresh.md"), "# 永続\n本文\n", "utf8");
    // ttl: 0d は即時期限切れ(mtime + 0 < now)
    writeFileSync(join(ws, "memory", "stale.md"), "ttl: 0d\n# 寿命切れ\n", "utf8");

    const config = { workspace: ws, ui: { port: 0 }, model: { model: "m" }, agents: [], budget: { maxTokensPerRun: 1 } };
    const ui = await startUi({ config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
    try {
      const r = await fetch(`http://127.0.0.1:${config.ui.port}/api/memory`);
      assert.equal(r.status, 200);
      const body = await r.json();
      const files = body.files ?? body.memory ?? [];
      const fresh = files.find((f) => (f.name ?? f.file ?? f) === "fresh.md" || (f.path ?? "").endsWith("fresh.md"));
      const stale = files.find((f) => (f.name ?? f.file ?? f) === "stale.md" || (f.path ?? "").endsWith("stale.md"));
      assert.ok(fresh && stale, "両ファイルが返る");
      assert.equal(fresh.expired, false);
      assert.equal(stale.expired, true);
    } finally {
      ui.close();
    }
  } finally {
    rmTree(ws);
  }
});

test("モニタスナップショット: state/audit.jsonlの行数がauditCountに入る(無ければ0)", () => {
  const ws = mktmp();
  try {
    const config = { workspace: ws, ui: { port: 0 }, model: { model: "m" }, agents: [], budget: { maxTokensPerRun: 1 } };
    const tasks = new TaskBlackboard(ws, new Bus());
    const base = { config, live: { agents: {}, board: [], threads: [] }, tasks, startedAt: Date.now() };
    const s0 = buildMonitorSnapshot(base);
    assert.equal(s0.auditCount, 0);

    mkdirSync(join(ws, "state"), { recursive: true });
    writeFileSync(join(ws, "state", "audit.jsonl"), '{"a":1}\n{"a":2}\n{"a":3}\n', "utf8");
    const s1 = buildMonitorSnapshot(base);
    assert.equal(s1.auditCount, 3);
  } finally {
    rmTree(ws);
  }
});
