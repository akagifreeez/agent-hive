// scenario lab実走の実害2件の再現テスト(2026-10-07 hive-lab-dash / hive-lab-blog)。
// (1) ゾンビclaim宙吊り: エージェントがempty-loop(空応答4連続)やターン上限で抜けると、
//     請求中タスクがclaimedのまま宙吊りになる。runScenarioは起動時にゾンビ回収(runChatと同じ)を
//     行い、誰にも進められないデッドロックを防ぐ(dash lab実例: impl-statsがalpha/delta二重宙吊り)。
// (2) seed重複再起票: TaskBlackboard.seed→create()はdone/を見ないため、シナリオ再実行時に
//     完了済みタスクがopenへ再起票される。blog lab実例: 重複openがdependsOn依存解決を
//     ブロックし、全依存完了後も検証タスクが請求不能になった。seed時はdone/をチェックして
//     スキップする。claim(未着手)の再投入は許す(自動再投入の既存運用を維持)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "../src/runner.js";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");

function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ }
}

// 最小scenario設定: エージェントは即終了(empty-loop)して抜ける。discoveryは無効。
// worktree生成を避けるためworktrees.dirはワークスペース外のtmpへ出す(隔離・掃除容易)。
function minimalScenario(ws) {
  return {
    workspace: ws,
    worktrees: { dir: `${ws}-wt` },
    agents: [
      { id: "alpha", displayName: "alpha", role: "impl", personaPath: PERSONA },
      { id: "delta", displayName: "delta", role: "impl", personaPath: PERSONA },
    ],
    loop: { maxTurns: 6 },
    runner: { timeoutSec: 30 },
    discovery: { probes: { tests: "off" } },
    exec: { testMaxConcurrent: 1 },
    permissions: {},
    scenario: {
      name: "lab-lessons",
      seedFiles: [],
      tasks: [],
    },
  };
}

// スクリプトどおりに応答するモックモデル。opts.neverReply=trueなら常に空応答(empty-loop経路)。
// opts.exitAfterClaim=trueは1回だけclaimタスクを呼んでから以後は空応答(ターン上限まで宙吊り)。
function scriptedModel({ calls = null, neverReply = false } = {}) {
  let i = 0;
  return {
    async chat() {
      if (neverReply || (calls && i >= calls.length)) {
        i++;
        return { content: null, toolCalls: [], raw: { role: "assistant", content: null } };
      }
      const step = calls?.[i++] ?? { toolCalls: [] };
      if (step.toolCalls?.length) {
        return {
          content: null,
          toolCalls: step.toolCalls.map((tc, j) => ({ id: `call-${i}-${j}`, name: tc.name, arguments: tc.args ?? {} })),
          raw: { role: "assistant", content: null, tool_calls: step.toolCalls.map((tc, j) => ({ id: `call-${i}-${j}`, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) } })) },
        };
      }
      return { content: step.text ?? null, toolCalls: [], raw: { role: "assistant", content: step.text ?? null } };
    },
  };
}

test("runScenario起動時ゾンビ回収: 前回走行で宙吊りになったclaimedタスクが解放される", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-scenario-zombie-"));
  try {
    // 前回走行の残骸を作る: alphaとdeltaがimpl-statsを二重請求したまま異常終了した状態
    const tasks0 = new TaskBlackboard(ws, new Bus());
    tasks0.create({ id: "impl-stats", project: "dash", body: "統計実装" });
    tasks0.claim({ id: "alpha", role: null }, {});
    // 2体目の宙吊り(claimed/<agent>--<task>.md 形式を直接作る: claim()は同名openを消すため)
    const claimedFile = join(ws, "tasks", "claimed", `delta--impl-stats.md`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(claimedFile, "project: dash\n\n統計実装(alpha側と同内容)\n");
    const before = tasks0.list().claimed;
    assert.equal(before.length, 2, "準備: alpha/deltaが二重宙吊り(dash lab実例の再現)");

    const config = minimalScenario(ws);
    const bus = new Bus();
    const modelFactory = () => scriptedModel({ neverReply: true });
    const snapshot = await runScenario({ config, modelFactory, bus });

    // 起動時回収の確認: 実行完了後もimpl-statsがclaimedに宙吊りのまま残らない
    const after = snapshot.tasks.claimed.filter((f) => f.includes("impl-stats"));
    assert.equal(after.length, 0, "起動時ゾンビ回収で宙吊りclaimedが解放され、次ランは請求可能なまま残らない");
    const openBack = snapshot.tasks.open.filter((f) => f.includes("impl-stats"));
    assert.equal(openBack.length, 1, "解放されたタスクはopenへ戻り(単一実体)、請求可能");
  } finally {
    rmTree(ws);
    rmTree(`${ws}-wt`);
  }
});

test("runScenario再実行: seedがdone/の完了済みタスクを再起票せず、dependsOn依存解決がブロックされない", async ()同じ内容で続く
