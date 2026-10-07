// イシュー#30の回帰: タスクIDの一意性はopenとclaimedの両方で保たれること。
// 旧実装はopen/<id>.mdだけを見るため、claimedに入ったIDを別本文で再createでき、
// 2エージェントが同じIDを同時請求できていた。done済みIDの再利用は許す(自動再投入の運用)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-taskid-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }

test("#30: claimed中のIDを別本文で再createすると失敗する", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  tasks.create({ id: "dup", body: "1回目の本文" });
  assert.ok(tasks.claim({ id: "alpha", role: null }), "alphaが請求");
  const again = tasks.create({ id: "dup", body: "盗み見した本文で再起票" });
  assert.equal(again, false, "claimed中のIDは再createできない");
  rmTree(ws);
});

test("#30: 2人のagentが同じIDを同時請求できない", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  tasks.create({ id: "shared", body: "共有タスク" });
  assert.ok(tasks.claim({ id: "alpha", role: null }), "1人目は請求できる");
  assert.equal(tasks.claim({ id: "beta", role: null }), null, "2人目は同一IDを請求できない");
  // claimedへ別本文で再createして同等状態を作る抜け道も塞がっている
  assert.equal(tasks.create({ id: "shared", body: "beta用に再起票" }), false);
  assert.equal(tasks.claim({ id: "beta", role: null }), null);
  rmTree(ws);
});

test("#30: done済みIDの再createは許可される(自動再投入・reopenの後方互換)", () => {
  // 契約(477bdde): create()のdone拒否は撤去済み。自動再投入・reopen運用のため、done済みIDの
  // 再createはopenへ復活する。seed再実行での再起票防止(blog lab実害: dependsOn依存解決の
  // 永久ブロック)はseed()側のdone参照で防御するため、二重防御はしない。
  // seed()のdoneスキップ契約は scenario-robustness.test.js の単体テストで担保。
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  tasks.create({ id: "reuse", body: "1回目" });
  tasks.claim({ id: "alpha", role: null });
  tasks.finish({ id: "alpha" }, "reuse");
  const recreated = tasks.create({ id: "reuse", body: "2回目(再投入)" });
  assert.equal(recreated, true, "done済みIDの再createは許可(後方互換)");
  assert.equal(existsSync(join(ws, "tasks", "open", "reuse.md")), true, "openへ復活する");
  rmTree(ws);
});

test("#30: open中のIDの再createも従来どおり失敗する(後方互換)", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  assert.equal(tasks.create({ id: "x", body: "1" }), true);
  assert.equal(tasks.create({ id: "x", body: "2" }), false);
  rmTree(ws);
});
