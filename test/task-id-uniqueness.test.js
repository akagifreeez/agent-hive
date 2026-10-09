<<<<<<< HEAD
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
=======
// タスクIDの一意性(イシュー#30): createはopenだけでなくclaimed中のIDも拒否する。
// claimed中のIDを別本文で再createできると、2人のagentが同じIDを同時請求できてしまう。
// done済みIDの再作成は許可(自動再投入・正常な再利用経路)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";

function mkbb() {
  const ws = mkdtempSync(join(tmpdir(), "hive-taskid-"));
  const bb = new TaskBlackboard(ws, new Bus());
  return { ws, bb };
}

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }

test("create: claimed中のIDは再createできない(別本文でも)", () => {
  const { ws, bb } = mkbb();
  try {
    assert.equal(bb.create({ id: "job-x", body: "v1" }), true);
    // alphaがclaim(open→claimedへrename)
    const got = bb.claim({ id: "alpha", role: null });
    assert.equal(got?.id, "job-x");
    // beta環境で同じIDを別本文で再create → 拒否
    assert.equal(bb.create({ id: "job-x", body: "v2別本文" }), false, "claimed中のIDの再createはfalse");
    // claimed側にbeta--job-x.mdが生えておらず、alphaのclaimedだけが存在
    const claimed = readdirSync(bb.claimed).filter((f) => f.includes("job-x"));
    assert.deepEqual(claimed, ["alpha--job-x.md"]);
    // open側にもv2の複製は無い
    assert.equal(existsSync(join(bb.open, "job-x.md")), false);
  } finally { rmTree(ws); }
});

test("create: 同一IDの同時請求は1人だけ成功する(renameの原子性)", () => {
  const { ws, bb } = mkbb();
  try {
    bb.create({ id: "race-y", body: "work" });
    const a = bb.claim({ id: "alpha", role: null });
    const b = bb.claim({ id: "beta", role: null });
    // 先着1人だけがrace-yを取り、他方はnull(または別タスク)
    const gotY = [a?.id, b?.id].filter((x) => x === "race-y");
    assert.equal(gotY.length, 1, "同じIDを同時請求できるのは1人だけ");
    // どちらかが取った後、もう一方が同じIDをcreateして奪い直せない
    assert.equal(bb.create({ id: "race-y", body: "複製" }), false);
  } finally { rmTree(ws); }
});

test("create: done済みIDの再作成は通る(自動再投入の再利用経路を壊さない)", () => {
  const { ws, bb } = mkbb();
  try {
    bb.create({ id: "recur-z", body: "1回目" });
    const a = bb.claim({ id: "alpha", role: null });
    assert.equal(a?.id, "recur-z");
    assert.equal(bb.finish({ id: "alpha" }, "recur-z"), true);
    // doneになったので同じIDを再createできる
    assert.equal(bb.create({ id: "recur-z", body: "2回目" }), true, "done済みIDの再createは許可");
    assert.equal(existsSync(join(bb.open, "recur-z.md")), true);
  } finally { rmTree(ws); }
});

test("create: openに残っているIDの再createは従来どおりfalse(既存動作の維持)", () => {
  const { ws, bb } = mkbb();
  try {
    assert.equal(bb.create({ id: "dup-w", body: "v1" }), true);
    assert.equal(bb.create({ id: "dup-w", body: "v2" }), false, "open中の二重起票はfalseのまま");
    // existsOpenOrClaimedの既存契約も不変
    assert.equal(bb.existsOpenOrClaimed("dup-w"), true);
    assert.equal(bb.existsOpenOrClaimed("無いやつ"), false);
  } finally { rmTree(ws); }
>>>>>>> agent/impl-76
});
