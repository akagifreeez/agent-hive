// /api/permission の id 検証: pending リクエストのidのみverdictを受け付けること(承認偽装防止)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUi } from "../src/ui/server.js";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { PermissionGate } from "../src/engine/permissions.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

async function startTestUi() {
  const ws = mkdtempSync(join(tmpdir(), "hive-perm-id-"));
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const gate = new PermissionGate({ bus, askTimeoutSec: 30, deny: [], ask: ["git push"] });
  const config = { workspace: ws, ui: { port: 0 }, model: { model: "test" }, agents: [], budget: { maxTokensPerRun: 1 }, permissions: {} };
  const ui = await startUi({ config, modelFactory: () => ({}), bus, autoStart: false });
  return { ws, bus, gate, base: `http://127.0.0.1:${config.ui.port}`, close: () => { try { ui?.close?.(); } catch {} rmTree(ws); } };
}

test("/api/permission: 未知のidは404で拒否され、verdictイベントが出ない", async () => {
  const t = await startTestUi();
  try {
    let verdictSeen = null;
    t.bus.on("permission.verdict", (p) => { verdictSeen = p; });
    const r = await fetch(`${t.base}/api/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 999, approve: true }) });
    assert.equal(r.status, 404);
    assert.equal(verdictSeen, null, "未知idでverdictイベントは発行されない");
  } finally { t.close(); }
});

test("/api/permission: 正当なpending idは承認でき、gate.checkが解決する", async () => {
  const t = await startTestUi();
  try {
    const checkPromise = t.gate.check("git push origin main");
    // permission.requestがlive.requestsに載るのを待つ
    await new Promise((res) => setTimeout(res, 100));
    const st = await fetch(`${t.base}/api/state`).then((r) => r.json());
    const pending = st.live.requests.find((r) => r.state === "pending");
    assert.ok(pending, "pendingリクエストが存在する");
    t.lastPendingId = pending.id;
    const r = await fetch(`${t.base}/api/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: pending.id, approve: true }) });
    assert.equal(r.status, 200);
    assert.deepEqual(await checkPromise, { allowed: true });
  } finally { t.close(); }
});

test("/api/permission: 既処理のidは2回目に404で拒否される", async () => {
  const t = await startTestUi();
  try {
    const checkPromise = t.gate.check("git push origin main");
    await new Promise((res) => setTimeout(res, 100));
    const st = await fetch(`${t.base}/api/state`).then((r) => r.json());
    const pending = st.live.requests.find((r) => r.state === "pending");
    const first = await fetch(`${t.base}/api/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: pending.id, approve: false }) });
    assert.equal(first.status, 200);
    const second = await fetch(`${t.base}/api/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: pending.id, approve: true }) });
    assert.equal(second.status, 404, "既処理idの再送は拒否");
    assert.deepEqual(await checkPromise, { allowed: false, reason: "人が拒否した" });
  } finally { t.close(); }
});
