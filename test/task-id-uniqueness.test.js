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
});
