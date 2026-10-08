// イシュー#27: MCPコマンドが存在しない場合、ChildProcessの非同期errorイベント(ENOENT)が
// 未処理でUnhandled 'error' eventとなりhiveプロセス全体が落ちていた。start()が落ちずに
// ok:falseを返し、プロセスが存続し、以後のrequestも安全に失敗することを検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpHost } from "../src/engine/mcp.js";
import { Board, Bus } from "../src/engine/board.js";

test("McpHost: 不存在コマンドでもhiveは落ちずok:falseで失敗が通知される", async () => {
  const bus = new Bus();
  const failed = [];
  bus.on("mcp.failed", (p) => failed.push(p));
  new Board(bus, "mcp-enoent"); // boardイベントの subscribers を通す(bus単体でも動くが実環境に寄せる)
  const host = new McpHost({ name: "missing", command: "definitely-missing-cmd-xyz", args: [], bus, timeoutMs: 8000 });
  const r = await host.start();
  assert.equal(r.ok, false, "start()は例外を出さずok:false");
  assert.match(r.error ?? "", /ENOENT/);
  assert.equal(failed.length, 1, "mcp.failed がbusへ流れる");
  assert.equal(failed[0].name, "missing");
  assert.equal(Boolean(host.child), true, "子プロセスは生成済み(非同期errorで失敗)");
  assert.notEqual(host.spawnError, null, "起動失敗が記録される");
});

test("McpHost: 起動失敗後のrequest/callは安全に失敗する(ok:false経路)", async () => {
  const bus = new Bus();
  const host = new McpHost({ name: "missing2", command: "definitely-missing-cmd-xyz", args: [], bus, timeoutMs: 8000 });
  await host.start();
  await assert.rejects(host.request("initialize", {}), /接続できません/, "起動失敗後のrequestは即座にreject");
  const out = await host.call("mcp__missing2__echo", { text: "x" });
  assert.equal(out.ok, false, "callはok:false(例外を握ってツール失敗として扱える)");
  assert.match(out.text ?? "", /接続できません/);
});
