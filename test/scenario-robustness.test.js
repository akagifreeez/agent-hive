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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

// 最小scenario設定: discovery無効・worktreesはtmp隔離。エージェントはモデルが決める。
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
    // 前回走行の残骸を作る: alphaとdeltaがimpl-statsを二重請求したままプロセス死した状態
    // (dash lab実例の再現。claimed/<agent>--<task>.md は2体まで同名タスクを保持しうる)
    const tasks0 = new TaskBlackboard(ws, new Bus());
    tasks0.create({ id: "impl-stats", project: "dash", body: "統計実装" });
    assert.ok(tasks0.claim({ id: "alpha", role: null }), "alphaが請求");
    mkdirSync(join(ws, "tasks", "claimed"), { recursive: true });
    writeFileSync(join(ws, "tasks", "claimed", "delta--impl-stats.md"), "project: dash\n\n統計実装(alpha側と同内容)\n");
    assert.equal(tasks0.list().claimed.length, 2, "準備: alpha/deltaが二重宙吊り(dash lab実例)");

    const config = minimalScenario(ws);
    const bus = new Bus();
    const modelFactory = () => scriptedModel({ neverReply: true });
    const snapshot = await runScenario({ config, modelFactory, bus });

    // 起動時回収: 実行完了時点で宙吊りは残っておらず、タスクはopenへ戻って請求可能
    const afterClaimed = snapshot.tasks.claimed.filter((f) => f.includes("impl-stats"));
    assert.equal(afterClaimed.length, 0, "起動時ゾンビ回収で宙吊りclaimedが解放される");
    const openBack = snapshot.tasks.open.filter((f) => f.includes("impl-stats"));
    assert.equal(openBack.length, 1, "解放されたタスクはopenへ戻り(単一実体)、次ランで請求可能");
  } finally {
    rmTree(ws);
    rmTree(`${ws}-wt`);
  }
});

test("runScenario再実行: seedがdone/の完了済みタスクを再起票せず、dependsOn依存解決がブロックされない", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-scenario-seed-"));
  try {
    // blog lab実例の再現: 1回目の走行で base→impl→verify の順に進め、base/implがdone済み。
    // 再実行(seed再投入)でdoneの再起票が起きると、verify(dependsOn: [impl])の依存解決が
    // 「openの複製」に阻まれて永遠に請求不能になる。
    const config = minimalScenario(ws);
    config.scenario.tasks = [
      { id: "base", body: "基盤実装" },
      { id: "impl-stats", body: "統計実装", dependsOn: ["base"] },
      { id: "verify-stats", body: "統計の検証", dependsOn: ["impl-stats"] },
    ];
    // 1回目相当: baseとimpl-statsを完了済みにしておく
    const tasks0 = new TaskBlackboard(ws, new Bus());
    tasks0.seed(config.scenario.tasks);
    assert.ok(tasks0.claim({ id: "w1", role: null }), "baseを請求");
    assert.ok(tasks0.finish({ id: "w1" }, "base"), "base完了");
    assert.ok(tasks0.claim({ id: "w2", role: null }), "impl-statsを請求(base済みで解錠)");
    assert.ok(tasks0.finish({ id: "w2" }, "impl-stats"), "impl-stats完了");

    // 2回目の走行(再実行=seed再投入)
    const bus = new Bus();
    const modelFactory = () => scriptedModel({ neverReply: true });
    const snapshot = await runScenario({ config, modelFactory, bus });

    const openIds = snapshot.tasks.open.map((f) => f.replace(/\.md$/, ""));
    assert.ok(!openIds.includes("base"), "done済みのbaseは再起票されない");
    assert.ok(!openIds.includes("impl-stats"), "done済みのimpl-statsは再起票されない");
    // verify-statsは未完了なのでopenへ投入され、かつ依存解決済みで請求可能であること
    assert.ok(openIds.includes("verify-stats"), "未完了のverify-statsは通常どおり起票される");
    const tasks = new TaskBlackboard(ws, new Bus());
    // project無しで起票されたseedタスクは文脈絞り(lab-lessons)の対象外 — これはclaimの正しい仕様。
    // blog lab実害の本質は「依存解決が済んでいれば請求できること」なので、文脈絞り無しで検証する。
    // (project付きで絞りたいテストは dash ゾンビ回収テストの impl-stats が担保している)
    const got = tasks.claim({ id: "reviewer", role: null });
    assert.ok(got, "verify-statsは依存完了済みとして請求可能(blog lab実害の解消)");
    assert.equal(got?.id, "verify-stats");
  } finally {
    rmTree(ws);
    rmTree(`${ws}-wt`);
  }
});

test("単体: seedはdone/の完了済みidをスキップし、open/claimed中のidはcreateの既存重複判定に従う", () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-seed-skip-"));
  try {
    const bus = new Bus();
    const tasks = new TaskBlackboard(ws, bus);
    tasks.create({ id: "done1", body: "一回目" });
    tasks.claim({ id: "w", role: null });
    tasks.finish({ id: "w" }, "done1");
    tasks.create({ id: "claimed1", body: "請求中" });
    tasks.claim({ id: "w", role: null });
    assert.equal(tasks.claimedBy("w")[0].id, "claimed1", "準備: claimed1をwが請求中");

    // seed再投入: doneはスキップ・claimedはcreateの重複判定で拒否・open新規は投入
    tasks.seed([
      { id: "done1", body: "二回目(再起票されるべきではない)" },
      { id: "claimed1", body: "再投入は拒否される" },
      { id: "fresh", body: "新しい仕事" },
    ]);
    assert.ok(!existsOpen(tasks, "done1"), "done済みidは再起票されない");
    assert.ok(!existsOpen(tasks, "claimed1"), "claimed中idの再投入は拒否される(従来どおり)");
    assert.ok(existsOpen(tasks, "fresh"), "新規idは投入される");
  } finally {
    rmTree(ws);
  }
});

function existsOpen(tasks, id) {
  return tasks.snapshot().open.includes(`${id}.md`);
}
