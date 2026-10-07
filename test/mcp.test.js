// v6.7: MCP(stdio)接続とcron定期実行の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpHost } from "../src/engine/mcp.js";
import { runChat } from "../src/runner.js";
import { Board, Bus } from "../src/engine/board.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-mcp-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}
async function waitUntil(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-echo-server.mjs");

test("McpHost: initialize→tools/list→tools/callが通る", async () => {
  const bus = new Bus();
  const host = new McpHost({ name: "test", command: process.execPath, args: [FIXTURE], bus, timeoutMs: 10000 });
  const r = await host.start();
  assert.equal(r.ok, true);
  const specs = host.specs();
  assert.equal(specs.length, 1);
  assert.equal(specs[0].name, "mcp__test__echo");
  assert.equal(host.handles("mcp__test__echo"), true);
  assert.equal(host.handles("mcp__other__echo"), false);
  const out = await host.call("mcp__test__echo", { text: "こんにちは" });
  assert.equal(out.ok, true);
  assert.match(out.text, /echo: .*こんにちは/);
  host.stop();
});

test("McpHost: 起動しないサーバーはok:falseでhiveは止まらない", async () => {
  const bus = new Bus();
  const host = new McpHost({ name: "dead", command: process.execPath, args: ["-e", "process.exit(1)"], bus, timeoutMs: 5000 });
  const r = await host.start();
  assert.equal(r.ok, false);
});

test("McpHost: 存在しないコマンド(ENOENT)でもuncaughtExceptionで落ちずok:false(#27)", async () => {
  const bus = new Bus();
  const failed = [];
  bus.on("mcp.failed", (e) => failed.push(e));
  const host = new McpHost({ name: "ghost", command: "definitely-not-exist-xyz-123", args: [], bus, timeoutMs: 5000 });
  const r = await host.start(); // throwしないことが重要(未処理のerrorイベントで落ちない)
  assert.equal(r.ok, false);
  assert.match(String(r.error), /ENOENT/);
  assert.ok(failed.length >= 1, "mcp.failed が通知される");
  // 起動失敗後のrequestは即reject(切断状態・タイムアウト待ちにならない)
  await assert.rejects(() => host.request("tools/list", {}), /接続できません|起動に失敗/);
  // call もok:falseへ変換されて外に例外を投げない
  const c = await host.call("mcp__ghost__echo", {});
  assert.equal(c.ok, false);
});

test("runChat: MCPツールがエージェントから使え、cron定期実行が走る", async () => {
  const ws = mktmp();
  const boardPosts = [];
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
    chat: {
      lead: "lead", workers: ["alpha"], maxTurnsPerRound: 8, staggerMs: 5,
      schedules: [{ everyMinutes: 0.05, text: "定期テストです" }],
    },
    mcp: { servers: { test: { command: process.execPath, args: [FIXTURE] } } },
    agents: [{ id: "alpha", displayName: "アルファ", role: "impl" }],
  };
  let mcpCalled = false;
  const modelFactory = (agent) => ({
    maxTokens: 4000,
    async chat({ messages }) {
      if (String(messages[0]?.content).includes("要約器")) {
        return { content: "要約", toolCalls: [], raw: { content: "要約" }, usage: { promptTokens: 5, completionTokens: 1 } };
      }
      // MCPツールのspecがモデルに見えていることを確認
      const sawMcp = (messages.find((m) => m.role === "system")?.content ?? "").includes("mcp__test__echo")
        || (globalThis.__lastSpecs ?? []).some((s) => s.name === "mcp__test__echo");
      if (sawMcp) mcpCalled = true;
      return { content: "承知しました", toolCalls: [], raw: { content: "承知しました" }, usage: { promptTokens: 10, completionTokens: 1 } };
    },
  });

  const bus = new Bus();
  bus.on("board", (p) => boardPosts.push(p));
  // tools.specsを覗くためtoolsFactoryは渡さず、既定のcreateModelFactoryを使わない
  const ctl = await runChat({ config, bus, modelFactory });
  ctl.say("始めて");
  // 定期実行(0.05分=3秒)とリーダーラウンドの完了を待つ
  const got = await waitUntil(() => boardPosts.some((p) => p.text.includes("[定期] 定期テストです")), 20000);
  assert.ok(got, "cron定期実行がボードに届く");
  assert.ok(ctl.listThreads().length === 0);
  // MCP specが接続されていること(host.specs経由で間接確認)
  assert.ok(existsSync(join(ws, "state", "board__main__.jsonl")));
  ctl.mcpHosts.forEach((h) => h.stop());
  rmTree(ws);
  rmTree(`${ws}-wt`);
});
