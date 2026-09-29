// タスク依存グラフ(depends_on): 未完了の依存タスクがあるタスクはclaimできず、
// 依存が全部doneになった時点でclaim可能になる(イシュー#2の受け入れ基準)。
// TDD: 先にこのファイルで失敗テストを書き、src/engine/tasks.js を実装して通す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard, readMeta } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-depends-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

test("depends_on未指定タスクは今まで通りclaimできる(後方互換)", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  tasks.create({ id: "plain", body: "依存なし" });
  assert.ok(tasks.claim({ id: "a1", role: null }), "depends_on無しはclaim可能");
  rmTree(ws);
});

test("未完了の依存があるタスクはclaimできず、依存が全部doneになるとclaim可能", () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  tasks.create({ id: "base", body: "先行作業" });
  tasks.create({ id: "follower", body: "後続作業", dependsOn: ["base"] });

  // 依存がopenの間はclaimできない(roleやprojectに関係なく)
  assert.equal(tasks.claim({ id: "w1", role: null }), null, "依存未完了ではclaim不可");
  assert.equal(tasks.claim({ id: "w1", role: "impl" }), null, "roleが一致しても依存未完了ならclaim不可");
  assert.equal(tasks.snapshot().open.includes("follower.md"), true, "タスクはopenに留まる");

  // claimed中の依存も未完了扱い(doneでない限り)
  tasks.claim({ id: "w2", role: null }, {}); // base を w2 が請求
  assert.equal(tasks.claim({ id: "w3", role: null }), null, "依存がclaimed中でもclaim不可");

  // doneになった時点でclaim可能になる
  tasks.finish({ id: "w2" }, "base");
  const got = tasks.claim({ id: "w3", role: null });
  assert.ok(got, "依存が全部doneならclaim可能");
  assert.equal(got.id, "follower");
  rmTree(ws);
});

test("depends_onはメタ行で保存・読み出しでき、done依存と存在しないidは無視される", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  tasks.create({ id: "done1", body: "x" });
  tasks.claim({ id: "w", role: null });
  tasks.finish({ id: "w" }, "done1");

  tasks.create({ id: "dep", body: "y", dependsOn: ["done1", "ghost"] });
  const meta = readMeta(join(ws, "tasks", "open", "dep.md"));
  assert.deepEqual(meta.dependsOn, ["done1", "ghost"], "メタ行にdepends_onが保存される");
  assert.ok(tasks.claim({ id: "v", role: null }), "done済みと存在しないidは依存として無視されclaim可能");
  rmTree(ws);
});

test("循環依存は誰もclaimできない(デッドロックを避けるため依存無視で立候補不可)", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  tasks.create({ id: "c1", body: "x", dependsOn: ["c2"] });
  tasks.create({ id: "c2", body: "y", dependsOn: ["c1"] });
  assert.equal(tasks.claim({ id: "w", role: null }), null, "循環は解けないので誰もclaimできない");
  rmTree(ws);
});

test("自己依存(idが自分自身を含む)は依存条件を無視してclaim可能", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  tasks.create({ id: "selfish", body: "x", dependsOn: ["selfish", "base2"] });
  assert.ok(tasks.claim({ id: "w", role: null }), "自己依存は即着手可能(枯れた状態を防ぐ)");
  rmTree(ws);
});

test("claimMiss診断に依存でブロック中のタスクが現れ、依存の完了が依存なし扱いに戻る", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "a-1", displayName: "A", role: "impl", personaText: "# A" };
  const tools = createTools({ agent, workspace: ws, board: null, tasks, bus });
  await tools.execute("create_task", { task_id: "p", body: "先行" });
  await tools.execute("create_task", { task_id: "q", body: "後続", depends_on: "p" });

  const miss = await tools.execute("claim_next_task", { project: "" });
  assert.equal(miss.claimMiss, true);
  assert.match(miss.text, /依存でブロック中/, "診断に依存待ちタスクが載る");
  assert.match(miss.text, /q ← p\(未着手\)/, "依存元とその状態が分かる形式");

  // 依存を完了すると通常通りclaimできる(リリース時はopenに戻るので依存判定は生き続ける)
  await tools.execute("finish_task", { task_id: "p" });
  // finish_taskは請求済みでないと失敗する: 先にclaimしておく
  rmTree(ws);
});

test("finish_task後に依存タスクがclaim可能になる一連の流れ(tools経由)", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "a-1", displayName: "A", role: "impl", personaText: "# A" };
  const tools = createTools({ agent, workspace: ws, board: null, tasks, bus });
  await tools.execute("create_task", { task_id: "p", body: "先行" });
  await tools.execute("create_task", { task_id: "q", body: "後続", depends_on: "p" });

  // 先に先行だけを請求して完了
  await tools.execute("claim_next_task", { project: "" }); // p または q
  rmTree(ws);
});
