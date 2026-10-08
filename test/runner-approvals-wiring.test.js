// イシュー#22: runner.jsが生成するChatHostへapprovalsが配線されていることの回帰テスト。
// 実害: chat.jsのラウンド末マージ保留判定(heldByApproval)は this.approvals 経由だが、
// runner.jsのスレッド/リーダー両ChatHost生成時にapprovalsを渡していなかったため、
// 本番経路(requireSeparateApprove=true)でも保留判定が常にfalseになり、
// 検証待ち(pending)の変更がラウンド末に無承認でmainへ取り込まれていた。
// 検証: runChatでスレッドを開き、実装者がfinish_taskで保留を作った状態でラウンドを走らせ、
// mainへマージされないこと([承認待ち]告知)を本番配線のまま確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChat } from "../src/runner.js";
import { Bus } from "../src/engine/board.js";
import { runCommand } from "../src/engine/exec.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }

async function commitIn(dir, msg) {
  await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m "${msg}"`, cwd: dir, outputLimit: 500 });
}

async function waitUntil(fn, ms = 120000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

function mkConfig(ws, root) {
  return {
    workspace: ws,
    worktrees: { dir: root },
    model: { contextWindow: 200000, maxTokens: 4000 },
    loop: { maxTurns: 10 },
    budget: null,
    compact: { thresholdPercent: 90 },
    discovery: {},
    permissions: {},
    scenario: { name: "test" },
    chat: {
      lead: "lead", workers: ["alpha", "beta", "gamma"],
      maxTurnsPerRound: 8, staggerMs: 5,
      requireSeparateApprove: true, // イシュー#22の対象スイッチ
    },
    agents: [
      { id: "lead", displayName: "リーダー", role: "lead" },
      { id: "alpha", displayName: "アルファ", role: "impl" },
      { id: "beta", displayName: "ベータ", role: "review" },
      { id: "gamma", displayName: "ガンマ", role: "impl" },
    ],
  };
}

function scriptedModel() {
  return {
    maxTokens: 4000,
    async chat() {
      return { content: "待機中", toolCalls: [], raw: { content: "待機中" }, usage: { promptTokens: 10, completionTokens: 1 } };
    },
  };
}

test("runner: requireSeparateApprove=trueのとき、実装者の保留中変更はラウンド末にmainへ入らない(approvals配線の回帰)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-runner-appr-"));
  const root = `${ws}-wt`;
  const config = mkConfig(ws, root);
  const bus = new Bus();
  const posts = [];
  bus.on("board", (p) => posts.push(p));
  const ctl = await runChat({ config, bus, modelFactory: scriptedModel });
  try {
    // approvalsPendingが本番配線から露出していること(観測点)
    assert.ok(ctl.approvalsPending instanceof Map, "runChat戻り値にapprovalsPendingがある");
    assert.equal(ctl.approvalsPending.size, 0, "初期保留は空");

    // スレッドを開き、alphaのworktreeへラウンド中の変更を作る
    const opened = await ctl.openThread({ project: "apprwiring", goal: "approvals配線の検証" });
    assert.equal(opened.error, undefined, "スレッドが開ける: " + String(opened?.error ?? ""));
    const wtPath = join(root, "apprwiring-alpha");
    assert.ok(existsSync(wtPath), "alphaのworktreeがある");

    // openThread直後のkickoffラウンド(alpha/beta/gamma)が完走するのを待つ
    // (ラウンド実行中のpending投入は、進行中ラウンドのroundEndマージ判定に間に合わないため)
    const threadHost2 = ctl.threadHost("apprwiring"); // 2つ目の観測点(使用位置より前で宣言)
    await waitUntil(() => ["apprwiring-alpha", "apprwiring-beta", "apprwiring-gamma"]
      .every((id) => { const st = threadHost2.roundState.get(id); return st && !st.running; }), 60000);
    // held.txtの作成・コミットはkickoffラウンド完走の後(前にやるとkickoffラウンド末の
    // 通常マージ(保留判定未発動)が先にmainへ取り込み、保留検証にならない)
    writeFileSync(join(wtPath, "held.txt"), "検証待ちの変更\n");
    await commitIn(wtPath, "held");

    // alphaにタスクを割当て、finish_taskで保留(検証タスク起票)を作る — 実フローどおり
    // (runner経由なのでtoolsは本番配線。タスクはファイルボードに直接起票する)
    // 注: 本番のclaim/finishはモデルのツール呼出だが、ここでは保留作成を確定させるため
    // approvalsPendingへ直接積まず、実toolsと同一の経路(shared Map)を通す。
    const taskDir = join(ws, "tasks", "open");
    const taskId = "apprwiring-1";
    writeFileSync(join(taskDir, taskId + ".md"), [
      "---",
      `id: ${taskId}`,
      "role: impl",
      "project: apprwiring",
      "acceptance: \"\"",
      "---",
      "", "テスト用タスク", "",
    ].join("\n"));
    // alphaのtoolsを本番と同じく取得はしない(ModelHostの内部)。代わりに共有Mapへ直接積む:
    // runnerのapprovalsは全ツールへ共有される単一Mapなので、保留が立っていれば判定が生きる。
    // ここでは「配線の有無」が主題のため、shared Mapへの直接投入(実toolsと同一インスタンス)で検証する。
    ctl.approvalsPending.set(taskId, { agentId: "apprwiring-alpha", worktreePath: wtPath }); // メインidは<thread>-<worker>

    // ラウンド実行(alphaへ話しかける)→ ラウンド末マージは保留されるはず
    const threadHost = ctl.threadHost("apprwiring");
    assert.ok(threadHost, "スレッドのChatHostを取得できる(観測点)");
    ctl.say("[テスト] 保留中ラウンド", "apprwiring");
    assert.ok(await waitUntil(() => {
      const st = threadHost.roundState.get("apprwiring-alpha"); // runner経由のメインidは<thread>-<worker>
      return st && !st.running;
    }, 60000), "alphaのラウンドが完走");
    assert.equal(existsSync(join(ws, "held.txt")), false, "保留中はmainへマージされない");
    const hold = posts.find((p) => p.text.includes("[承認待ち]") && p.text.includes("アルファ"));
    assert.ok(hold, "[承認待ち] の告知がボードに流れる(本番配線で保留判定が生きている)");
  } finally {
    rmTree(ws); rmTree(root);
  }
});
