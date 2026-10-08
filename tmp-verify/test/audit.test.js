// 監査台帳(state/audit.jsonl): 全ツール実行が1行JSONで残ること(MassGen手本)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-audit-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

function readAudit(ws) {
  return readFileSync(join(ws, "state", "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("監査台帳: 成功・失敗がagent/tool/ok付きで記録され、bashはコマンドも残す", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "a-1", displayName: "エー", role: "impl", personaText: "# A" };
  const tools = createTools({ agent, workspace: ws, mainWorkspace: ws, board: null, tasks, bus });

  await tools.execute("write_file", { path: "notes/hello.txt", content: "hi" });
  await tools.execute("read_file", { path: "notes/missing.txt" }); // 失敗も記録する
  await tools.execute("bash", { command: "echo audit-ok" });
  await tools.execute("unknown_tool_x", {});

  const entries = readAudit(ws);
  assert.equal(entries.length, 4);
  assert.ok(entries.every((e) => e.agent === "a-1" && typeof e.ms === "number" && e.ts));

  const wf = entries.find((e) => e.tool === "write_file");
  assert.equal(wf.ok, true);
  assert.equal(wf.path, "notes/hello.txt");

  const rf = entries.find((e) => e.tool === "read_file");
  assert.equal(rf.ok, false, "失敗したread_fileもok:falseで記録");

  const sh = entries.find((e) => e.tool === "bash");
  assert.equal(sh.ok, true);
  assert.equal(sh.cmd, "echo audit-ok");

  const unk = entries.find((e) => e.tool === "unknown_tool_x");
  assert.equal(unk.ok, false);
  assert.match(unk.brief, /未知のツール/);

  rmTree(ws);
});

test("監査台帳: hooksでブロックされた実行はblocked:trueで残る", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "a-2", displayName: "ビー", role: "impl", personaText: "# A" };
  const hooks = {
    has: () => true,
    run: async () => ({ blocked: true, text: "禁止パターン" }),
  };
  const tools = createTools({ agent, workspace: ws, mainWorkspace: ws, board: null, tasks, bus, hooks });

  const r = await tools.execute("bash", { command: "rm -rf /" });
  assert.equal(r.ok, false);
  const entries = readAudit(ws);
  const e = entries.find((x) => x.tool === "bash");
  assert.equal(e.blocked, true);
  assert.equal(e.ok, false);
  assert.equal(e.cmd, "rm -rf /");

  rmTree(ws);
});

test("監査台帳: 5MB超で1世代ローテートする", async () => {
  const ws = mktmp();
  const dir = join(ws, "state");
  mkdirSync(dir, { recursive: true });
  // 閾値超のダミー台帳を先に置く(5MB+1バイト)。ローテート検証はサイズ閾値の单元テスト
  writeFileSync(join(dir, "audit.jsonl"), "x".repeat(5 * 1024 * 1024 + 1));
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "a-3", displayName: "シー", role: "impl", personaText: "# A" };
  const tools = createTools({ agent, workspace: ws, mainWorkspace: ws, board: null, tasks, bus });

  await tools.execute("list_files", {});
  assert.ok(existsSync(join(dir, "audit-1.jsonl")), "閾値超過の1件は旧世代ごと退避する");
  // 次の1件から新しい世代の台帳に載る
  await tools.execute("list_files", {});
  const entries = readAudit(ws);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool, "list_files");

  rmTree(ws);
});
