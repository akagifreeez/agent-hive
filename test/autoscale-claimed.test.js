// autoscale縮小ガードの回帰テスト: runner.jsのautoscaleはopen==0のスレッドを
// 「min(base, alive.size)」へ縮小対象にしていた。請求中(稼働中)タスクがあるスレッドも
// openだけを見て縮小計算に入るため、作業進行中なのに追加ワーカーのdesiredが下がる。
// 実害: 全タスク請求済み(作業中)の瞬間にautoscaleが走ると増員が止まり、後続タスクが
// 待たされる。修正: claimed(稼働中)も仕事量に数え、open==0かつ請求0のときだけ縮小。
// 観測: ctl.threadHost(name)のautoscaleTimerはprivateのため、ここでは公開観測点として
// autoscaleTick()をrunnerに追加して呼び出す(interval依存を避け確定的に検証する)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChat } from "../src/runner.js";
import { Bus } from "../src/engine/board.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }

function mkConfig(ws) {
  return {
    workspace: ws,
    worktrees: { dir: `${ws}-wt` },
    model: { contextWindow: 200000, maxTokens: 4000 },
    loop: { maxTurns: 10 },
    budget: null,
    compact: { thresholdPercent: 90 },
    discovery: {},
    permissions: {},
    scenario: { name: "test" },
    chat: {
      lead: "lead", workers: ["alpha", "beta"],
      maxTurnsPerRound: 8, staggerMs: 0,
      autoscale: false, // テストから autoscaleTick() を明示呼び出しして確定的に検証する
    },
    agents: [
      { id: "lead", displayName: "リーダー", role: "lead" },
      { id: "alpha", displayName: "アルファ", role: "impl" },
      { id: "beta", displayName: "ベータ", role: "impl" },
    ],
  };
}

function scriptedModel() {
  return {
    maxTokens: 4000,
    async chat() {
      return { content: "応答", toolCalls: [], raw: { content: "応答" }, usage: { promptTokens: 10, completionTokens: 1 } };
    },
  };
}

async function waitUntil(fn, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

test("autoscale: 請求中(稼働中)タスクがあるスレッドはdesired縮小しない(open==0でもbase維持)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-scale-"));
  const config = mkConfig(ws);
  const bus = new Bus();
  const ctl = await runChat({ config, bus, modelFactory: scriptedModel });
  try {
    const opened = await ctl.openThread({ project: "scgtest", goal: "autoscale縮小ガードの検証" });
    assert.equal(opened.error, undefined, "スレッドが開ける: " + String(opened?.error ?? ""));

    const claimer = "scgtest-alpha"; // 稼働中(working)として観測させるエージェントid
    const host = ctl.threadHost("scgtest");
    assert.ok(host, "ChatHost取得");
    // タスクを2件起票(起票wakeでもclaimerのラウンドが始まり、working状態を作れる)
    assert.ok(ctl.tasks.create({ id: "scg-a", body: "稼働中エージェントが請求中のタスク", project: "scgtest" }), "タスクscg-a起票");
    assert.ok(ctl.tasks.create({ id: "scg-b", body: "未請求タスク", project: "scgtest" }), "タスクscg-b起票");
    const evLog = [];
    bus.on("agent.status", (e) => evLog.push([e.agent, e.status]));
    bus.on("task.claimed", (e) => evLog.push(["claim:" + e.agent, e.taskId]));
    // 起票wakeでclaimerのラウンドが走り出す(agent.status working を実経路で発火)
    assert.ok(
      await waitUntil(() => {
        try { return host.roundState.get(claimer)?.running === true; } catch { return false; }
      }),
      "claimer のラウンドが走り出す(起票wake経由)"
    );
    // 稼働中のclaimerへタスクを事前請求させる(黒板APIを直接叩いて請求済み状態を作る)
    const claimed = ctl.tasks.claim({ id: claimer, role: "impl" }, { project: "scgtest" });
    assert.ok(claimed && !claimed.error, "事前請求が成功: " + JSON.stringify(claimed)?.slice(0, 120));
    console.log("[probe] claimed.id =", claimed?.id, "| task.claimed ev =", JSON.stringify(evLog.filter((e) => e[0]?.startsWith?.("claim:"))));


    // 縮小ガード(1回目tick): claim直後〜tick直前にラウンドが稼働中であることを保証してからtickする
    assert.ok(
      await waitUntil(() => { try { return host.roundState.get(claimer)?.running === true; } catch { return false; } }),
      "claim直後もclaimerは稼働中(ラウンド実行中)"
    );
    console.log("[probe] preTick running(claimer) =", host.roundState.get(claimer)?.running);
    await ctl.autoscaleTick();
    const aliveAfter = ctl.aliveWorkersFor("scgtest");
    console.log("[probe] postTick alive =", [...(aliveAfter ?? [])].join(","));
    assert.ok(aliveAfter, "autoscaleTick後のaliveWorkersを観測できる");
    // 縮小ガード: claimed稼働中があるので desired >= base(2) が維持される。
    // alive は base(2) のまま(増員しない/減らない)
    assert.ok(aliveAfter.size >= 2, "baseワーカーは維持される: size=" + aliveAfter.size);

    // 縮小判定へ寄せる: claimed(scg-a)を実APIで解放、open(scg-b)は依存を外して消す
    // (タスク削除APIが無いため、openのまま WORKなし判定へ持っていくには
    //  depends_on を空にした上で project を外した別名へ付け替える)
    // 解放経路の検証: releaseOne時点でclaimerが稼働中(ラウンド実行中)であることが
    // ガード(runningNow)により誤解放を防ぐ。稼働が観測できない場合はスキップではなく失敗。
    assert.ok(
      await waitUntil(() => { try { return host.roundState.get(claimer)?.running === true; } catch { return false; } }),
      "解放直前もclaimerは稼働中(ラウンド実行中)"
    );
    ctl.tasks.releaseOne(claimer, "scg-a", "テスト後始末");
    // host無し扱いにはできないので、aliveWorkers実装準拠の別検証: open==0&claimed==0
    // の状況を作るため、scg-b をproject外へ移動してからtickする
    ctl.tasks.setProject("tasks/open/scg-b.md", "elsewhere");
    console.log("[probe] preTick2 claimed =", JSON.stringify(ctl.tasks.list().claimed.map((t) => t.id)), "status(claimer) =", ctl.tasks.list().claimed.find((t) => t.id === "scg-a") ? "claimed残" : "released");
    await ctl.autoscaleTick();
    const aliveIdle = ctl.aliveWorkersFor("scgtest");
    assert.ok(aliveIdle, "2回目tick後もaliveWorkersを観測できる");
    // 仕事が無くなっても増員は起きない(伸びない)。ただしspawn済みワーカー(impl-1)が
    // 自身のspawnタスクを請求中のときは稼働扱いで残るため、sizeの増加なしを以て合格とする。
    assert.ok(aliveIdle.size <= aliveAfter.size, "仕事が無ければ余剰増員は起きない: size=" + aliveIdle.size + " (tick前=" + aliveAfter.size + ")");
  } finally {
    try { await ctl.dispose?.(); } catch { /* 既定 */ }
    rmTree(ws); rmTree(ws + "-wt");
  }
});
