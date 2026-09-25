// モックモデルでエンジン全体(claim/ボード/ツール/ループ)を検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { runAgentLoop } from "../src/engine/loop.js";

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), "hive-test-"));
}

// スクリプト通りに応答するモックモデル
function scriptedModel(script) {
  let i = 0;
  return {
    async chat() {
      const step = script[Math.min(i++, script.length - 1)];
      if (step.toolCalls) {
        return {
          content: null,
          toolCalls: step.toolCalls.map((tc, j) => ({ id: `call-${i}-${j}`, name: tc.name, arguments: tc.args ?? {} })),
          raw: { role: "assistant", content: null, tool_calls: step.toolCalls.map((tc, j) => ({ id: `call-${i}-${j}`, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) } })) },
        };
      }
      return { content: step.text, toolCalls: [], raw: { role: "assistant", content: step.text } };
    },
  };
}

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");
const AGENT_A = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };
const AGENT_B = { id: "beta", displayName: "ベータ", role: "review", personaPath: PERSONA };

function makeEnv(workspace) {
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(workspace);
  return { bus, board, tasks };
}

test("タスクのclaimは原子的: 2エージェントが同時に請求しても1体しか取れない", () => {
  const ws = makeWorkspace();
  const { tasks } = makeEnv(ws);
  tasks.seed([{ id: "t1", role: null, body: "仕事" }]);
  const a = tasks.claim({ id: "a", role: "x" });
  const b = tasks.claim({ id: "b", role: "y" });
  assert.ok(a);
  assert.equal(b, null);
  assert.ok(existsSync(join(ws, "tasks", "claimed", "a--t1.md")));
  rmSync(ws, { recursive: true, force: true });
});

test("claimはrole一致を優先し、無ければrole指定なしを取る", () => {
  const ws = makeWorkspace();
  const { tasks } = makeEnv(ws);
  tasks.seed([{ id: "free", role: null, body: "誰でも" }, { id: "mine", role: "impl", body: "実装向け" }]);
  const got = tasks.claim({ id: "a", role: "impl" });
  assert.equal(got.id, "mine");
  rmSync(ws, { recursive: true, force: true });
});

test("パス脱出の拒否: read_file がワークスペース外を指すとエラー", async () => {
  const ws = makeWorkspace();
  const { board, tasks, bus } = makeEnv(ws);
  const tools = createTools({ agent: AGENT_A, workspace: ws, board, tasks, bus });
  const out = await tools.execute("read_file", { path: "../outside.txt" });
  assert.equal(out.ok, false);
  assert.match(out.text, /ワークスペース外/);
  rmSync(ws, { recursive: true, force: true });
});

test("write→read→edit の一連と、editの不一致・非一意エラー", async () => {
  const ws = makeWorkspace();
  const { board, tasks, bus } = makeEnv(ws);
  const tools = createTools({ agent: AGENT_A, workspace: ws, board, tasks, bus });
  await tools.execute("write_file", { path: "src/a.txt", content: "hello world\nhello world" });
  const dup = await tools.execute("edit_file", { path: "src/a.txt", old_text: "hello", new_text: "hi" });
  assert.equal(dup.ok, false);
  const miss = await tools.execute("edit_file", { path: "src/a.txt", old_text: "nope", new_text: "x" });
  assert.equal(miss.ok, false);
  const ok = await tools.execute("edit_file", { path: "src/a.txt", old_text: "hello world\nhello", new_text: "hi world\nhello" });
  assert.equal(ok.ok, true);
  assert.match(readFileSync(join(ws, "src", "a.txt"), "utf8"), /^hi world/);
  rmSync(ws, { recursive: true, force: true });
});

test("ループ統合: claim→write→投稿→finish が一巡する", async () => {
  const ws = makeWorkspace();
  const { board, tasks, bus } = makeEnv(ws);
  tasks.seed([{ id: "build", role: "impl", body: "何か作る" }]);
  const agent = { ...AGENT_A };
  const tools = createTools({ agent, workspace: ws, board, tasks, bus });
  const model = scriptedModel([
    { toolCalls: [{ name: "claim_next_task" }] },
    { toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "成果物" } }] },
    { toolCalls: [{ name: "post_to_board", args: { text: "できました" } }] },
    { toolCalls: [{ name: "finish_task", args: { task_id: "build" } }] },
    { text: "完了しました" },
  ]);
  const r = await runAgentLoop({ agent, model, tools, board, bus, maxTurns: 10 });
  assert.equal(r.ok, true);
  assert.equal(tasks.snapshot().done.includes("alpha--build.md"), true);
  assert.ok(board.posts.some((p) => p.from === "alpha" && p.text === "できました"));
  rmSync(ws, { recursive: true, force: true });
});

test("wait_for_board は他者投稿で起床し、自分の投稿では起こされない", async () => {
  const ws = makeWorkspace();
  const { board, tasks, bus } = makeEnv(ws);
  const tools = createTools({ agent: AGENT_A, workspace: ws, board, tasks, bus });
  const waitP = tools.execute("wait_for_board", { timeout_sec: 5 });
  board.post("alpha", "自分の投稿"); // 起こされない
  const notYet = await Promise.race([waitP.then(() => "woke"), new Promise((r) => setTimeout(() => r("still"), 100))]);
  assert.equal(notYet, "still");
  board.post("beta", "他者の投稿"); // 起きる
  const out = await waitP;
  assert.match(out.text, /\[betaの投稿\]/);
  rmSync(ws, { recursive: true, force: true });
});
