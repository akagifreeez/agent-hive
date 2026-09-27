// 監査台帳ビューア: GET /api/audit で state/audit.jsonl を新しい順で読む
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { startUi } from "../src/ui/server.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-auditapi-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

function mkConfig(ws) {
  return { workspace: ws, ui: { port: 0 }, model: { model: "test" }, agents: [], budget: { maxTokensPerRun: 1 } };
}

async function fetchJson(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json() };
}

test("GET /api/audit: ツール実行後に記録が読める(新しい順・limit)", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "a-1", displayName: "エー", role: "impl", personaText: "# A" };
  const tools = createTools({ agent, workspace: ws, mainWorkspace: ws, board: null, tasks, bus });
  await tools.execute("write_file", { path: "notes/hello.txt", content: "hi" });
  await tools.execute("bash", { command: "echo audit-api" });

  const config = mkConfig(ws);
  const ui = await startUi({ config, modelFactory: () => ({}), bus, autoStart: false });
  const base = `http://127.0.0.1:${config.ui.port}`;
  try {
    const r = await fetchJson(`${base}/api/audit`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.audit));
    assert.equal(r.body.audit.length, 2);
    // 新しい順: 先頭は最後のbash実行
    assert.equal(r.body.audit[0].tool, "bash");
    assert.equal(r.body.audit[0].cmd, "echo audit-api");
    assert.equal(r.body.audit[0].ok, true);
    assert.equal(r.body.audit[0].agent, "a-1");
    assert.equal(r.body.audit[1].tool, "write_file");
    assert.equal(r.body.audit[1].path, "notes/hello.txt");
    // limit指定
    const r2 = await fetchJson(`${base}/api/audit?limit=1`);
    assert.equal(r2.body.audit.length, 1);
    assert.equal(r2.body.audit[0].tool, "bash");
    // tsはISO時刻
    assert.ok(!Number.isNaN(Date.parse(r.body.audit[0].ts)));
  } finally {
    ui.close();
    rmTree(ws);
  }
});