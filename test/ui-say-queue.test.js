// 起動直後のsay黙落とし対策: UI立ち上げが先でcontroller(runChat戻り値)は後から入るため、
// 接続までの /api/say は ok:true だけ返して入力を捨てていた(2026-10-06実証の実事故)。
// chat-wiringがqueueし、controller接続後のflushPendingSay()で配信することを検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi as _startUi } from "../src/ui/server.js";
import { chatUiHandlers } from "../src/ui/chat-wiring.js";
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";
tokenedFetchOn();

function mktmp() { return mkdtempSync(join(tmpdir(), "hive-sayq-")); }
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

test("controller接続前のsayはqueueされ、flushで到着順に配信される", () => {
  const calls = [];
  let controller = null;
  const wiring = chatUiHandlers(() => controller);
  wiring.onSay("最初の指示", "demo");
  wiring.onSay("2番目", null);
  assert.equal(wiring.pendingSayCount(), 2);
  controller = { say: (text, thread) => calls.push([text, thread]) };
  assert.equal(wiring.flushPendingSay(), 2);
  assert.deepEqual(calls, [["最初の指示", "demo"], ["2番目", null]]);
  assert.equal(wiring.pendingSayCount(), 0);
});

test("controller接続済みならqueueせず直配信(flushは0を返す)", () => {
  const calls = [];
  const controller = { say: (text, thread) => calls.push([text, thread]) };
  const wiring = chatUiHandlers(controller);
  wiring.onSay("直接届く", null);
  assert.deepEqual(calls, [["直接届く", null]]);
  assert.equal(wiring.pendingSayCount(), 0);
  assert.equal(wiring.flushPendingSay(), 0);
});

test("queueは上限50件で最古から落とす(controllerが一度も入らない起動失敗でも無限に育たない)", () => {
  const calls = [];
  let controller = null;
  const wiring = chatUiHandlers(() => controller);
  for (let i = 1; i <= 60; i++) wiring.onSay(`m${i}`, null);
  assert.equal(wiring.pendingSayCount(), 50);
  controller = { say: (text) => calls.push(text) };
  wiring.flushPendingSay();
  assert.equal(calls[0], "m11", "最古の10件がcapで落ち、m11から配信される");
  assert.equal(calls.length, 50);
});

test("実サーバー経路: 起動前のPOST /api/sayは200を返し、controller接続+flushで届く", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "base-model" }, agents: [] };
  const calls = [];
  let controller = null;
  const wiring = chatUiHandlers(() => controller);
  const ui = await startUiTokenized(_startUi, { config, modelFactory: () => ({}), bus, autoStart: false, ...wiring });
  const base = `http://127.0.0.1:${config.ui.port}`;
  // controller不在の起動ウィンドウでのPOST(旧実装ではここで黙って捨てられていた)
  const r = await fetch(base + "/api/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "起動前に送った指示" }) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(wiring.pendingSayCount(), 1);
  controller = { say: (text, thread) => calls.push([text, thread]) };
  assert.equal(wiring.flushPendingSay(), 1);
  assert.deepEqual(calls, [["起動前に送った指示", null]]);
  ui.close();
  rmTree(ws);
});
