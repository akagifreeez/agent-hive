// v6.6: ツール拡張(web_search/search_files/glob_files)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-ext-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}
const AGENT = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };

function makeTools(ws) {
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  return createTools({ agent: AGENT, workspace: ws, board, tasks, bus });
}

test("search_files: 正規表現でfile:行を返し、globで絞れる", async () => {
  const ws = mktmp();
  const tools = makeTools(ws);
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src", "a.mjs"), "export const RATE = 42;\nconst other = 1;\n");
  writeFileSync(join(ws, "note.md"), "RATEという語があるが対象外\n");
  const r = await tools.execute("search_files", { pattern: "RATE = 42", glob: "*.mjs" });
  assert.equal(r.ok, true);
  assert.match(r.text, /src\/a\.mjs:1: export const RATE = 42/);
  assert.doesNotMatch(r.text, /note\.md/);
  const none = await tools.execute("search_files", { pattern: "存在しない語" });
  assert.match(none.text, /一致なし/);
  rmTree(ws);
});

test("glob_files: パターンで一覧できる(**は深さ無制限)", async () => {
  const ws = mktmp();
  const tools = makeTools(ws);
  mkdirSync(join(ws, "src", "deep"), { recursive: true });
  writeFileSync(join(ws, "top.md"), "x");
  writeFileSync(join(ws, "src", "a.js"), "1");
  writeFileSync(join(ws, "src", "deep", "b.js"), "2");
  const all = await tools.execute("glob_files", { pattern: "**/*.js" });
  assert.match(all.text, /src\/a\.js/);
  assert.match(all.text, /src\/deep\/b\.js/);
  assert.doesNotMatch(all.text, /top\.md/);
  const shallow = await tools.execute("glob_files", { pattern: "*.md" });
  assert.match(shallow.text, /top\.md/);
  rmTree(ws);
});

test("web_search: DuckDuckGo HTMLからタイトルとURLを取り出す(uddgリダイレクト対応)", async () => {
  const ws = mktmp();
  const tools = makeTools(ws);
  const origFetch = globalThis.fetch;
  const html = `
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">最初の<strong>結果</strong></a>
    <a rel="nofollow" class="result__a" href="https://direct.example.com/b">直接リンク</a>`;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => html, headers: { get: () => "text/html" } });
  try {
    const r = await tools.execute("web_search", { query: "テスト", max_results: 5 });
    assert.equal(r.ok, true);
    assert.match(r.text, /最初の結果/);
    assert.match(r.text, /https:\/\/example\.com\/a/);
    assert.match(r.text, /https:\/\/direct\.example\.com\/b/);
  } finally {
    globalThis.fetch = origFetch;
  }
  const bad = await tools.execute("web_search", { query: "" });
  assert.equal(bad.ok, false);
  rmTree(ws);
});
