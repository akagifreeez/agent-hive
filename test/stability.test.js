// v6.3: 暴走検知(同一呼び出し連続→リマインダ注入)とrapid-refillブレーカー(ZCode移植)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { runAgentLoop, MAX_CONSECUTIVE_RAPID_REFILLS } from "../src/engine/loop.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-stab-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ }
}

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");
const AGENT = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };
function makeEnv(ws) {
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  return { bus, board, tasks };
}

test("暴走検知: 同一ツール+同一引数の連続呼び出しにリマインダが注入される(しきい値到達時のみ)", async () => {
  const ws = mktmp();
  const { board, tasks, bus } = makeEnv(ws);
  writeFileSync(join(ws, "same.txt"), "中身");
  const tools = createTools({ agent: AGENT, workspace: ws, board, tasks, bus });
  let remindersSeen = 0;
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      // モデルから見たリマインダ数の最大を記録
      const n = messages.filter((m) => m.role === "user" && String(m.content).includes("同じ入力で")).length;
      if (n > remindersSeen) remindersSeen = n;
      return {
        content: null,
        toolCalls: [{ id: `c${messages.length}`, name: "read_file", arguments: { path: "same.txt" } }],
        raw: { content: null },
        usage: { promptTokens: 10, completionTokens: 1 },
      };
    },
  };
  const r = await runAgentLoop({ agent: AGENT, model, tools, board, tasks, bus, maxTurns: 7 });
  assert.equal(r.endedBy, "turn-limit");
  // streak===3の瞬間だけ警告(ZCode準拠)なので、モデルに見えるリマインダは1件
  assert.equal(remindersSeen, 1);
  rmTree(ws);
});

test("暴走検知: 引数が変わればストリークはリセットされる", async () => {
  const ws = mktmp();
  const { board, tasks, bus } = makeEnv(ws);
  writeFileSync(join(ws, "a.txt"), "A");
  writeFileSync(join(ws, "b.txt"), "B");
  const tools = createTools({ agent: AGENT, workspace: ws, board, tasks, bus });
  let remindersSeen = 0;
  let i = 0;
  const paths = ["a.txt", "b.txt", "a.txt", "b.txt", "a.txt", "b.txt"];
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      const n = messages.filter((m) => m.role === "user" && String(m.content).includes("同じ入力で")).length;
      if (n > remindersSeen) remindersSeen = n;
      return {
        content: null,
        toolCalls: [{ id: `c${i}`, name: "read_file", arguments: { path: paths[i++ % paths.length] } }],
        raw: { content: null },
        usage: { promptTokens: 10, completionTokens: 1 },
      };
    },
  };
  await runAgentLoop({ agent: AGENT, model, tools, board, tasks, bus, maxTurns: 6 });
  assert.equal(remindersSeen, 0); // 毎回引数が違うので警告は出ない
  rmTree(ws);
});

test("rapid-refillブレーカー: 圧縮が追いつかない連鎖で打ち切る", async () => {
  const ws = mktmp();
  const { board, tasks, bus } = makeEnv(ws);
  const tools = createTools({ agent: AGENT, workspace: ws, board, tasks, bus });
  let n = 0;
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      // 要約器(コンパクト要求)は常に成功
      if (String(messages[0]?.content).includes("要約器")) {
        return { content: "要約した", toolCalls: [], raw: { content: "要約した" }, usage: { promptTokens: 10, completionTokens: 1 } };
      }
      n++;
      if (n % 2 === 1) {
        // ツール実行ターン(usageは常に閾値超え=毎回圧縮が要る状態)
        return { content: null, toolCalls: [{ id: `c${n}`, name: "read_file", arguments: { path: "x.txt" } }], raw: { content: null }, usage: { promptTokens: 500000, completionTokens: 1 } };
      }
      // 空テキストのターン → autocompact判定が走る
      return { content: null, toolCalls: [], raw: { content: null }, usage: { promptTokens: 500000, completionTokens: 1 } };
    },
  };
  const r = await runAgentLoop({ agent: AGENT, model, tools, board, tasks, bus, maxTurns: 20 });
  assert.equal(r.endedBy, "compact-rapid-refill");
  assert.ok(board.posts.some((p) => p.text.includes("圧縮してもコンテキストが肥大し続ける")));
  rmTree(ws);
});

test("rapid-refill: 圧縮間に3ツールターン以上あればストリークはリセットされる", async () => {
  const ws = mktmp();
  const { board, tasks, bus } = makeEnv(ws);
  writeFileSync(join(ws, "y.txt"), "Y");
  const tools = createTools({ agent: AGENT, workspace: ws, board, tasks, bus });
  const steps = [
    // ラウンド前半: 圧縮後にまもなく圧縮 → rapid-refillストリーク1
    { toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "y.txt" } }], usage: { promptTokens: 10 } },
    { text: "", usage: { promptTokens: 500000 } }, // 圧縮1(refill1)
    // 中盤: 圧縮後に3ツールターン空けてから圧縮 → ストリークはリセット
    { toolCalls: [{ id: "c2", name: "read_file", arguments: { path: "y.txt" } }], usage: { promptTokens: 10 } },
    { toolCalls: [{ id: "c3", name: "read_file", arguments: { path: "y.txt" } }], usage: { promptTokens: 10 } },
    { toolCalls: [{ id: "c4", name: "read_file", arguments: { path: "y.txt" } }], usage: { promptTokens: 10 } },
    { text: "", usage: { promptTokens: 500000 } }, // 圧縮2(距離があるのでrefillリセット)
    // 後半: 普通にツールを続けてテキストで完了
    { toolCalls: [{ id: "c5", name: "read_file", arguments: { path: "y.txt" } }], usage: { promptTokens: 10 } },
    { text: "完了しました" },
  ];
  let i = 0;
  let compacts = 0;
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      if (String(messages[0]?.content).includes("要約器")) {
        compacts++;
        return { content: "要約した", toolCalls: [], raw: { content: "要約した" }, usage: { promptTokens: 10, completionTokens: 1 } };
      }
      const step = steps[Math.min(i++, steps.length - 1)];
      return {
        content: step.text ?? null,
        toolCalls: (step.toolCalls ?? []).map((tc) => ({ ...tc })),
        raw: { content: step.text ?? null },
        usage: { promptTokens: step.usage?.promptTokens ?? 10, completionTokens: 1 },
      };
    },
  };
  const r = await runAgentLoop({ agent: AGENT, model, tools, board, tasks, bus, maxTurns: 12 });
  assert.equal(compacts, 2);
  assert.notEqual(r.endedBy, "compact-rapid-refill");
  assert.equal(r.ok, true);
  rmTree(ws);
});
