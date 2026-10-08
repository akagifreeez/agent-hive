// v6.4: 使い勝勝ブラッシュアップ(edit_file replace_all / web_fetch / close_thread / threadsサマリ)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { runChat } from "../src/runner.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-brush-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ }
}
const AGENT = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };

function makeTools(ws, { mainWorkspace = null, board = null } = {}) {
  const bus = new Bus();
  const b = board ?? new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const tools = createTools({ agent: AGENT, workspace: ws, mainWorkspace: mainWorkspace ?? ws, board: b, tasks, bus });
  return { tools, tasks, board: b, bus };
}

test("edit_file replace_all: 全一致を一括置換する。無指定なら複数一致はエラーのまま", async () => {
  const ws = mktmp();
  const { tools } = makeTools(ws);
  writeFileSync(join(ws, "dup.txt"), "旧 旧 旧");
  const r = await tools.execute("edit_file", { path: "dup.txt", old_text: "旧", new_text: "新", replace_all: true });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(ws, "dup.txt"), "utf8"), "新 新 新");
  const r2 = await tools.execute("edit_file", { path: "dup.txt", old_text: "新", new_text: "x" });
  assert.equal(r2.ok, false);
  const r3 = await tools.execute("edit_file", { path: "dup.txt", old_text: "新", new_text: "!", replace_all: true });
  assert.equal(r3.ok, true);
  assert.equal(readFileSync(join(ws, "dup.txt"), "utf8"), "! ! !");
  rmTree(ws);
});

test("web_fetch: 本文を取得する。http(s)以外は拒否", async () => {
  const ws = mktmp();
  const { tools } = makeTools(ws);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k === "content-type" ? "text/html" : null) },
    text: async () => "<html>本文サンプル</html>",
  });
  try {
    const r = await tools.execute("web_fetch", { url: "https://example.com/doc", max_chars: 100 });
    assert.equal(r.ok, true);
    assert.match(r.text, /本文サンプル/);
    assert.match(r.text, /content-type: text\/html/);
    const bad = await tools.execute("web_fetch", { url: "ftp://example.com" });
    assert.equal(bad.ok, false);
  } finally {
    globalThis.fetch = origFetch;
  }
  rmTree(ws);
});

test("gather_context threads: スレッド進捗サマリを読める", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "pp");
  const tasks = new TaskBlackboard(ws, bus);
  const tools = createTools({ agent: { id: "lead", displayName: "リーダー", role: "lead", personaText: "# L" }, workspace: ws, mainWorkspace: ws, board, tasks, bus });
  // state/配下にスレッドregistryとボードログを用意(v6.1の永続化形式そのもの)
  mkdirSync(join(ws, "state"), { recursive: true });
  writeFileSync(join(ws, "state", "threads.json"), JSON.stringify([{ name: "pp", goal: "テストのゴール" }]));
  const line = (p) => JSON.stringify(p);
  writeFileSync(join(ws, "state", "board-pp.jsonl"), [
    line({ id: 1, from: "you", text: "開始", at: 1, thread: "pp" }),
    line({ id: 2, from: "pp-alpha", text: "カーネル実装完了", at: 2, thread: "pp" }),
  ].join("\n") + "\n");
  tasks.seed([{ id: "w1", project: "pp", body: "残タスク" }]);
  const r = await tools.execute("gather_context", { source: "threads" });
  assert.match(r.text, /スレッド pp/);
  assert.match(r.text, /テストのゴール/);
  assert.match(r.text, /カーネル実装完了/);
  assert.match(r.text, /未着手1/);
  rmTree(ws);
});

test("close_thread: スレッドを閉じるとregistryから外れ、再起動でも復元されない", async () => {
  const ws = mktmp();
  const config = {
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
  const modelFactory = () => ({
    maxTokens: 4000,
    async chat() {
      return { content: "承知しました", toolCalls: [], raw: { content: "承知しました" }, usage: { promptTokens: 10, completionTokens: 1 } };
    },
  });
  const ctl1 = await runChat({ config, bus: new Bus(), modelFactory });
  await ctl1.openThread({ project: "tmp", goal: "一時スレッド" });
  assert.ok(ctl1.listThreads().includes("tmp"));
  await ctl1.closeThread({ project: "tmp" });
  assert.equal(ctl1.listThreads().includes("tmp"), false);
  assert.equal(existsSync(join(ws, "state", "board-tmp.jsonl")), true); // ログは残る

  // 再起動: registryから消えているので復元されない
  const opened2 = [];
  const bus2 = new Bus();
  bus2.on("thread.opened", (p) => opened2.push(p));
  await runChat({ config, bus: bus2, modelFactory });
  assert.equal(opened2.some((t) => t.name === "tmp"), false);
  rmTree(ws);
  rmTree(`${ws}-wt`);
});
