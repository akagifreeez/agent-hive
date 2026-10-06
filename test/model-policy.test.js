// モデル選択ポリシー(イシュー#12の仕組み化)の検証。
// (a) MODEL_SELECTION_POLICYがシステムプロンプトに乗る
// (b) 検証差し戻しの記録と、しきい値(既定2回)到達でエスカレーション推奨文面が出る
// (c) しきい値/エスカレーション先は config.chat.modelPolicy で上書きできる
//     (runner→spawn→toolsの解決済みポリシー引き回しで二重正規化しても設定が落ちない)
// (d) 差し戻し0回・しきい値未満では投稿文面は出ない(既定割り当て=指定なきタスクは既定モデルのまま)
// (e) config未設定時は既定値(しきい値2・エスカレーション先null)で動く
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/engine/loop.js";
import {
  MODEL_SELECTION_POLICY,
  DEFAULT_ESCALATION_THRESHOLD,
  readModelPolicy,
  noteRejection,
  rejectionCount,
  escalationNotice,
} from "../src/engine/model-policy.js";

function mktmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ }
}

test("MODEL_SELECTION_POLICYがシステムプロンプトに乗る", () => {
  const agent = { personaText: "# L\nリーダーです。" };
  const prompt = buildSystemPrompt(agent, "bash");
  assert.ok(prompt.includes("モデル選択ポリシー"), "ポリシー見出しが含まれる");
  assert.ok(prompt.includes("既定は接続済みの既定モデル"), "既定モデル維持の基準が含まれる");
  assert.ok(prompt.includes("強いモデル"), "強いモデル検討の基準が含まれる");
  assert.ok(MODEL_SELECTION_POLICY.includes("同時1タスクまで"), "クォータ保護の文面を含む");
});

test("検証差し戻し2回でエスカレーション推奨文面が出る(既定しきい値)", () => {
  const ws = mktmp("hive-mpol-");
  try {
    const r1 = noteRejection(ws, "t-esc", null);
    assert.equal(r1.count, 1);
    assert.equal(r1.notice, null, "1回目はまだ出ない");
    const r2 = noteRejection(ws, "t-esc", null);
    assert.equal(r2.count, 2);
    assert.ok(r2.notice, "2回目(しきい値到達)で文面が出る");
    assert.match(r2.notice, /\[モデル選択エスカレーション推奨\]/);
    assert.match(r2.notice, /t-esc/);
    assert.match(r2.notice, /検証差し戻し 2 回/);
    assert.match(r2.notice, /再起票/);
    assert.match(r2.notice, /同時1タスクまで/, "クォータ保護を含む");
    // 記録はworkspace/memory/.model-policy.jsonへ(state/配下は触らない)
    const raw = JSON.parse(readFileSync(join(ws, "memory", ".model-policy.json"), "utf8"));
    assert.equal(raw.rejects["t-esc"], 2);
    assert.equal(rejectionCount(ws, "t-esc"), 2);
  } finally {
    rmTree(ws);
  }
});

test("しきい値はconfig.chat.modelPolicyで上書きでき、解決済みポリシーの二重正規化でも落ちない", () => {
  const ws = mktmp("hive-mpol-");
  try {
    // runnerがreadModelPolicy(config)を通した解決済み形をspawn→toolsへ渡す経路の再現
    const resolved = readModelPolicy({ chat: { modelPolicy: { escalationThreshold: 3, escalateModel: "zai/glm-5.3" } } });
    assert.deepEqual(resolved, { escalationThreshold: 3, escalateModel: "zai/glm-5.3" });
    // 二重正規化(回帰: 解決済み形を再度readModelPolicyに通すと既定2へ落ちていた)
    assert.deepEqual(readModelPolicy(resolved), { escalationThreshold: 3, escalateModel: "zai/glm-5.3" }, "解決済み形の再通しで設定が保持される");

    // 生configのままでも上書きが効く
    const r1 = noteRejection(ws, "t-th", { chat: { modelPolicy: { escalationThreshold: 3 } } });
    const r2 = noteRejection(ws, "t-th", { chat: { modelPolicy: { escalationThreshold: 3 } } });
    assert.equal(r2.notice, null, "上書きしきい値3の2回目ではまだ出ない");
    const r3 = noteRejection(ws, "t-th", { chat: { modelPolicy: { escalationThreshold: 3 } } });
    assert.match(r3.notice, /検証差し戻し 3 回/);

    // エスカレーション先モデルの指定が文面に乗る
    const withModel = escalationNotice("t-m", 2, { escalationThreshold: 2, escalateModel: "zai/glm-5.3" });
    assert.match(withModel, /エスカレーション先\(設定値\): zai\/glm-5\.3/);
  } finally {
    rmTree(ws);
  }
});

test("config未設定時は既定値(しきい値2・エスカレーション先null)で動く", () => {
  assert.equal(DEFAULT_ESCALATION_THRESHOLD, 2);
  assert.deepEqual(readModelPolicy(null), { escalationThreshold: 2, escalateModel: null });
  assert.deepEqual(readModelPolicy({}), { escalationThreshold: 2, escalateModel: null });
  assert.deepEqual(readModelPolicy({ chat: {} }), { escalationThreshold: 2, escalateModel: null });
  // 不正値は既定へフォールバック
  assert.deepEqual(readModelPolicy({ chat: { modelPolicy: { escalationThreshold: 0 } } }), { escalationThreshold: 2, escalateModel: null });
  const notice = escalationNotice("t-d", 2, readModelPolicy(null));
  assert.match(notice, /接続済みの強いモデル/, "未設定時の文面はリーダー選定を促す");
});

test("差し戻し記録のタスク間独立性と、指定なきタスク=既定モデルの回帰(#12)", () => {
  const ws = mktmp("hive-mpol-");
  try {
    noteRejection(ws, "a", null);
    noteRejection(ws, "a", null);
    noteRejection(ws, "b", null);
    assert.equal(rejectionCount(ws, "a"), 2);
    assert.equal(rejectionCount(ws, "b"), 1);
    assert.equal(rejectionCount(ws, "unknown"), 0);
    // カウンタはタスクごとに独立(タスクbは2回目で自分のしきい値に達する。他タスクと混線しない)
    const nb = noteRejection(ws, "b", null);
    assert.equal(nb.count, 2, "タスクbのカウンタは独立して増える");
    assert.match(nb.notice, /タスク b が/);
    assert.doesNotMatch(nb.notice, /タスク a/, "他タスクの差し戻しは混線しない");
    assert.ok(!existsSync(join(ws, "tasks")), "タスクファイルは作らない(メモリで追跡)");
  } finally {
    rmTree(ws);
  }
});

test("承認フロー競合経路: 差し戻し記録がtools.jsから呼ばれてもReferenceErrorしない(modelPolicy未指定=既定動作)", async () => {
  // 回帰: alpha実装の初版は未定義識別子 config を参照しており、verifyマージ競合の瞬間に落ちた
  const { createTools } = await import("../src/engine/tools.js");
  const { Board, Bus } = await import("../src/engine/board.js");
  const { TaskBlackboard } = await import("../src/engine/tasks.js");
  const { ensureGitRepo } = await import("../src/engine/discover.js");
  const { createWorktree } = await import("../src/engine/worktree.js");
  const { runCommand } = await import("../src/engine/exec.js");
  const main = mktmp("hive-mpol-main-");
  const wt = `${main}-wt`;
  try {
    await ensureGitRepo(main);
    const commit = () => runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m base`, cwd: main, outputLimit: 500 });
    (await import("node:fs")).writeFileSync(join(main, "f.txt"), "base\n");
    await commit();
    const wtA = await createWorktree({ mainWorkspace: main, worktreeRoot: wt, agentId: "mpola" });
    // mainを進めて競合の種を作る
    (await import("node:fs")).writeFileSync(join(main, "conflict.txt"), "main side\n");
    await commit();

    const bus = new Bus();
    const posts = [];
    bus.on("board", (p) => posts.push(p));
    const board = new Board(bus, "mpol");
    const tasks = new TaskBlackboard(main, bus);
    const approvals = {
      require: true,
      pending: new Map(),
      pickReviewer(excludeId) {
        return excludeId === "rv" ? { id: "mpola", role: "impl" } : { id: "rv", role: "review" };
      },
    };
    const lead = { id: "lead", displayName: "リーダー", role: "lead", personaText: "# L" };
    // modelPolicyは未指定(null)=二重正規化・既定値経路。runner経路は readModelPolicy(config) 済みのオブジェクトを渡す
    const leadTools = createTools({ agent: lead, workspace: wt, mainWorkspace: main, board, tasks, bus, approvals });
    tasks.create({ id: "c1", body: "競合する仕事" });
    assert.ok((await leadTools.execute("claim_next_task", {})).ok);
    (await import("node:fs")).writeFileSync(join(wt, "conflict.txt"), "wt side\n");
    const fin = await leadTools.execute("finish_task", { task_id: "c1" });
    assert.match(fin.text, /検証タスク verify-c1/, "マージは保留され検証タスクが起票する");

    // 検証者(rv)がマージ→競合→差し戻し記録+エスカレーション推奨(2回目で出る。ここは1回目)
    const reviewer = { id: "rv", displayName: "レビュアー", role: "review", personaText: "# R" };
    const rvTools = createTools({
      agent: reviewer, workspace: main, mainWorkspace: main, board, tasks, bus, approvals,
      modelPolicy: readModelPolicy({ chat: { modelPolicy: { escalationThreshold: 1 } } }),
    });
    tasks.create({ id: "verify-c1", role: "review", body: "検証する" });
    await rvTools.execute("claim_next_task", { project: "" });
    const appr = await rvTools.execute("approve_task", { task_id: "c1" });
    assert.equal(appr.ok, false, "競合でapproveは失敗する");
    assert.match(appr.text, /競合/, "競合が返る: " + String(appr.text ?? "").slice(0, 80));
    assert.equal(rejectionCount(main, "c1"), 1, "差し戻しが記録されている");
    const esc = posts.find((p) => String(p.text ?? "").includes("モデル選択エスカレーション推奨"));
    assert.ok(esc, "しきい値1上書きにより1回目でエスカレーション推奨がボードへ投稿される");
    assert.match(esc.text, /タスク c1/);
    assert.match(esc.text, /同時1タスクまで/);
  } finally {
    for (const d of [main, wt]) rmTree(d);
  }
});
