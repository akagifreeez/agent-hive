// hive CLI(bin/hive.js): 稼働中のUIサーバーへの操作が通ること
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Bus } from "../src/engine/board.js";
import { startUi } from "../src/ui/server.js";

const CLI = join(fileURLToPath(new URL("../bin/hive.js", import.meta.url)));

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-cli-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

function runCli(args, port) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, "--port", String(port), ...args], { timeout: 20000, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err && err.code ? err.code : 0, stdout, stderr: stderr ?? "" });
    });
  });
}

test("CLI: status/board/tasksが実サーバーに対して動く", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "test-model" }, agents: [] };
  const ui = await startUi({ config, modelFactory: () => ({}), bus, autoStart: false });
  const port = config.ui.port;
  bus.emit("board", { id: 1, from: "system", text: "[テスト] 起動確認", at: Date.now(), thread: "__main__" });

  const st = await runCli(["status"], port);
  assert.equal(st.code, 0);
  assert.match(st.stdout, /model=test-model/);
  assert.match(st.stdout, /未着手0/);

  const board = await runCli(["board", "-n", "5"], port);
  assert.equal(board.code, 0);
  assert.match(board.stdout, /起動確認/);

  const help = await runCli(["--help"], port);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /agent-hive CLI/);

  ui.close();
  rmTree(ws);
});

test("CLI: sayがサーバーに届き、feedback・pauseも通る", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "test-model" }, agents: [] };
  const got = [];
  const ui = await startUi({
    config, modelFactory: () => ({}), bus, autoStart: false,
    onSay: (text, thread) => got.push({ kind: "say", text, thread }),
    onFeedback: (req) => { got.push({ kind: "fb", ...req }); return { ok: true, id: `fb-${req.taskId}-x`, thread: req.thread }; },
    onThreadPause: (req) => { got.push({ kind: "pause", ...req }); return { ok: true, name: req.project, paused: req.paused }; },
  });
  const port = config.ui.port;

  const said = await runCli(["say", "CLIから", "こんにちは"], port);
  assert.equal(said.code, 0);
  assert.match(said.stdout, /送信しました/);

  const fb = await runCli(["feedback", "t9", "テストを足して"], port);
  assert.equal(fb.code, 0);
  assert.match(fb.stdout, /fb-t9-x/);

  const paused = await runCli(["pause", "demo"], port);
  assert.equal(paused.code, 0);
  assert.match(paused.stdout, /demo を停止/);

  assert.deepEqual(
    got.map((g) => [g.kind, g.text ?? g.taskId ?? g.project]),
    [["say", "CLIから こんにちは"], ["fb", "t9"], ["pause", "demo"]],
  );

  ui.close();
  rmTree(ws);
});

test("CLI: 本体が無いときは分かりやすいエラーで非ゼロ終了", async () => {
  const r = await runCli(["status"], 59907); // 空いていそうなポート(未リッスン)
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /接続できません/);
});
