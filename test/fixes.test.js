// v5.4: 課題対応(claimed解放/予算ラン単位/worktree保持)+gather_context(読み取り時ブリーフ合成)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";

function rmTree(p) { try { rmTree(p); } catch { /* Windowsのファイルロックは無視 */ } }
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskBlackboard, readMeta } from "../src/engine/tasks.js";
import { Board, Bus } from "../src/engine/board.js";
import { createTools } from "../src/engine/tools.js";
import { pushAgentLog, AGENT_LOG_LIMIT, buildMonitorSnapshot } from "../src/ui/server.js";
import { OpenAIModel } from "../src/model/openai.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-fix-"));
}

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");
const AGENT = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };

test("release: 予算停止等で消えた担当者の請求中タスクがnote付きでopenへ戻る", () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const events = [];
  bus.on("task.released", (p) => events.push(p));

  tasks.seed([{ id: "t1", role: null, body: "途中の仕事" }, { id: "t2", role: "impl", body: "もう一つ" }]);
  tasks.claim({ id: "alpha", role: "impl" });
  tasks.claim({ id: "alpha", role: "impl" });
  assert.equal(tasks.snapshot().claimed.length, 2);

  const released = tasks.release("alpha", "担当者終了のため解放");
  assert.deepEqual(released.sort(), ["t1", "t2"]);
  assert.equal(tasks.snapshot().claimed.length, 0);
  assert.equal(tasks.snapshot().open.length, 2);
  const body = readFileSync(join(ws, "tasks/open/t1.md"), "utf8");
  assert.match(body, /担当者終了のため解放/);
  assert.deepEqual(events.map((e) => e.taskId).sort(), ["t1", "t2"]);
  rmTree(ws);
});

test("gather_context: board/done/openの生素材を読める", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const tools = createTools({ agent: AGENT, workspace: ws, mainWorkspace: ws, board, tasks, bus });

  board.post("beta", "設計レビューは指摘ゼロで完着");
  tasks.seed([{ id: "t1", role: null, body: "upperの実装" }]);
  tasks.claim({ id: "alpha", role: "x" });
  tasks.finish({ id: "alpha" }, "t1");

  const rb = await tools.execute("gather_context", { source: "board" });
  assert.match(rb.text, /設計レビューは指摘ゼロで完着/);
  assert.match(rb.text, /\[beta\]/);

  const rd = await tools.execute("gather_context", { source: "done" });
  assert.match(rd.text, /alpha--t1/);
  assert.match(rd.text, /upperの実装/);

  const ro = await tools.execute("gather_context", { source: "open" });
  assert.match(ro.text, /ありません/);

  tasks.create({ id: "t2", body: "次の仕事" });
  const ro2 = await tools.execute("gather_context", { source: "open" });
  assert.match(ro2.text, /次の仕事/);
  rmTree(ws);
});

test("gather_context: limitで取得件数を絞れる(新しい方を優先)", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const tools = createTools({ agent: AGENT, workspace: ws, mainWorkspace: ws, board, tasks, bus });
  board.post("a", "古い投稿1");
  board.post("a", "古い投稿2");
  board.post("a", "新しい投稿3");
  const r = await tools.execute("gather_context", { source: "board", limit: 2 });
  assert.doesNotMatch(r.text, /古い投稿1/);
  assert.match(r.text, /新しい投稿3/);
  rmTree(ws);
});

// UI直操作(チャット不要のタスク管理)の土台
test("list: 状態ごとにid/担当/要約/パス付きで一覧を返す", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws);
  tasks.seed([{ id: "t1", role: "impl", body: "role行の次がサマリーになる\n詳細は2行目" }, { id: "t2", role: null, body: "roleなしの仕事" }]);
  tasks.claim({ id: "alpha", role: "impl" });
  const l = tasks.list();
  assert.equal(l.open.length, 1);
  assert.equal(l.open[0].id, "t2");
  assert.equal(l.open[0].state, "open");
  assert.match(l.open[0].summary, /roleなしの仕事/);
  assert.match(l.open[0].path, /^tasks\/open\/t2\.md$/);
  assert.equal(l.claimed.length, 1);
  assert.equal(l.claimed[0].id, "t1");
  assert.equal(l.claimed[0].agent, "alpha");
  assert.equal(l.claimed[0].role, "impl");
  assert.match(l.claimed[0].summary, /サマリーになる/);
  tasks.finish({ id: "alpha" }, "t1");
  const l2 = tasks.list();
  assert.equal(l2.done[0].id, "t1");
  assert.equal(l2.done[0].agent, "alpha");
  rmTree(ws);
});

test("releaseOne: 指定1件だけopenへ戻す。openに同名があれば壊さない", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws);
  tasks.seed([{ id: "t1", role: null, body: "仕事1" }, { id: "t2", role: null, body: "仕事2" }]);
  tasks.claim({ id: "alpha", role: "x" });
  tasks.claim({ id: "alpha", role: "x" });
  assert.equal(tasks.releaseOne("alpha", "t1", "UIから解放"), true);
  assert.equal(existsSync(join(ws, "tasks/open/t1.md")), true);
  assert.match(readFileSync(join(ws, "tasks/open/t1.md"), "utf8"), /UIから解放/);
  assert.equal(tasks.snapshot().claimed.length, 1); // t2はstill claimed
  // openに同名が既にある場合は失敗(上書きしない)
  tasks.create({ id: "t2", body: "手動で投入済み" });
  assert.equal(tasks.releaseOne("alpha", "t2", "note"), false);
  assert.equal(readFileSync(join(ws, "tasks/open/t2.md"), "utf8").includes("手動で投入済み"), true);
  rmTree(ws);
});

test("cancel/reopen: open→中止→done、再開でopenへ。二重再開は拒否", () => {
  const ws = mktmp();
  const bus = new Bus();
  const events = [];
  bus.on("task.cancelled", (p) => events.push(p));
  const tasks = new TaskBlackboard(ws, bus);
  tasks.seed([{ id: "t1", role: null, body: "やめる仕事" }]);
  assert.equal(tasks.cancel("t1"), true);
  assert.equal(existsSync(join(ws, "tasks/open/t1.md")), false);
  assert.match(readFileSync(join(ws, "tasks/done/you--t1.md"), "utf8"), /中止/);
  assert.deepEqual(events, [{ taskId: "t1" }]);

  assert.equal(tasks.reopen("t1"), true);
  assert.equal(existsSync(join(ws, "tasks/open/t1.md")), true);
  assert.match(readFileSync(join(ws, "tasks/open/t1.md"), "utf8"), /再開/);
  // doneからは消えているので再openはもうできない(openに同名もあるし)
  assert.equal(tasks.reopen("t1"), false);
  rmTree(ws);
});

test("project: 作成時に文脈を付け、claimは文脈で絞れる(混ざらない)", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws);
  tasks.create({ id: "a-kernel", role: "impl", project: "cuda", body: "CUDAの仕事" });
  tasks.create({ id: "web-ui", role: "impl", body: "別の取り組みの仕事" });

  const got = tasks.claim({ id: "alpha", role: "impl" }, { project: "cuda" });
  assert.equal(got.id, "a-kernel");
  assert.equal(tasks.snapshot().open.includes("web-ui.md"), true); // 別文脈は残る
  assert.equal(tasks.claim({ id: "beta", role: "impl" }, { project: "cuda" }), null); // cudaは空
  const got2 = tasks.claim({ id: "beta", role: "impl" }); // 指定なしなら従来どおり何でも
  assert.equal(got2.id, "web-ui");

  const l = tasks.list();
  assert.equal(l.claimed.find((t) => t.id === "a-kernel").project, "cuda");
  assert.equal(l.done.find((t) => t.id === "web-ui")?.project ?? l.claimed.find((t) => t.id === "web-ui").project, "");
  rmTree(ws);
});

test("project: 旧形式ファイル(role行のみ)も読める", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws);
  tasks.seed([{ id: "t1", role: "review", body: "旧形式のタスク" }]);
  assert.equal(readMeta(join(ws, "tasks/open/t1.md")).role, "review");
  assert.equal(readMeta(join(ws, "tasks/open/t1.md")).project, "");
  const got = tasks.claim({ id: "gamma", role: "review" }, { project: "" });
  assert.equal(got.id, "t1");
  rmTree(ws);
});

test("setProject: 後から文脈を付け替え。role行は保持、不正パスは拒否", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws);
  tasks.seed([{ id: "t1", role: "impl", body: "本文はそのまま残る" }]);
  const p = "tasks/open/t1.md";
  assert.equal(tasks.setProject(p, "cuda"), true);
  const l = tasks.list();
  assert.equal(l.open[0].project, "cuda");
  assert.equal(l.open[0].role, "impl");
  assert.match(readFileSync(join(ws, "tasks/open/t1.md"), "utf8"), /本文はそのまま残る/);
  // 再度付け替えると既存project行は置き換わる(重複しない)
  assert.equal(tasks.setProject(p, "hive"), true);
  const meta = readMeta(join(ws, "tasks/open/t1.md"));
  assert.equal(meta.project, "hive");
  assert.equal(meta.role, "impl");
  // 未分類へ戻す(空文字)
  assert.equal(tasks.setProject(p, ""), true);
  assert.equal(readMeta(join(ws, "tasks/open/t1.md")).project, "");
  // 脱出パスは拒否
  assert.equal(tasks.setProject("tasks/../../evil.md", "x"), false);
  assert.equal(tasks.setProject("tasks/open/sub/evil.md", "x"), false);
  rmTree(ws);
});

test("gather_context: projectで絞り込める", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const tools = createTools({ agent: AGENT, workspace: ws, mainWorkspace: ws, board, tasks, bus });
  tasks.create({ id: "cuda-t", project: "cuda", body: "CUDAタスクの本文" });
  tasks.create({ id: "other-t", body: "よそ者の本文" });
  const r = await tools.execute("gather_context", { source: "open", project: "cuda" });
  assert.match(r.text, /CUDAタスクの本文/);
  assert.doesNotMatch(r.text, /よそ者の本文/);
  const r2 = await tools.execute("gather_context", { source: "open", project: "nosuch" });
  assert.match(r2.text, /nosuch/);
  rmTree(ws);
});

test("pushAgentLog: ログは上限件数で切り詰め、長文は圧縮", () => {
  const a = {};
  for (let i = 0; i < AGENT_LOG_LIMIT + 30; i++) pushAgentLog(a, "tool", `cmd-${i}`);
  assert.equal(a.log.length, AGENT_LOG_LIMIT);
  assert.equal(a.log[0].text, `cmd-${AGENT_LOG_LIMIT + 30 - AGENT_LOG_LIMIT}`); // 古い分から落ちる
  assert.equal(a.log.at(-1).text, `cmd-${AGENT_LOG_LIMIT + 29}`);
  const big = {};
  pushAgentLog(big, "think", "あ".repeat(5000));
  assert.equal(big.log[0].text.length, 2000);
  assert.equal(big.log[0].kind, "think");
  pushAgentLog(null, "tool", "無害(エージェント不明でも落ちない)");
});

test("OpenAIModel: reasoning(思考テキスト)を応答に含める", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "答え", reasoning: "まずXを確認しよう" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 }, cost: 0.001 },
    }),
  });
  try {
    const m = new OpenAIModel({ baseUrl: "http://x/api/v1", apiKey: "k", model: "m" });
    const r = await m.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.reasoning, "まずXを確認しよう");
    assert.equal(r.content, "答え");
    assert.equal(r.usage.reasoningTokens, 3);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("claim_next_task: 待ち行で後から投入されたタスクを請求できる(待ち時間はLLM呼出なし)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-claimwait-"));
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  // 既定(idleClaimWaitSec未指定)は待たない=従来どおり即ミス
  const tools0 = createTools({ agent: { id: "a", displayName: "A" }, workspace: ws, board: new Board(bus), tasks, bus });
  const miss = await tools0.execute("claim_next_task", {});
  assert.equal(miss.claimMiss, true);
  // 設定あり: 待ち行の途中でタスクが投入されたらそれを請求する
  const tools = createTools({ agent: { id: "b", displayName: "B" }, workspace: ws, board: new Board(bus), tasks, bus, idleClaimWaitSec: 5 });
  const pending = tools.execute("claim_next_task", {});
  await new Promise((r) => setTimeout(r, 500));
  tasks.create({ id: "later-1", body: "後から投入された仕事" });
  const r = await pending;
  assert.equal(r.ok, true);
  assert.equal(r.claimMiss, undefined);
  assert.match(r.text, /タスク later-1 を請求しました/);
  rmTree(ws);
});

test("monitorスナップショット: スレッド進捗・タスク・エージェント・マージを集約する", () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-mon-"));
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "m-alpha", displayName: "アルファ" };
  tasks.create({ id: "mt1", project: "proj", body: "監視テスト用の仕事" });
  tasks.create({ id: "mt2", project: "proj", body: "もう一件" });
  assert.ok(tasks.claim(agent, { project: "proj" }));
  const live = {
    board: [{ id: 1, from: "you", text: "進めて", thread: "__main__" }],
    threads: [{ name: "proj", folder: "engine", goal: "監視対象の取り組み" }],
    agents: { "m-alpha": { displayName: "アルファ", status: "working", turn: 3, lastTool: "bash", tokens: 1234, costUsd: 0.001, thread: "proj" } },
    merges: [{ taskId: "mt1", agent: "m-alpha", summary: "1ファイル +10", stat: "", patch: "" }],
    permMode: "normal",
  };
  const snap = buildMonitorSnapshot({ config: { model: { model: "test-model" } }, live, tasks, startedAt: Date.now() - 65000 });
  assert.equal(snap.model, "test-model");
  assert.ok(snap.uptimeSec >= 65);
  const th = snap.threads.find((t) => t.name === "proj");
  assert.equal(th.folder, "engine");
  assert.equal(th.total, 2);
  assert.equal(th.done, 0);
  assert.equal(snap.tasks.claimed.length, 1);
  assert.equal(snap.tasks.claimed[0].agent, "m-alpha");
  assert.equal(snap.agents[0].tokens, 1234);
  assert.equal(snap.merges[0].summary, "1ファイル +10");
  assert.equal(snap.recent[0].text, "進めて");
  rmTree(ws);
});
