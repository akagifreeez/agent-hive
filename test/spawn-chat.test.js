// v5: スポーン階層(SpawnManager)とメインチャット(ChatHost)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { SpawnManager } from "../src/engine/spawn.js";
import { ChatHost } from "../src/engine/chat.js";
import { ensureGitRepo } from "../src/engine/discover.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PERSONA = join(ROOT, "agents", "alpha.md");

function makeEnv() {
  const ws = mkdtempSync(join(tmpdir(), "hive-spawn-"));
  const root = `${ws}-wt`;
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  return { ws, root, bus, board, tasks };
}

function scriptedModel(script, received = []) {
  let i = 0;
  return {
    maxTokens: 4000,
    async chat({ messages }) {
      received.push(messages);
      const step = script[Math.min(i++, script.length - 1)];
      return {
        content: step.text ?? null,
        toolCalls: (step.toolCalls ?? []).map((tc, j) => ({ id: `c${i}-${j}`, name: tc.name, arguments: tc.args ?? {} })),
        raw: { role: "assistant", content: step.text ?? null, tool_calls: [] },
        usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.0001 },
      };
    },
  };
}

async function waitUntil(fn, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

test("spawn: depth上限と同時数上限で拒否され、正常時はworktree付きで走る", async () => {
  const { ws, root, bus, board, tasks } = makeEnv();
  await ensureGitRepo(ws);
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 6 },
    modelFactory: () => scriptedModel([{ text: "完了しました" }]),
  });
  const main = { id: "alpha", displayName: "アルファ", depth: 0 };
  // depth上限: main(0)→sub(1)は可。sub(1)→worker(2)は可。worker(2)からのスポーンは不可
  const r1 = await manager.spawn({ parent: main, brief: "テスト作業", role: "impl" });
  assert.ok(r1.id);
  assert.ok(await waitUntil(() => existsSync(join(root, r1.id))));
  const subAgent = { id: r1.id, displayName: r1.displayName, depth: 1 };
  const r2 = await manager.spawn({ parent: subAgent, brief: "作業員の仕事", role: "impl" });
  assert.ok(r2.id);
  const r3 = await manager.spawn({ parent: { id: r2.id, depth: 2 }, brief: "これは作れない" });
  assert.ok(r3.error);
  // 同時数上限(2体生きている状態で上限2にする)
  const tight = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: `${root}-2`, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 1 },
    modelFactory: () => scriptedModel([{ text: "完了" }]),
  });
  const t1 = await tight.spawn({ parent: main, brief: "1体目" });
  const t2 = await tight.spawn({ parent: main, brief: "2体目" });
  assert.ok(t2.error);
  assert.ok(await waitUntil(() => manager.snapshot()[r1.id]?.status === "done"));
  rmSync(ws, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}-2`, { recursive: true, force: true });
});

test("spawn: スポーンされたエージェントはbriefで駆動し、成果は自分のworktree→finishでmainへ", async () => {
  const { ws, root, bus, board, tasks } = makeEnv();
  await ensureGitRepo(ws);
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 6 },
    modelFactory: (agent) => scriptedModel([
      { toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "サブの成果" } }] },
      { toolCalls: [{ name: "finish_task", args: { task_id: `spawn-${agent.id}` } }] },
      { text: "作業を完了しました" },
    ]),
  });
  const main = { id: "alpha", displayName: "アルファ", depth: 0 };
  const r = await manager.spawn({ parent: main, brief: "out.txtを作って", role: "impl" });
  assert.ok(await waitUntil(() => manager.snapshot()[r.id]?.status === "done"));
  assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "サブの成果");
  assert.ok(tasks.snapshot().done.some((f) => f.includes(`spawn-${r.id}`)));
  assert.ok(board.posts.some((p) => p.from === "system" && p.text.includes("スポーン")));
  rmSync(ws, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("ChatHost: ユーザー入力で全メインが応答し、記憶が次ラウンドに続く。@呼び出しは該当者だけ起きる", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-chat-"));
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const receivedBy = {};
  const makeMain = (id) => ({
    id, displayName: id === "alpha" ? "アルファ" : "ベータ", role: "lead", depth: 0,
    personaPath: PERSONA,
  });
  const mains = [makeMain("alpha"), makeMain("beta")];
  const host = new ChatHost({
    mains,
    modelFactory: (agent) => {
      receivedBy[agent.id] = receivedBy[agent.id] ?? [];
      const received = receivedBy[agent.id];
      let i = 0;
      return {
        maxTokens: 4000,
        async chat({ messages }) {
          received.push(messages.map((m) => m.content));
          const step = [{ text: `${agent.id}の応答1` }, { text: `${agent.id}の応答2` }][Math.min(i++, 1)];
          return { content: step.text, toolCalls: [], raw: { role: "assistant", content: step.text }, usage: {} };
        },
      };
    },
    toolsFactory: (main) => ({
      specs: [],
      detectShell: async () => "bash",
      execute: async () => ({ ok: true, text: "" }),
      ...(createToolsShim(main, ws, board, tasks)),
    }),
    board, tasks, bus,
    maxTurnsPerRound: 5, staggerMs: 0,
  });
  function createToolsShim() {
    return { execute: async (name) => ({ ok: true, text: "skip" }) };
  }

  await host.say("最初の指示です");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(board.posts.filter((p) => p.from === "you").length, 1);
  assert.ok(board.posts.some((p) => p.from === "alpha" && p.text.includes("alphaの応答1")));
  assert.ok(board.posts.some((p) => p.from === "beta" && p.text.includes("betaの応答1")));

  // 記憶の継続: 2回目の入力で、1回目の応答も文脈に入っている
  await host.say("2つ目の指示です");
  await new Promise((r) => setTimeout(r, 500));
  const last = receivedBy.alpha[receivedBy.alpha.length - 1];
  assert.ok(last.some((c) => String(c).includes("最初の指示です")));
  assert.ok(last.some((c) => String(c).includes("2つ目の指示です")));

  // @呼び出し: ベータだけが起きる(起床は800ms遅延設計なので余裕を持って待つ)
  const before = receivedBy.beta.length;
  board.post("delta", "@ベータ この件どう思います?");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(receivedBy.beta.length, before + 1);
  const alphaAfter = receivedBy.alpha.length;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(receivedBy.alpha.length, alphaAfter);
  rmSync(ws, { recursive: true, force: true });
});
