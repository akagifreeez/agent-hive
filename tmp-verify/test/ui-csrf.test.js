// UIサーバーのPOSTガード(Origin/Host検証)と /api/exec のPermissionGate
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { startUi as _startUi, isLocalOrigin } from "../src/ui/server.js";
// test-hf-token-inject: UIサーバーのPOSTはCSRFトークンを要求するため、
// テスト内のfetchは全てトークン付きへ差し替える(startUi後にtokenedFetchOn()を呼ぶ)
import { tokenedFetchOn, startUiTokenized } from "./helpers/hf-token.js";
tokenedFetchOn();


function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-uicsrf-"));
}

function mkConfig(ws) {
  return { workspace: ws, ui: { port: 0 }, model: { model: "base" }, agents: [], budget: { maxTokensPerRun: 1 } };
}

test("isLocalOrigin: localhost系は許可、外部オリジンは拒否", () => {
  assert.equal(isLocalOrigin({ headers: { origin: "http://localhost:3000" } }), true);
  assert.equal(isLocalOrigin({ headers: { origin: "http://127.0.0.1:5173" } }), true);
  assert.equal(isLocalOrigin({ headers: { host: "localhost:8080" } }), true);
  assert.equal(isLocalOrigin({ headers: {} }), true); // ヘッダ無し(curl等)は許可
  assert.equal(isLocalOrigin({ headers: { origin: "http://evil.example.com" } }), false);
  assert.equal(isLocalOrigin({ headers: { origin: "http://localhost.example.com" } }), false);
  assert.equal(isLocalOrigin({ headers: { host: "evil.example.com" } }), false);
});

test("全POSTエンドポイントが外部Originを403で拒否する", async () => {
  const ws = mktmp();
  try {
    const config = mkConfig(ws);
    const ui = await startUiTokenized(_startUi, { config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
    try {
      const base = `http://127.0.0.1:${config.ui.port}`;
      for (const path of ["/api/thread", "/api/tasks", "/api/say", "/api/exec", "/api/permission", "/api/workflow", "/api/pause", "/api/folder", "/api/close", "/api/model", "/api/perm", "/api/merge-feedback"]) {
        const r = await fetch(base + path, {
          method: "POST",
          headers: { origin: "http://evil.example.com", "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(r.status, 403, `${path} should be 403`);
      }
      // localhostオリジンなら通る(403以外。パスによっては400等)
      const ok = await fetch(base + "/api/tasks", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: "{}",
      });
      assert.notEqual(ok.status, 403);
    } finally { ui.close(); }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("/api/exec がPermissionGateを通す(denyパターンは403)", async () => {
  const ws = mktmp();
  try {
    const config = mkConfig(ws);
    config.permissions = { deny: ["forbidden-cmd"] };
    const ui = await startUiTokenized(_startUi, { config, modelFactory: () => ({}), bus: new Bus(), autoStart: false });
    try {
      const base = `http://127.0.0.1:${config.ui.port}`;
      const r = await fetch(base + "/api/exec", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ command: "echo forbidden-cmd" }),
      });
      assert.equal(r.status, 403);
      const body = await r.json();
      assert.match(body.text ?? "", /PermissionGate/);
      // 許可されたコマンドは実行される
      const ok = await fetch(base + "/api/exec", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ command: "echo hive-ok" }),
      });
      assert.equal(ok.status, 200);
      const out = await ok.json();
      assert.match(String(out.text ?? ""), /hive-ok/);
    } finally { ui.close(); }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
