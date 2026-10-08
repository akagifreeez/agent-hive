// bashタイムアウトのconfig配線(exec.maxBashMs / exec.maxBashCapMs)。
// フルスイート(約3.5分)がハード上限120秒で絶対に通らなかった事故の再発防止。
// applyBashTimeoutConfigで注入した既定/上限がbashツールへ効くこと、
// 未設定のときはインスタンス既定(30秒/120秒)へフォールバックすることを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBashTimeoutConfig, bashTimeoutConfig } from "../src/engine/exec.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-bashto-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

function mkTools(ws) {
  const agent = { id: "a-1", displayName: "エー", role: "impl", personaText: "# A" };
  return createTools({ agent, workspace: ws, mainWorkspace: ws, board: null, tasks: null, bus: { emit() {} } });
}

test("bash timeout: config注入で既定と上限が変わり、timeout_ms省略時に既定が効く", async () => {
  const ws = mktmp();
  const tools = mkTools(ws);
  applyBashTimeoutConfig({ testMaxConcurrent: 1, maxBashMs: 1000, maxBashCapMs: 2000 });
  try {
    assert.deepEqual(bashTimeoutConfig(), { defaultMs: 1000, capMs: 2000 });
    // timeout_ms省略→既定1000msが適用され、3秒sleepは打ち切られる
    const r = await tools.execute("bash", { command: "sleep 3" });
    assert.equal(r.ok, false);
    assert.ok(r.text.includes("タイムアウト(1000ms)"), "既定1000msで打ち切り: " + r.text.slice(0, 60));
  } finally {
    applyBashTimeoutConfig({ maxBashMs: 30000, maxBashCapMs: 120000 });
    rmTree(ws);
  }
});

test("bash timeout: 上限引き上げでtimeout_ms=600000相当が受理される(clamp上限がconfigに従う)", async () => {
  const ws = mktmp();
  const tools = mkTools(ws);
  applyBashTimeoutConfig({ maxBashMs: 60000, maxBashCapMs: 600000 });
  try {
    // 旧上限(120000)ならclampで打ち切られる要求が、新上限では通る: sleep 0.2は600秒未満なので完走する
    const r = await tools.execute("bash", { command: "sleep 0.2 && echo done", timeout_ms: 600000 });
    assert.equal(r.ok, true, "上限600000が受理されsleep 0.2が完走: " + r.text.slice(0, 60));
    assert.ok(r.text.includes("done"));
    // 上限を2000へ戻した状態でtimeout_ms=600000を要求するとclampされタイムアウトする
    applyBashTimeoutConfig({ maxBashMs: 60000, maxBashCapMs: 2000 });
    const r2 = await tools.execute("bash", { command: "sleep 3", timeout_ms: 600000 });
    assert.equal(r2.ok, false);
    assert.ok(r2.text.includes("タイムアウト(2000ms)"), "上限2000へclamp: " + r2.text.slice(0, 60));
  } finally {
    applyBashTimeoutConfig({ maxBashMs: 30000, maxBashCapMs: 120000 });
    rmTree(ws);
  }
});

test("bash timeout: 未設定(既定0)のときはインスタンス既定へフォールバックする", async () => {
  applyBashTimeoutConfig(null); // 未設定状態(0)へ戻す
  const ws = mktmp();
  const agent = { id: "a-1", displayName: "エー", role: "impl", personaText: "# A" };
  const tools = createTools({ agent, workspace: ws, mainWorkspace: ws, board: null, tasks: null, bus: { emit() {} }, maxBashMs: 1000 });
  try {
    assert.deepEqual(bashTimeoutConfig(), { defaultMs: 0, capMs: 0 });
    const r = await tools.execute("bash", { command: "sleep 3" });
    assert.equal(r.ok, false);
    assert.ok(r.text.includes("タイムアウト(1000ms)"), "インスタンス既定1000ms: " + r.text.slice(0, 60));
  } finally {
    applyBashTimeoutConfig(null);
    rmTree(ws);
  }
});
