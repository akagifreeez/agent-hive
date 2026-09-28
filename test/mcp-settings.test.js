// 設定ウィンドウからのMCPサーバー追加/削除:
// 1) /api/mcp のGET/POSTがハンドラへ届くこと(配線の検証)
// 2) mcpAddと同じ手順が実物のstdioサーバーを起動してツールへ載せ、hive.local.jsonへ永続化すること
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { McpHost } from "../src/engine/mcp.js";
import { startUi as _startUi } from "../src/ui/server.js";
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";
tokenedFetchOn();

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-mcpset-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}
async function fetchJson(url, body = null) {
  const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  return { status: r.status, body: await r.json() };
}

test("/api/mcp: GETは一覧、POSTはopに応じてハンドラへ届く", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const calls = [];
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "m" }, agents: [] };
  await startUiTokenized(_startUi, {
    config, modelFactory: () => ({}), bus, autoStart: false,
    onMcpList: () => [{ name: "echo", command: "node", args: ["x.mjs"], envKeys: ["TOK"], tools: ["echo"], started: true }],
    onMcpAdd: async (req) => { calls.push({ op: "add", ...req }); return { ok: true, tools: 1 }; },
    onMcpRemove: (req) => { calls.push({ op: "remove", ...req }); return { ok: true }; },
  });
  const base = `http://127.0.0.1:${config.ui.port}`;

  const list = await fetchJson(`${base}/api/mcp`);
  assert.equal(list.status, 200);
  assert.equal(list.body.servers[0].name, "echo");
  assert.deepEqual(list.body.servers[0].envKeys, ["TOK"]);

  const add = await fetchJson(`${base}/api/mcp`, { op: "add", name: "a", command: "node", args: ["a.mjs"], env: { K: "v" } });
  assert.equal(add.status, 200);
  assert.equal(add.body.ok, true);

  const del = await fetchJson(`${base}/api/mcp`, { op: "remove", name: "a" });
  assert.equal(del.status, 200);

  const bad = await fetchJson(`${base}/api/mcp`, { op: "bogus" });
  assert.equal(bad.status, 400);
  assert.deepEqual(calls, [
    { op: "add", name: "a", command: "node", args: ["a.mjs"], env: { K: "v" } },
    { op: "remove", name: "a" },
  ]);
  rmTree(ws);
});

test("mcpAddの手順: 実物のstdioサーバーを起動してツールへ載せ、hive.local.jsonへ永続化する", async () => {
  const ws = mktmp();
  const dataDir = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "ms");
  const tasks = new TaskBlackboard(ws, bus);
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-echo-server.mjs");
  // mcpHosts配列はコントローラと各ラウンドのツール一覧で共有(runner.jsの実装と同じ構造)
  const hosts = [];

  const localPath = join(dataDir, "hive.local.json");
  const readLocal = () => (existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : {});
  const writeLocalServers = (servers) => {
    const local = readLocal();
    local.mcp = { ...(local.mcp ?? {}), servers };
    writeFileSync(localPath, JSON.stringify(local, null, 1));
  };

  // コントローラ(mcpAdd)と同じ手順で追加
  const mcpHost = new McpHost({ name: "echo", command: process.execPath, args: [FIXTURE], env: { HIVE_MCP_TOKEN: "t" }, bus });
  const r = await mcpHost.start();
  assert.equal(r.ok, true);
  assert.ok(r.tools >= 1);
  hosts.push(mcpHost);
  writeLocalServers({ echo: { command: process.execPath, args: [FIXTURE], env: { HIVE_MCP_TOKEN: "t" } } });

  // ツール一覧に mcp__echo__* が載る(createToolsは毎ラウンド作り直されるため動的に反映される)
  const agent = { id: "ms-a", displayName: "A", role: "impl", personaText: "# A" };
  const tools = createTools({ agent, workspace: ws, mainWorkspace: ws, board, tasks, bus, mcpHosts: hosts });
  const spec = tools.specs.find((s) => s.name === "mcp__echo__echo");
  assert.ok(spec, "MCPツールがspecsに載る");

  // 永続化の検証
  const local = readLocal();
  assert.equal(local.mcp.servers.echo.command, process.execPath);

  mcpHost.stop();
  rmTree(ws); rmTree(dataDir);
});
