// chatUiHandlersの共通配線: --chat CLI でもデスクトップでも設定API等が404にならないこと。
// (実事故: src/index.js --chat が onSay/onFeedback/onThreadPause しか渡さず、設定の保存が死んでいた)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi as _startUi } from "../src/ui/server.js";
import { chatUiHandlers } from "../src/ui/chat-wiring.js";
// test-hf-token-inject: UIサーバーのPOSTはCSRFトークンを要求するため、
// テスト内のfetchは全てトークン付きへ差し替える(startUi後にtokenedFetchOn()を呼ぶ)
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";
tokenedFetchOn();


function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-wire-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

test("chatUiHandlers: 設定・スレッド・フォルダ・pause・feedbackの全エンドポイントが生きている", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "base-model" }, agents: [] };
  const calls = [];
  const controller = {
    say: (text, thread) => calls.push(["say", text, thread]),
    attachImage: (note, dataUrl, thread, path) => calls.push(["attach", note, thread, path]),
    openThread: (req) => { calls.push(["open", req.project]); return { ok: true, id: req.project }; },
    closeThread: (req) => { calls.push(["close", req.project]); return { ok: true }; },
    setThreadFolder: (req) => { calls.push(["folder", req.project, req.folder]); return { ok: true }; },
    setModel: (patch) => { calls.push(["model", patch]); return { ok: true, model: patch.model ?? null, effort: patch.effort ?? null }; },
    setPermMode: (mode) => { calls.push(["perm", mode]); return { ok: true, mode }; },
    runWorkflow: (name) => { calls.push(["wf", name]); return { ok: true }; },
    listWorkflows: () => ["demo"],
    feedback: (req) => { calls.push(["fb", req.taskId]); return { ok: true, id: "fb-x", thread: "__main__" }; },
    setThreadPaused: (req) => { calls.push(["pause", req.project, req.paused]); return { ok: true, name: req.project, paused: req.paused }; },
  };
  const ui = await startUiTokenized(_startUi, { config, modelFactory: () => ({}), bus, autoStart: false, ...chatUiHandlers(controller) });
  const base = `http://127.0.0.1:${config.ui.port}`;
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // 事故再発防止の主題: 設定の保存経路が404でなく生きていること
  const model = await post("/api/model", { effort: "high", model: "gpt-x" });
  assert.equal(model.status, 200);
  const perm = await post("/api/perm", { mode: "auto" });
  assert.equal(perm.status, 200);
  const thread = await post("/api/thread", { project: "demo", goal: "g" });
  assert.equal(thread.status, 200);
  const folder = await post("/api/folder", { project: "demo", folder: "AI開発" });
  assert.equal(folder.status, 200);
  const pause = await post("/api/pause", { project: "demo", paused: true });
  assert.equal(pause.status, 200);
  const fb = await post("/api/merge-feedback", { taskId: "t1", comment: "c" });
  assert.equal(fb.status, 200);
  const wf = await post("/api/workflow", { name: "demo" });
  assert.equal(wf.status, 200);

  // stateにも配線結果が乗る(live.permMode等)
  const st = await (await fetch(base + "/api/state")).json();
  assert.equal(st.live.permMode, "auto");

  // 各操作がコントローラまで届いているか(宛先変換を含む)
  assert.ok(calls.some((c) => c[0] === "model" && c[1].effort === "high"));
  assert.ok(calls.some((c) => c[0] === "perm" && c[1] === "auto"));
  assert.ok(calls.some((c) => c[0] === "open" && c[1] === "demo"));
  assert.ok(calls.some((c) => c[0] === "folder" && c[1] === "demo"));
  assert.ok(calls.some((c) => c[0] === "pause" && c[1] === "demo" && c[2] === true));
  assert.ok(calls.some((c) => c[0] === "fb" && c[1] === "t1"));
  assert.ok(calls.some((c) => c[0] === "wf" && c[1] === "demo"));

  ui.close();
  rmTree(ws);
});
