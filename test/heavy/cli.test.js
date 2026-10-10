// hive CLI(bin/hive.js): 稼働中のUIサーバーへの操作が通ること
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Bus } from "../../src/engine/board.js";
import { startUi as _startUi } from "../../src/ui/server.js";
import { chatUiHandlers } from "../../src/ui/chat-wiring.js";
// test-hf-token-inject: UIサーバーのPOSTはCSRFトークンを要求するため、
// テスト内のfetchは全てトークン付きへ差し替える(startUi後にtokenedFetchOn()を呼ぶ)
import { tokenedFetchOn, startUiTokenized } from "../helpers/hf-token.js";
tokenedFetchOn();


const CLI = join(fileURLToPath(new URL("../../bin/hive.js", import.meta.url)));

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-cli-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

function runCli(args, port, token = null) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, "--port", String(port), ...args], { timeout: 20000, encoding: "utf8", env: { ...process.env, ...(token ? { HIVE_UI_TOKEN: token } : {}) } }, (err, stdout, stderr) => {
      resolve({ code: err && err.code ? err.code : 0, stdout, stderr: stderr ?? "" });
    });
  });
}

// stdinパイプ版(「hive say -」用)。spawnSyncのinputはこの環境で子プロセスが
// 停留する(実測: 30秒でfetchにすら到達しない)ため、execFileでstdinへ書いて閉じる
function runCliWithStdin(args, port, token, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, "--port", String(port), ...args], { timeout: 20000, encoding: "utf8", env: { ...process.env, ...(token ? { HIVE_UI_TOKEN: token } : {}) } }, (err, stdout, stderr) => {
      resolve({ code: err && err.code ? err.code : 0, stdout, stderr: stderr ?? "" });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

test("CLI: status/board/tasksが実サーバーに対して動く", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "test-model" }, agents: [] };
  const ui = await startUiTokenized(_startUi, { config, modelFactory: () => ({}), bus, autoStart: false });
  const port = config.ui.port, token = ui.token;
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
  assert.match(help.stdout, /notify/, "CLIヘルプにnotifyサブコマンドが載る(#11)");

  // notifyサブコマンド: monitorPort未指定(UIのみ)なら分かりやすい案内で非ゼロ終了
  const nf = await runCli(["notify"], port);
  assert.equal(nf.code, 1);
  assert.match(nf.stderr, /監視\(monitor\)が無効/);

  ui.close();
  rmTree(ws);
});

test("CLI: sayがサーバーに届き、feedback・pauseも通る", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "test-model" }, agents: [] };
  const got = [];
  const ui = await startUiTokenized(_startUi, {
    config, modelFactory: () => ({}), bus, autoStart: false,
    onSay: (text, thread) => got.push({ kind: "say", text, thread }),
    onFeedback: (req) => { got.push({ kind: "fb", ...req }); return { ok: true, id: `fb-${req.taskId}-x`, thread: req.thread }; },
    onThreadPause: (req) => { got.push({ kind: "pause", ...req }); return { ok: true, name: req.project, paused: req.paused }; },
  });
  const port = config.ui.port, token = ui.token;

  const said = await runCli(["say", "CLIから", "こんにちは"], port, token);
  assert.equal(said.code, 0);
  assert.match(said.stdout, /送信しました/);

  const fb = await runCli(["feedback", "t9", "テストを足して"], port, token);
  assert.equal(fb.code, 0);
  assert.match(fb.stdout, /fb-t9-x/);

  const paused = await runCli(["pause", "demo"], port, token);
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

test("CLI: cancel/release/reopen/auditが実サーバーに対して動く", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "test-model" }, agents: [] };
  const ui = await startUiTokenized(_startUi, { config, modelFactory: () => ({}), bus, autoStart: false });
  const port = config.ui.port, token = ui.token;

  // タスクを2件起票(1件はdoneにしておいてreopenを試す)
  const mk = (id) => fetch(`http://127.0.0.1:${port}/api/tasks`, { method: "POST", headers: { "content-type": "application/json", "x-hive-token": token, origin: "http://localhost" }, body: JSON.stringify({ action: "create", id, body: "テスト用" }) });
  await (await mk("cli-t1")).json();
  await (await mk("cli-t2")).json();

  // audit台帳の代わりのファイルを用意(新しい順で表示されること)
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(ws, "state"), { recursive: true });
  writeFileSync(join(ws, "state", "audit.jsonl"), [
    JSON.stringify({ at: "2020-01-01T00:00:00Z", tool: "old" }),
    JSON.stringify({ at: "2021-01-01T00:00:00Z", tool: "new" }),
  ].join("\n") + "\n");

  // cancel: openのタスクを中止
  const c = await runCli(["tasks", "cancel", "cli-t1"], port, token);
  assert.equal(c.code, 0);
  assert.match(c.stdout, /cli-t1/);

  // cancel: openでないタスクはエラーで非ゼロ
  const c2 = await runCli(["tasks", "cancel", "cli-t1"], port, token);
  assert.notEqual(c2.code, 0);
  assert.match(c2.stderr, /中止できません/);

  // release: 未claim(担当のいない)タスクの解放は拒否される
  // (c6d3e96で契約変更: claimed/<agent>--<id>.mdが成り立たない空agentIdの解放要求は
  //  べき等成功させずfalseで拒否。旧契約「既に無い=解放済みで成功」は廃止された)
  const r = await runCli(["tasks", "release", "cli-t2"], port, token);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /解放できません/);

  // reopen: doneタスクを再open(一旦cancel済みのcli-t1はdone扱い)
  const ro = await runCli(["tasks", "reopen", "cli-t1"], port, token);
  assert.equal(ro.code, 0);
  assert.match(ro.stdout, /cli-t1/);

  // audit: 新しい順に表示
  const a = await runCli(["audit", "-n", "10"], port, token);
  assert.equal(a.code, 0);
  const ai = a.stdout.indexOf("new");
  const ao = a.stdout.indexOf("old");
  assert.ok(ai >= 0 && ao >= 0 && ai < ao, `新しい順であること: ${a.stdout}`);
  assert.match(a.stdout, /2/); // 件数表示

  ui.close();
  rmTree(ws);
});

test("CLI: say --file / say - (stdin) がUTF-8のまま届く(端末文字コード化けの回避)", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "test-model" }, agents: [] };
  const says = [];
  const controller = { say: (text, thread) => says.push([text, thread]) };
  const ui = await startUiTokenized(_startUi, { config, modelFactory: () => ({}), bus, autoStart: false, ...chatUiHandlers(controller) });
  const port = config.ui.port, token = ui.token;

  // --file: UTF-8ファイルの本文がそのまま届く(cp932端末を通さない)
  const msgPath = join(ws, "msg.txt");
  writeFileSync(msgPath, "ファイル経由の日本語指示\n2行目", "utf8");
  const viaFile = await runCli(["say", "--file", msgPath, "--thread", "demo"], port, token);
  assert.equal(viaFile.code, 0);
  assert.match(viaFile.stdout, /送信しました/);
  assert.deepEqual(says.at(-1), ["ファイル経由の日本語指示\n2行目", "demo"]);

  // -: 標準入力からのパイプ入力(引数が「-」のみのとき)
  const viaStdin = await runCliWithStdin(["say", "-"], port, token, "stdinからの指示");
  assert.equal(viaStdin.code, 0, viaStdin.stderr);
  assert.deepEqual(says.at(-1), ["stdinからの指示", null]);

  // 空本文は分かりやすいエラーで非ゼロ終了(サーバーに空のPOSTを送らない)
  const empty = await runCliWithStdin(["say", "-"], port, token, "   \n");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /言うことがありません/);
  assert.equal(says.length, 2);

  ui.close();
  rmTree(ws);
});
