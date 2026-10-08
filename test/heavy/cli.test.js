// hive CLI(bin/hive.js): 稼働中のUIサーバーへの操作が通ること
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Bus } from "../../src/engine/board.js";
import { startUi as _startUi } from "../../src/ui/server.js";
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

  // release: 未claim(担当のいない)タスクの解放はべき等で成功する
  // (releaseOne が「既に無い=解放済み」冪等化されたため。dash lab実害=二重宙吊り
  //  デッドロック対策とセットの意図的変更。旧契約「非ゼロ+解放できません」は廃止)
  const r = await runCli(["tasks", "release", "cli-t2"], port, token);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /cli-t2 を解放しました/);

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
