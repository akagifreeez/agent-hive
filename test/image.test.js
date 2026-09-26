// v6.10: 画像対応(マルチモーダル入力/画像描画/トークン概算)の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { ChatHost } from "../src/engine/chat.js";
import { estimateMessagesTokens } from "../src/engine/compact.js";
import "../src/ui/public/markdown.js";

const renderMarkdown = globalThis.renderMarkdown;

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-img-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}
async function waitUntil(fn, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

test("markdown: 画像は/uploads/とdata:のみ描画し、外部URLやjavascript:は不可", () => {
  const ok = renderMarkdown("![説明](/uploads/img-abc.png)");
  assert.match(ok, /<img src="\/uploads\/img-abc\.png"/);
  assert.match(ok, /alt="説明"/);
  const data = renderMarkdown("![x](data:image/png;base64,AAA)");
  assert.match(data, /<img src="data:image\/png/);
  const ext = renderMarkdown("![x](https://evil.example/pic.png)");
  assert.doesNotMatch(ext, /<img/);
  const js = renderMarkdown("![x](javascript:alert(1))");
  assert.doesNotMatch(js, /<img/); // 描画されない(テキストとして表示されるだけで安全)
  assert.doesNotMatch(js, /href="javascript/);
});

test("estimateMessagesTokens: 画像content配列を概算に含める", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "あ".repeat(30) }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
  ];
  const r = estimateMessagesTokens(msgs);
  assert.ok(r >= 1000, "画像を1000トークン以上として概算する");
});

test("ChatHost attachImage: 画像メッセージがターン境界でマルチモーダルとして届く", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "s");
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "s-alpha", displayName: "アルファ", role: "impl", personaText: "# S" };
  const tools = createTools({ agent, workspace: ws, board, tasks, bus });
  const seen = [];
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      for (const m of messages) {
        if (Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")) {
          seen.push(m.content.find((p) => p.type === "text")?.text ?? "");
        }
      }
      return { content: "画像を確認しました", toolCalls: [], raw: { content: "画像を確認しました" }, usage: { promptTokens: 10, completionTokens: 1 } };
    },
  };
  const host = new ChatHost({
    mains: [agent], project: "s", maxTurnsPerRound: 3, staggerMs: 0,
    modelFactory: () => model, toolsFactory: () => tools,
    board, tasks, bus,
  });
  host.attachImage("スクショです", "data:image/png;base64,AAA");
  assert.ok(await waitUntil(() => seen.length >= 1, 8000), "画像メッセージがモデルへ届く");
  assert.match(seen[0], /スクショです/);
  rmTree(ws);
});
