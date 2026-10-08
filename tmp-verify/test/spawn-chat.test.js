// v5: スポーン階層(SpawnManager)とメインチャット(ChatHost)の検証
import { test } from "node:test";

// 重い実駆動テストの分離ガード: 通常はskip、HIVE_HEAVY=1で従来どおり実行(2026-10-06 ガンマ調査#26)
const HEAVY_SKIP = process.env.HIVE_HEAVY ? false : "HIVE_HEAVY未設定のためスキップ(重い実駆動テスト。実行は HIVE_HEAVY=1)";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
function rmTree(p) { try { rmTree(p); } catch { /* Windowsのファイルロックは無視(一時ディレクトリ) */ } }
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { SpawnManager } from "../src/engine/spawn.js";
import { ChatHost } from "../src/engine/chat.js";
import { ensureGitRepo } from "../src/engine/discover.js";
import { runCommand } from "../src/engine/exec.js";

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

async function waitUntil(fn, ms = 45000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
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
  rmTree(ws, { recursive: true, force: true });
  rmTree(root, { recursive: true, force: true });
  rmTree(`${root}-2`, { recursive: true, force: true });
});

test("spawn: maxConcurrent=1で正常終了後、live掃除により次のspawnが即座に成功する(イシュー#26)", async () => {
  const { ws, root, bus, board, tasks } = makeEnv();
  await ensureGitRepo(ws);
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 1 },
    modelFactory: () => scriptedModel([{ text: "完了" }]),
  });
  const main = { id: "alpha", displayName: "アルファ", depth: 0 };
  const r1 = await manager.spawn({ parent: main, brief: "1体目" });
  assert.ok(r1.id);
  // 正常終了を待つ(status=done)。#26: 終了エントリはliveからexitedへ退避される
  assert.ok(await waitUntil(() => manager.snapshot()[r1.id]?.status === "done"));
  assert.equal(manager.live.size, 0, "終了後のliveエントリは掃除される(live.sizeが0に戻る)");
  assert.equal(manager.activeCount(), 0, "活性数も0(二重防护の判定が詰まらない)");
  // 次のspawnが即座に成功する(終了済みが残っていても詰まらせない)
  const r2 = await manager.spawn({ parent: main, brief: "2体目" });
  assert.ok(r2.id, "終了済みエージェントがいても次のspawnは成功する");
  assert.ok(await waitUntil(() => manager.snapshot()[r2.id]?.status === "done"));
  try { rmSync(ws, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
});

test("spawn: スポーンされたエージェントはbriefで駆動し、成果は自分のworktree→finishでmainへ", { skip: HEAVY_SKIP }, async () => {
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
  rmTree(ws, { recursive: true, force: true });
  rmTree(root, { recursive: true, force: true });
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
  rmTree(ws, { recursive: true, force: true });
});

// --- v5残課題対応: 継続ラウンドとworktree後始末 ---
test("継続ラウンド: ターン上限で中断しても1回だけ自動継続し、記憶を引き継いで完了できる", { skip: HEAVY_SKIP }, async () => {
  const { ws, root, bus, board, tasks } = makeEnv();
  await ensureGitRepo(ws);
  const received = [];
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 6 },
    maxTurns: 2,
    modelFactory: (agent) => scriptedModel([
      { toolCalls: [{ name: "write_file", args: { path: "w.txt", content: "途中まで" } }] },
      { text: "継続ラウンドで完了しました" },
    ], received),
  });
  const main = { id: "alpha", displayName: "アルファ", depth: 0 };
  const r = await manager.spawn({ parent: main, brief: "長めの作業", role: "impl" });
  assert.ok(await waitUntil(() => manager.snapshot()[r.id]?.status === "done"));
  // 2回目の呼び出し(messages)に継続ノートが入っている
  const secondCallContents = received[1]?.map((m) => m.content) ?? [];
  assert.ok(secondCallContents.some((c) => String(c).includes("ターン上限で中断")));
  // 未コミットの作業があるためworktreeは保持される
  assert.ok(await waitUntil(() => board.posts.some((p) => p.text.includes("[保持]"))));
  rmTree(ws, { recursive: true, force: true });
  rmTree(root, { recursive: true, force: true });
});

test("継続もターン上限なら諦めモード: worktree保持+[保持]告知", { skip: HEAVY_SKIP }, async () => {
  const { ws, root, bus, board, tasks } = makeEnv();
  await ensureGitRepo(ws);
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 6 },
    maxTurns: 1,
    modelFactory: () => scriptedModel([
      { toolCalls: [{ name: "write_file", args: { path: "w.txt", content: "まだ途中" } }] },
      { toolCalls: [{ name: "write_file", args: { path: "w.txt", content: "それでも途中" } }] },
    ]),
  });
  const main = { id: "alpha", displayName: "アルファ", depth: 0 };
  const r = await manager.spawn({ parent: main, brief: "終わらない作業", role: "impl" });
  assert.ok(await waitUntil(() => (manager.snapshot()[r.id]?.status ?? "").startsWith("ended")));
  assert.equal(manager.snapshot()[r.id].status, "ended:turn-limit");
  const wt = join(root, r.id);
  assert.ok(existsSync(wt)); // 保持される
  assert.ok(await waitUntil(() => board.posts.some((p) => p.text.includes("[保持]") && p.text.includes(r.id))));
  rmTree(ws, { recursive: true, force: true });
  rmTree(root, { recursive: true, force: true });
});

test("クリーン終了(マージ済み)ならworktreeとブランチを掃除する", { skip: HEAVY_SKIP }, async () => {
  const { ws, root, bus, board, tasks } = makeEnv();
  await ensureGitRepo(ws);
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 6 },
    modelFactory: (agent) => scriptedModel([
      { toolCalls: [{ name: "write_file", args: { path: "done.txt", content: "成果" } }] },
      { toolCalls: [{ name: "finish_task", args: { task_id: `spawn-${agent.id}` } }] },
      { text: "完了しました" },
    ]),
  });
  const main = { id: "alpha", displayName: "アルファ", depth: 0 };
  const r = await manager.spawn({ parent: main, brief: "クリーンな作業", role: "impl" });
  assert.ok(await waitUntil(() => manager.snapshot()[r.id]?.status === "done"));
  assert.ok(await waitUntil(() => !existsSync(join(root, r.id)), 8000)); // 掃除済み
  assert.ok(await waitUntil(async () => {
    const br = await runCommand({ command: "git branch --list agent/" + r.id, cwd: ws, outputLimit: 500 });
    return !br.text.includes("agent/" + r.id);
  }));
  rmTree(ws, { recursive: true, force: true });
  rmTree(root, { recursive: true, force: true });
});

// 連続送信の二重配信バグの回帰テスト: 各入力は正確に1回だけ届く
test("連続送信: 2通目が注入とkickoffで二重に届かない", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-dup-"));
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const received = [];
  let calls = 0;
  let release;
  const blocked = new Promise((r) => { release = r; });
  const main = { id: "alpha", displayName: "アルファ", role: "lead", depth: 0, personaPath: PERSONA };
  const host = new ChatHost({
    mains: [main],
    modelFactory: () => ({
      maxTokens: 4000,
      async chat({ messages }) {
        calls += 1;
        received.push(messages.map((m) => String(m.content)));
        if (calls === 1) await blocked; // 1通目の応答中に2通目を送る状況を再現
        return { content: `応答${calls}`, toolCalls: [], raw: { role: "assistant", content: `応答${calls}` }, usage: {} };
      },
    }),
    toolsFactory: () => ({ specs: [], detectShell: async () => "bash", execute: async () => ({ ok: true, text: "" }) }),
    board, tasks, bus,
    maxTurnsPerRound: 5, staggerMs: 0,
  });
  host.say("1つ目の指示");
  await new Promise((r) => setTimeout(r, 300)); // ラウンド1が注入を終えてモデル呼び出し中になるまで待つ
  host.say("2つ目の指示"); // ラウンド1進行中 → ボードには流れるが起床はpendingへ
  await new Promise((r) => setTimeout(r, 200));
  release();
  await new Promise((r) => setTimeout(r, 800));
  const occurrences = received.flat().filter((c) => c.includes("2つ目の指示")).length;
  assert.equal(occurrences, 1, `2つ目の指示が${occurrences}回届いた(1回であるべき)`);
  assert.equal(calls, 2, "pendingのラウンドは1回だけ走る");
  rmTree(ws);
});
