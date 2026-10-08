// タスクIDの一意性(イシュー#30の回帰テスト)。
// create()はopenだけでなくclaimedも見て重複を拒否する。doneは再利用を許す
// (自動再投入・reopen運用と整合。openへ戻るのはreopen()経由で排他は保たれる)。
// TDD: 先にこのファイルで失敗テストを書き、src/engine/tasks.js を実装して通す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-taskuniq-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

test("claimed中のIDを再createすると拒否される(別本文でも)", () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);

  tasks.create({ id: "dup-1", body: "最初の仕事" });
  const claimed = tasks.claim({ id: "alpha", role: null });
  assert.equal(claimed?.id, "dup-1");

  // alphaが請求中のIDをbeta環境で再create → false
  assert.equal(tasks.create({ id: "dup-1", body: "全く別の本文" }), false);
  // openに新規ファイルが作られていないこと
  assert.equal(tasks.snapshot().open.includes("dup-1.md"), false);
  // claimedのファイルはalphaのまま(書き換えられていない)
  const info = tasks.list().claimed.find((t) => t.id === "dup-1");
  assert.equal(info.agent, "alpha");
  rmTree(ws);
});

test("2人のagentが同じIDを同時請求できない(原子性はrenameで担保・回帰)", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  tasks.create({ id: "race-1", body: "競合の仕事" });

  const got1 = tasks.claim({ id: "alpha", role: null });
  const got2 = tasks.claim({ id: "beta", role: null });
  assert.ok(got1, "1人目は請求できる");
  assert.equal(got2, null, "2人目は請求できない");
  // 同時create競合でも単一のclaimed実体しか無い
  assert.equal(tasks.list().claimed.filter((t) => t.id === "race-1").length, 1);
  rmTree(ws);
});

<<<<<<< HEAD
test("done済みIDの再createはスキップされる(done再起票の永久ブロック防止)", () => {
=======
test("done済みIDの再createは許可される(現行契約・自動再投入運用)", () => {
>>>>>>> main
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  tasks.create({ id: "done-1", body: "1巡目" });
  tasks.claim({ id: "w", role: null });
  tasks.finish({ id: "w" }, "done-1");
  assert.equal(tasks.list().done.filter((t) => t.id === "done-1").length, 1);

<<<<<<< HEAD
  // done済みIDの再createはfalse(seed再実行でdependsOn依存解決が永久ブロックする実害対策)。
  // 自動再投入は起動時回収(宙吊りclaimed解放)経路で担保される。
  assert.equal(tasks.create({ id: "done-1", body: "2巡目として再投入" }), false);
  assert.equal(tasks.snapshot().open.some((f) => f === "done-1.md"), false);
  assert.equal(tasks.list().done.filter((t) => t.id === "done-1").length, 1, "done実体は1件のまま");
=======
  // 契約(477bdde): create()はopen/claimedのみ一意性を見る。done再createは自動再投入・
  // reopen運用の後方互換として許可(openへ復活)。seed再実行での再起票防止はseed()側の
  // done参照で防御(blog lab実害: dependsOn依存解決の永久ブロック)ため二重防御はしない。
  const recreated = tasks.create({ id: "done-1", body: "2巡目として再投入" });
  assert.equal(recreated, true, "done済みIDの再createは許可(後方互換)");
  assert.equal(tasks.snapshot().open.some((f) => f === "done-1.md"), true, "openへ再起票される");
>>>>>>> main
  rmTree(ws);
});

test("openに既存のIDの再createは従来どおり拒否される", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  tasks.create({ id: "open-1", body: "既存" });
  assert.equal(tasks.create({ id: "open-1", body: "重複" }), false);
  rmTree(ws);
});
