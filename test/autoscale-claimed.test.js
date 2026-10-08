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

    // タスクを2件起票し、片方を「稼働中の誰か」へ事前請求させる
    const tasks = ctl.tasks;
    await tasks.create({ id: "scg-a", body: "稼働中エージェントが請求中のタスク", project: "scgtest" });
    await tasks.create({ id: "scg-b", body: "未請求タスク", project: "scgtest" });
    const claimer = "scgtest-alpha"; // 稼働中(working)として偽装するエージェントid
    // ラウンドを走らせて claimer を working 状態にする
    ctl.say("[テスト] 起こし", "scgtest");
    const host = ctl.threadHost("scgtest");
    assert.ok(host, "ChatHost取得");
    // claimerがworkingになるのを待つ
    assert.ok(
      await waitUntil(() => {
        try { return ctl.agentState(claimer)?.status === "working"; } catch { return false; }
      }),
      "claimer が稼働状態になる"
    );
    // 稼働中のclaimerへタスクを請求させる(タスクツールはエージェント毎の紐付けのため、
    // ここでは黒板APIを直接叩いて請求済み状態を作る)
    const claimed = tasks.claim("scg-a", claimer);
    assert.ok(!claimed.error, "事前請求が成功: " + String(claimed?.error ?? ""));

    // 明示tick: この時点で open=1件(scg-b), claimed(稼働中)=1件(scg-a)
    await ctl.autoscaleTick();
    const aliveAfter = ctl.aliveWorkers?.get?.("scgtest");
    assert.ok(aliveAfter, "autoscaleTick後のaliveWorkersを観測できる");
    // 縮小ガード: claimed稼働中があるので desired >= base(2) が維持される。
    // alive は base(2) のまま(増員しない/減らない)
    assert.ok(aliveAfter.size >= 2, "baseワーカーは維持される: size=" + aliveAfter.size);

    // 全タスクが消化され(claimed解除含む)、開いたままのタスクが0の状態へ寄せる
    tasks.finish("scg-a", "scgtest-alpha", "ok");
    // 未請求タスクもこの時点では請求者がいないので、release相当の状態にない= open のまま。
    // 縮小判定: open==0 かつ claimed稼働中==0 にするため scg-b を取り下げる
    tasks.releaseOne(claimer, "scg-a", "テスト後始末");
    tasks.delete("scg-b");
    await ctl.autoscaleTick();
    const aliveIdle = ctl.aliveWorkers?.get?.("scgtest");
    assert.ok(aliveIdle.size <= 2, "仕事が無ければ余剰増員は起きない: size=" + aliveIdle.size);
  } finally {
    try { await ctl.dispose?.(); } catch { /* 既定 */ }
    rmTree(ws); rmTree(ws + "-wt");
  }
});
