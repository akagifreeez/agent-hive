// イシュー#30: タスクIDの一意性がopenだけしか守られていなかった修正の回帰テスト。
// (1)claimed中のIDを再createしようとすると失敗する (2)2人のagentが同じIDを同時請求できない
// (3)done済みIDの再createは通る(自動再投入等の既存運用を壊さない)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-task-uniqueness-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ }
}

test("create: 請求中(claimed)のIDを再createすると失敗する", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  try {
    tasks.create({ id: "dup-1", body: "最初の本文" });
    assert.ok(tasks.claim({ id: "alpha", role: null }), "alphaが請求");
    // claimedに入ったIDを別本文で再create → 拒否される(修正前は通ってしまっていた)
    assert.equal(tasks.create({ id: "dup-1", body: "別本文で再投入" }), false, "claimed中IDの再createは失敗");
    // 本文がすり替わっていないこと(最初の本文のまま)
    const got = tasks.claimedBy("alpha")[0];
    assert.match(got.body, /最初の本文/, "請求中タスクの本文はすり替わらない");
  } finally {
    rmTree(ws);
  }
});

test("claim: 2人のagentが同じIDを同時請求できない(open単一ファイルの原子的rename)", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  try {
    tasks.create({ id: "dup-2", body: " 共通仕事 " });
    const gotA = tasks.claim({ id: "alpha", role: null });
    assert.ok(gotA, "alphaが請求");
    // openから消えているのでbeta環境では請求できない
    assert.equal(tasks.claim({ id: "beta", role: null }), null, "betaは同じIDを請求できない");
    // 仮にbeta環境のcreate_task(beta--dup-2)が成立しても、openの実体は1つのまま
    assert.equal(tasks.create({ id: "dup-2", body: "beta側から再投入" }), false);
    assert.equal(tasks.snapshot().open.filter((f) => f === "dup-2.md").length, 0);
  } finally {
    rmTree(ws);
  }
});

test("create: done済みIDの再createは通る(自動再投入の既存運用を維持)", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  try {
    tasks.create({ id: "dup-3", body: "一回目" });
    tasks.claim({ id: "alpha", role: null });
    tasks.finish({ id: "alpha" }, "dup-3");
    assert.ok(tasks.create({ id: "dup-3", body: "二回目(再投入)" }), "done済みIDの再createは成功");
    assert.equal(tasks.snapshot().open.includes("dup-3.md"), true, "再投入されたタスクはopenに戻る");
  } finally {
    rmTree(ws);
  }
});

test("assign: 同IDが他者請求中なら拒否され、自分自身の再assignは冪等に失敗", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  try {
    // 自分自身の同ID再assign: 従来どおりfalse(冪等)
    assert.equal(tasks.assign({ agentId: "alpha", taskId: "spawn-1", body: "1回目" }), true);
    assert.equal(tasks.assign({ agentId: "alpha", taskId: "spawn-1", body: "2回目" }), false);
    // 他者が同一IDをassign: 拒否(二重請求の発生を防ぐ)
    assert.equal(tasks.assign({ agentId: "beta", taskId: "spawn-1", body: "betaが横取り" }), false);
    assert.equal(tasks.claimedBy("beta").length, 0, "betaには何も付かない");
    // claimed中のIDをopenへcreateする経路も拒否
    assert.equal(tasks.create({ id: "spawn-1", body: "open側へ" }), false);
  } finally {
    rmTree(ws);
  }
});

// #30 blog lab実害対策の契約固定(2026-10-07 npm test不整合議論の収束)。現行契約(477bdde):
// create()はopen/claimedのみ一意性を見る(done済みIDの直接再create=reopen許可)。
// 再実行での再起票防止はseed()側のdone参照スキップで防御する(dependsOn依存解決の永久ブロック防止)。
test("seed: done済みIDは再起票されず、open/claimedへ複製されない(#30 blog lab実害の防御固定)", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  try {
    const seedTasks = [
      { id: "seed-a", body: "先行タスク", project: "pg" },
      { id: "seed-b", body: "後続タスク", project: "pg", dependsOn: ["seed-a"] },
    ];
    tasks.seed(seedTasks);
    const alpha = tasks.claim({ id: "alpha", role: null }, { project: "pg" });
    assert.ok(alpha && alpha.id === "seed-a", "先行タスクを請求");
    tasks.finish({ id: "alpha" }, "seed-a");
    // 同一シードの再実行: done済みのseed-aはスキップされ、openへ複製されない
    tasks.seed(seedTasks);
    assert.equal(tasks.snapshot().open.filter((f) => f.startsWith("seed-a")).length, 0, "done済みIDはopenへ再起票されない");
    assert.equal(tasks.list().open.filter((t) => t.id === "seed-a").length, 0, "list()にもseed-aは現れない");
    assert.equal(tasks.snapshot().done.filter((f) => f.endsWith("--seed-a.md") || f === "seed-a.md").length, 1, "doneの実体は1つのまま(複製されない)");
    // 後続タスクは依存解決されて請求できる(open複製に阻まれない=永久ブロックの再発防止)
    const beta = tasks.claim({ id: "beta", role: null }, { project: "pg" });
    assert.ok(beta && beta.id === "seed-b", "依存完了の後続タスクは請求できる(永久ブロックなし)");
  } finally {
    rmTree(ws);
  }
});

test("seed: 未完了(open)IDの再seedは既存タスクを保護し重複起票しない(create拒否の契約)", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws, new Bus());
  try {
    tasks.seed([{ id: "keep-open", body: "1巡目の本文", project: "pg2" }]);
    tasks.seed([{ id: "keep-open", body: "2巡目の本文(更新)", project: "pg2" }]);
    assert.equal(tasks.snapshot().open.filter((f) => f === "keep-open.md").length, 1, "openの実体は1つ(重複起票されない)");
    const got = tasks.claim({ id: "gamma", role: null }, { project: "pg2" });
    assert.ok(got && got.body.includes("1巡目の本文"), "再seedしても既存(open)の本文は上書きされない");
  } finally {
    rmTree(ws);
  }
});
