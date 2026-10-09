// イシュー#30の回帰: タスクIDの一意性はopenとclaimedの両方で保たれること。
// 旧実装はopen/<id>.mdだけを見るため、claimedに入ったIDを別本文で再createでき、
// 2エージェントが同じIDを同時請求できていた。done済みIDの再起票はスキップ(再起票の永久ブロック防止。2026-10 #30契約)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, unlinkSync, readFileSync } from "node:fs";
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

test("#30: done済みIDの再createは許可(現行契約・自動再投入運用)", () => {
  // 現行契約(477bdde): create()はopen/claimedのみ一意性を見る。done再createは自動再投入・
  // reopen運用の後方互換として許可。seed再実行での再起票防止はseed()側のdone参照で防御
  // (blog lab実害: dependsOn依存解決の永久ブロック)。
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  tasks.create({ id: "reuse", body: "1回目" });
  tasks.claim({ id: "alpha", role: null });
  tasks.finish({ id: "alpha" }, "reuse");
  // done済みIDの再createはfalse(blog lab実害: seed再実行でdoneがopenへ再起票され、
  // dependsOn依存解決が永久ブロックした)。再請求は起動時回収(宙吊り解放)が担う。
  const recreated = tasks.create({ id: "reuse", body: "2回目(再投入)" });
  assert.equal(recreated, true, "done済みIDの再createは許可(後方互換)");
  assert.equal(existsSync(join(ws, "tasks", "open", "reuse.md")), true, "openへ再起票される");
  rmTree(ws);
});

test("#30: open中のIDの再createも従来どおり失敗する(後方互換)", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  assert.equal(tasks.create({ id: "x", body: "1" }), true);
  assert.equal(tasks.create({ id: "x", body: "2" }), false);
  rmTree(ws);
});

test("#30: 未請求(open/claimed無し)IDの再createは許可される(自動再投入の運用維持)", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  assert.equal(tasks.create({ id: "fresh", body: "初回" }), true);
  // 宙吊り回収等でopenから消えた(未請求)IDはdone/claimedのどこにも無い → 再投入(本文更新)を許す
  unlinkSync(join(ws, "tasks/open/fresh.md"));
  assert.equal(tasks.create({ id: "fresh", body: "再投入された本文" }), true, "未請求IDの再createは成功");
  assert.match(readFileSync(join(ws, "tasks/open/fresh.md"), "utf8"), /再投入された本文/, "本文が更新される");
  rmTree(ws);
});
