// v6.8: Hooks(beforeTool/afterTool/roundEnd)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { Hooks } from "../src/engine/hooks.js";
import { ChatHost } from "../src/engine/chat.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-hook-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}
const AGENT = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };

test("Hooks beforeTool: 非ゼロ終了でツールをブロックし、envに文脈が渡る", async () => {
  const ws = mktmp();
  const outFile = join(ws, "hook-tool.txt");
  const hooks = new Hooks({
    config: { hooks: { beforeTool: `node -e "const fs=require('fs');fs.writeFileSync('hook-tool.txt', process.env.HIVE_HOOK_TOOL + ' / ' + process.env.HIVE_HOOK_AGENT);process.exit(1)"` } },
    cwd: ws,
  });
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const tools = createTools({ agent: AGENT, workspace: ws, board, tasks, bus, hooks });
  const r = await tools.execute("write_file", { path: "out.txt", content: "x" });
  assert.equal(r.ok, false);
  assert.match(r.text, /hooksによりブロック/);
  assert.equal(existsSync(join(ws, "out.txt")), false); // ツールは実行されない
  assert.equal(readFileSync(join(ws, "hook-tool.txt"), "utf8"), "write_file / alpha");
  rmTree(ws);
});

test("Hooks afterTool: 実行結果(ツール名/成否)が渡る", async () => {
  const ws = mktmp();
  const outFile = join(ws, "hook-after.txt");
  const hooks = new Hooks({
    config: { hooks: { afterTool: `node -e "const fs=require('fs');fs.writeFileSync('hook-after.txt', process.env.HIVE_HOOK_TOOL + '=' + process.env.HIVE_HOOK_OK)"` } },
    cwd: ws,
  });
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const tools = createTools({ agent: AGENT, workspace: ws, board, tasks, bus, hooks });
  await tools.execute("write_file", { path: "ok.txt", content: "書けた" });
  assert.equal(readFileSync(join(ws, "hook-after.txt"), "utf8"), "write_file=1");
  rmTree(ws);
});

test("Hooks roundEnd: ChatHostのラウンド終了で発火する", async () => {
  const ws = mktmp();
  const ws2 = mktmp();
  const outFile = join(ws2, "rounds.txt");
  const hooks = new Hooks({
    config: { hooks: { roundEnd: `node -e "const fs=require('fs');fs.appendFileSync('rounds.txt', process.env.HIVE_HOOK_AGENT + '@' + process.env.HIVE_HOOK_THREAD + ':' + process.env.HIVE_HOOK_ENDED_BY + '\\n')"` } },
    cwd: ws2,
  });
  const bus = new Bus();
  const board = new Board(bus, "s");
  const tasks = new TaskBlackboard(ws, bus);
  const tools = createTools({ agent: { id: "s-alpha", displayName: "アルファ", role: "impl", personaText: "# S" }, workspace: ws, board, tasks, bus });
  const model = {
    maxTokens: 4000,
    async chat() {
      return { content: "完了", toolCalls: [], raw: { content: "完了" }, usage: { promptTokens: 10, completionTokens: 1 } };
    },
  };
  const host = new ChatHost({
    mains: [{ id: "s-alpha", displayName: "アルファ", role: "impl", personaText: "# S" }],
    project: "s", hooks, maxTurnsPerRound: 3, staggerMs: 0,
    modelFactory: () => model, toolsFactory: () => tools,
    board, tasks, bus,
  });
  host.say("始めて");
  const ok = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (existsSync(join(ws2, "rounds.txt"))) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return existsSync(join(ws2, "rounds.txt"));
  })();
  assert.ok(ok, "roundEndフックが記録を残す");
  assert.match(readFileSync(join(ws2, "rounds.txt"), "utf8"), /s-alpha@s:ok/);
  rmTree(ws);
  rmTree(ws2);
});
