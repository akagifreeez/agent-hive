// イシュー#26対応: 終了したワーカーがlive Mapに残り、autoscaleの同時実行数判定
// (runner.js: manager.live.size >= globalCap)とspawn()の上限判定が満杯のままになり、
// spawnが永久に詰まる問題の回帰テスト。
// 期待: ワーカー正常終了後、liveエントリが掃除され(activeCount 0・次のspawnが即成功)、
// それでも snapshot() は終了済みステータス(done)を返し続ける(既存テスト/UI互換)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { SpawnManager } from "../src/engine/spawn.js";
import { ensureGitRepo } from "../src/engine/discover.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ }
}

function scriptedModel() {
  return {
    maxTokens: 4000,
    async chat() {
      return {
        content: "完了しました",
        toolCalls: [],
        raw: { role: "assistant", content: "完了しました", tool_calls: [] },
        usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.0001 },
      };
    },
  };
}

async function waitUntil(fn, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

function makeEnv(tag) {
  const ws = mkdtempSync(join(tmpdir(), `hive-slot-${tag}-`));
  const root = `${ws}-wt`;
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  return { ws, root, bus, board, tasks };
}

test("#26: maxConcurrent=1で起動→正常終了後、liveが掃除され次のspawnが即座に成功する", async () => {
  const { ws, root, bus, board, tasks } = makeEnv("a");
  await ensureGitRepo(ws);
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 1 },
    modelFactory: () => scriptedModel(),
  });
  const main = { id: "alpha", displayName: "アルファ", depth: 0 };
  // 1体目: maxConcurrent=1なので起動できる
  const r1 = await manager.spawn({ parent: main, brief: "1体目", role: "impl" });
  assert.ok(r1.id, "1体目は起動する");
  assert.equal(manager.activeCount(), 1, "走行中は活性1");
  // 正常終了を待つ
  assert.ok(await waitUntil(() => manager.snapshot()[r1.id]?.status === "done"), "ワーカーが正常終了する");
  // 終了後: liveは掃除され、活性0に戻る(#26の本題)
  assert.equal(manager.activeCount(), 0, "終了後は活性0(liveの掃除)");
  assert.equal(manager.live.size, 0, "終了済みはlive Mapから外れる");
  // 2体目: 終了済みに枠を奪われず、即座に起動できる
  const r2 = await manager.spawn({ parent: main, brief: "2体目", role: "impl" });
  assert.ok(r2.id, "終了済みエントリのせいで次のspawnが詰まらない(#26)");
  assert.ok(await waitUntil(() => manager.snapshot()[r2.id]?.status === "done"));
  // snapshot互換: 終了済みのステータスは引き続き参照できる(UI・既存テストの退場待ち)
  assert.equal(manager.snapshot()[r1.id].status, "done", "snapshotは終了済みも保持する(互換)");
  await new Promise((r) => setTimeout(r, 300)); // 後始末(git status等)の収束待ち
  rmTree(ws); rmTree(root);
});

test("#26: 二重防护 — liveに終了済みstatusが残っていてもactiveCountは数えない", () => {
  const bus = new Bus();
  const manager = new SpawnManager({
    mainWorkspace: ".", worktreeRoot: ".", board: new Board(bus),
    tasks: new TaskBlackboard(".", bus),
    hierarchy: { maxDepth: 2, maxConcurrent: 1 },
    modelFactory: () => scriptedModel(),
  });
  // 削除漏れを模擬: 終了済みエントリがliveに残留する状態
  manager.live.set("w-9", { displayName: "w9", depth: 1, parent: "alpha", status: "done" });
  assert.equal(manager.activeCount(), 0, "status!==workingは活性として数えない");
  assert.equal(manager.snapshot()["w-9"].status, "done", "snapshotは終了済みも見える");
});

test("#26: ended系(異常終了)もliveから外れ、次のspawnを塞がない", async () => {
  const { ws, root, bus, board, tasks } = makeEnv("b");
  await ensureGitRepo(ws);
  const boom = {
    maxTokens: 4000,
    async chat() { throw new Error("モデル異常"); },
  };
  const manager = new SpawnManager({
    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,
    hierarchy: { maxDepth: 2, maxConcurrent: 1 },
    modelFactory: () => boom,
  });
  const main = { id: "alpha", displayName: "アルファ", depth: 0 };
  const r = await manager.spawn({ parent: main, brief: "異常系", role: "impl" });
  assert.ok(await waitUntil(() => String(manager.snapshot()[r.id]?.status ?? "").startsWith("ended")), "異常終了の記録");
  assert.equal(manager.activeCount(), 0, "異常終了後も活性0");
  const r2 = await manager.spawn({ parent: main, brief: "再挑戦", role: "impl" });
  assert.ok(r2.id, "ended後も次のspawnは詰まらない");
  assert.ok(await waitUntil(() => String(manager.snapshot()[r2.id]?.status ?? "").startsWith("ended")));
  await new Promise((r) => setTimeout(r, 300)); // 後始末(git status等)の収束待ち
  rmTree(ws); rmTree(root);
});
