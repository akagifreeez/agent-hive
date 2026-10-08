// タスクの受け入れ基準(acceptance)メタ: 起票→請求→一覧で一貫して扱えること
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard, readMeta } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-acc-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

test("TaskBlackboard: acceptanceをメタ行で保存し、claimの本文に載り、listに現れる", () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);

  tasks.create({ id: "acc-1", role: "impl", project: "demo", body: "仕事の本文", acceptance: "npm test が通り、境界の両側を検証していること\n(複数行は1行に潰す)" });
  const raw = readFileSync(join(ws, "tasks", "open", "acc-1.md"), "utf8");
  assert.match(raw, /^acceptance: npm test が通り、境界の両側を検証していること \(複数行は1行に潰す\)$/m);

  const meta = readMeta(join(ws, "tasks", "open", "acc-1.md"));
  assert.equal(meta.acceptance, "npm test が通り、境界の両側を検証していること (複数行は1行に潰す)");

  const claimed = tasks.claim({ id: "demo-alpha", role: "impl" }, { project: "demo" });
  assert.ok(claimed.body.includes("acceptance: npm test が通り"), "claimの本文にacceptance行が含まれる");

  const list = tasks.list().open;
  assert.equal(list.length, 0); // 請求済み
  const cl = tasks.list().claimed;
  assert.equal(cl[0].acceptance, "npm test が通り、境界の両側を検証していること (複数行は1行に潰す)");

  rmTree(ws);
});

test("create_taskツール: acceptance引数が保存され、claim_next_taskの返値で目立って提示される", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "a-1", displayName: "エー", role: "impl", personaText: "# A" };
  const tools = createTools({ agent, workspace: ws, board: null, tasks, bus });

  const cr = await tools.execute("create_task", { task_id: "acc-2", body: "指示本文", project: "demo", acceptance: "テストが通ること" });
  assert.equal(cr.ok, true);
  assert.match(cr.text, /受け入れ基準つき/);
  assert.ok(existsSync(join(ws, "tasks", "open", "acc-2.md")));

  const claim = await tools.execute("claim_next_task", { project: "demo" });
  assert.equal(claim.ok, true);
  assert.match(claim.text, /受け入れ基準: テストが通ること/);
  assert.match(claim.text, /タスク acc-2 を請求しました/);

  // acceptance無しの従来型でもエラーにならない
  const cr2 = await tools.execute("create_task", { task_id: "plain-1", body: "指示のみ" });
  assert.equal(cr2.ok, true);
  const claim2 = await tools.execute("claim_next_task", {});
  assert.equal(claim2.ok, true);
  assert.doesNotMatch(claim2.text, /受け入れ基準:/);

  rmTree(ws);
});
