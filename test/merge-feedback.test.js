// 差分レビューからの修正依頼(feedback): タスク起票+スレッド通知の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { runChat } from "../src/runner.js";
import { startUi as _startUi } from "../src/ui/server.js";
// test-hf-token-inject: UIサーバーのPOSTはCSRFトークンを要求するため、
// テスト内のfetchは全てトークン付きへ差し替える(startUi後にtokenedFetchOn()を呼ぶ)
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";
tokenedFetchOn();


function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }
function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-fb-"));
}

function scriptedModel(script) {
  let i = 0;
  return {
    maxTokens: 4000,
    async chat() {
      const step = script[Math.min(i++, script.length - 1)];
      return {
        content: step.text ?? null,
        reasoning: null,
        toolCalls: (step.toolCalls ?? []).map((tc, j) => ({ id: `c${i}-${j}`, name: tc.name, arguments: tc.args ?? {} })),
        raw: { role: "assistant", content: step.text ?? null, tool_calls: [] },
        usage: { promptTokens: 10, completionTokens: 1 },
      };
    },
  };
}

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
    chat: { lead: "lead", workers: ["alpha", "beta", "gamma"], maxTurnsPerRound: 8, staggerMs: 5 },
    agents: [
      { id: "alpha", displayName: "アルファ", role: "impl" },
      { id: "beta", displayName: "ベータ", role: "review" },
      { id: "gamma", displayName: "ガンマ", role: "impl" },
    ],
  };
}

test("feedback: スレッド宛てはproject付きタスクを起票し、ボードに修正依頼が流れる", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const posts = [];
  bus.on("board", (p) => posts.push(p));
  const config = mkConfig(ws);
  const modelFactory = () => scriptedModel([{ text: "待機中" }]);
  const ctl = await runChat({ config, bus, modelFactory });
  await ctl.openThread({ project: "demo", goal: "demoの完成" });

  const r = ctl.feedback({ taskId: "t1", comment: "境界ケースのテストを足してください", thread: "demo" });
  assert.equal(r.ok, true);
  assert.match(r.id, /^fb-t1-[0-9a-z]+$/);
  assert.equal(r.thread, "demo");

  // 起票されたタスク: project=demo でopen、本文にコメントが載る
  const { TaskBlackboard } = await import("../src/engine/tasks.js");
  const tasks = new TaskBlackboard(ws, bus);
  const l = tasks.list();
  const t = l.open.find((x) => x.id === r.id);
  assert.ok(t, "fbタスクがopenにある");
  assert.equal(t.project, "demo");
  assert.match(t.summary, /境界ケースのテスト/);

  // スレッドボードに修正依頼の告知が流れている
  const notified = posts.find((p) => p.thread === "demo" && p.text.includes("修正依頼") && p.text.includes(r.id));
  assert.ok(notified, "demoボードに修正依頼の告知がある");

  rmTree(ws);
  rmTree(`${ws}-wt`);
});

test("feedback: 不明なスレッドはメイン宛てにフォールバック、空コメントは拒否", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = mkConfig(ws);
  const modelFactory = () => scriptedModel([{ text: "待機中" }]);
  const ctl = await runChat({ config, bus, modelFactory });

  const r = ctl.feedback({ taskId: "T9", comment: "変数名を修正", thread: "存在しない" });
  assert.equal(r.ok, true);
  assert.equal(r.thread, "__main__");
  assert.match(r.id, /^fb-t9-/); // taskIdは英小文字へ正規化される

  assert.deepEqual(ctl.feedback({ taskId: "t1", comment: "   " }), { error: "taskIdとコメントが必要です" });
  assert.deepEqual(ctl.feedback({ taskId: "", comment: "x" }), { error: "taskIdとコメントが必要です" });

  rmTree(ws);
  rmTree(`${ws}-wt`);
});

test("API: /api/merge-feedbackはマージ記録のthreadを引き継いでonFeedbackへ渡す", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "m" }, agents: [] };
  const got = [];
  const ui = await startUiTokenized(_startUi, {
    config, modelFactory: () => ({}), bus, autoStart: false,
    onFeedback: (req) => { got.push(req); return { ok: true, id: `fb-${req.taskId}-x`, thread: req.thread }; },
  });
  const base = `http://127.0.0.1:${config.ui.port}`;
  const post = async (body) => {
    const r = await fetch(`${base}/api/merge-feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  // スレッド所属のエージェントがマージしたケース: 記録からthreadが復元される
  bus.emit("agent.spawned", { agent: { id: "demo-alpha", displayName: "A", thread: "demo" } });
  bus.emit("merge.completed", { agent: "demo-alpha", taskId: "t1", stat: " 1 file changed", patch: "", summary: "" });

  const ok = await post({ taskId: "t1", comment: "テストを足して" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.thread, "demo");
  assert.deepEqual(got.at(-1), { taskId: "t1", comment: "テストを足して", thread: "demo" });

  // マージ記録に無いtaskIdはメイン宛てへフォールバック
  const fb2 = await post({ taskId: "unknown-9", comment: "対応表にない" });
  assert.equal(fb2.status, 200);
  assert.equal(fb2.body.thread, "__main__");

  // バリデーション: 空コメント・空taskIdは400
  assert.equal((await post({ taskId: "t1", comment: " " })).status, 400);
  assert.equal((await post({ taskId: "", comment: "x" })).status, 400);

  ui.close();
  rmTree(ws);
  rmTree(`${ws}-wt`);
});
