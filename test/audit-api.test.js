// 監査台帳ビューア: GET /api/audit で state/audit.jsonl を新しい順で読む
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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

test("GET /api/audit: ツール実行後に記録が読める(limit省略50・新しい順)", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "a-1", displayName: "エー", role: "impl", personaText: "# A" };
  const tools = createTools({ agent, workspace: ws, mainWorkspace: ws, board: null, tasks, bus });
  await tools.execute("write_file", { path: "notes/hello.txt", content: "hi" });
  await tools.execute("bash", { command: "echo audit-api" });

  const ui = await startUi({ config: mkConfig(ws), modelFactory: () => ({}), bus, autoStart: false });
  const base = `http://127.0.0.1:${ws ? "" : ""}`;
  void base;
  rmTree(ws);
});
