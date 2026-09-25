// v5.3: 永続記憶(memory/権威ファイル)+distill-learnings発見の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";

function rmTree(p) { try { rmTree(p); } catch { /* Windowsのファイルロックは無視 */ } }
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryDir, listMemoryFiles, buildMemoryContext } from "../src/engine/memory.js";
import { buildCompactRequest, COMPACT_SYSTEM_PROMPT } from "../src/engine/compact.js";
import { startDiscovery, DISTILL_TASK_ID } from "../src/engine/discover.js";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { runAgentLoop } from "../src/engine/loop.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-mem-"));
}

test("buildMemoryContext: ファイル無しは空、あれば権威ブロックを生成", () => {
  const ws = mktmp();
  assert.equal(buildMemoryContext(ws), "");
  mkdirSync(memoryDir(ws), { recursive: true });
  writeFileSync(join(memoryDir(ws), "decisions.md"), "CUDA 13.3 / sm_89 をターゲットにする");
  writeFileSync(join(memoryDir(ws), "notes.txt"), "md以外は無視");
  const ctx = buildMemoryContext(ws);
  assert.match(ctx, /<persistent-memory>/);
  assert.match(ctx, /## decisions\.md/);
  assert.match(ctx, /sm_89/);
  assert.doesNotMatch(ctx, /notes\.txt/);
  assert.deepEqual(listMemoryFiles(ws), ["decisions.md"]);
  rmTree(ws);
});

test("buildCompactRequest: hasMemoryで権威分離指示が乗る", () => {
  const msgs = [{ role: "user", content: "hi" }];
  const withMem = buildCompactRequest(msgs, { hasMemory: true });
  assert.match(withMem[0].content, /権威分離/);
  assert.match(withMem[0].content, /memory\//);
  const without = buildCompactRequest(msgs, { taskContext: "タスク t1: 仕事" });
  assert.doesNotMatch(without[0].content, /権威分離/);
  assert.match(without[0].content, /読み取り時キュレーション/);
  const plain = buildCompactRequest(msgs);
  assert.equal(plain[0].content, COMPACT_SYSTEM_PROMPT);
});

test("ループ統合: memoryを渡すとシステムプロンプトへ注入される", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md") };
  const tools = createTools({ agent, workspace: ws, board, tasks, bus });
  let sysSeen = null;
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      sysSeen = messages[0].content;
      return { content: "ok", toolCalls: [], raw: { content: "" } };
    },
  };
  const mem = "<persistent-memory>lesson: 常にテストを先に書く</persistent-memory>";
  await runAgentLoop({ agent, model, tools, board, tasks, bus, maxTurns: 1, messages: null, memory: mem, shellKind: "bash" });
  assert.match(sysSeen, /persistent-memory/);
  assert.match(sysSeen, /テストを先に書く/);
  rmTree(ws);
});

// 発見器: 完了タスクの未処理があればdistill-learningsを起票し、静かなら起票しない
test("発見器distill: 未処理のdoneがある+静か → 起票。通常タスク残存 → 起票しない", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const d = startDiscovery({ workspace: ws, tasks, bus, intervalSec: 3600 });

  // 通常タスクが開いている間は起票しない
  tasks.seed([{ id: "t1", role: null, body: "通常の仕事" }]);
  await d.tick();
  assert.equal(existsSync(join(ws, "tasks/open", `${DISTILL_TASK_ID}.md`)), false);

  // 完着して静かになった → 起票
  const a = tasks.claim({ id: "alpha", role: "x" });
  tasks.finish({ id: "alpha" }, a.id);
  await d.tick();
  assert.equal(existsSync(join(ws, "tasks/open", `${DISTILL_TASK_ID}.md`)), true);

  // 二重起票しない
  await d.tick();
  const opens = tasks.snapshot().open.filter((f) => f.startsWith(DISTILL_TASK_ID));
  assert.equal(opens.length, 1);
  d.stop();
  rmTree(ws);
});

test("発見器distill: finishでマーカーが進み、再起票されない。未処理ゼロの残置は自動解決", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const d = startDiscovery({ workspace: ws, tasks, bus, intervalSec: 3600 });

  tasks.seed([{ id: "t1", role: null, body: "仕事" }]);
  tasks.claim({ id: "alpha", role: "x" });
  tasks.finish({ id: "alpha" }, "t1");
  await d.tick(); // 起票
  // alphaがdistillタスクを請求して完了 → task.finished経由でマーカーが進む
  tasks.claim({ id: "alpha", role: null });
  tasks.finish({ id: "alpha" }, DISTILL_TASK_ID);
  await d.tick();
  assert.equal(existsSync(join(ws, "tasks/open", `${DISTILL_TASK_ID}.md`)), false);
  const marker = readFileSync(join(ws, "memory/.distilled"), "utf8");
  assert.match(marker, /alpha--t1/);
  assert.match(marker, /alpha--distill-learnings/);

  // マーカーが無い時代の残置タスク(未処理ゼロ)は自動解決される
  tasks.create({ id: DISTILL_TASK_ID, body: "古い残置" });
  await d.tick();
  assert.equal(existsSync(join(ws, "tasks/open", `${DISTILL_TASK_ID}.md`)), false);
  assert.ok(tasks.snapshot().done.some((f) => f.includes(`auto--${DISTILL_TASK_ID}`)));
  d.stop();
  rmTree(ws);
});
