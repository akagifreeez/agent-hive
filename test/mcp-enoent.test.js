// イシュー#27の回帰: 起動コマンドが存在しないMCPサーバーでもhiveプロセスが落ちないこと。
// ChildProcessの非同期errorイベント(ENOENT)を捕捉し、ok:falseとして扱い、
// 以後のrequest/callも安全に失敗させる(タイムアウト待ちや未処理rejectionを残さない)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../src/engine/board.js";
import { McpHost } from "../src/engine/mcp.js";

// プラットフォーム非依存の「存在しないコマンド」を用意する
const missingCommand = process.platform === "win32" ? "definitely-missing-cmd-27" : "./definitely-missing-bin-27";

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("#27: 不存在コマンドでstartしても落ちずok:false、mcp.failedが出る", async () => {
  const bus = new Bus();
  const failed = [];
  bus.on("mcp.failed", (p) => failed.push(p));
  const host = new McpHost({ name: "missing", command: missingCommand, args: [], bus, timeoutMs: 3000 });

  // start自体が例外で飛ばない(旧実装はUnhandled 'error' eventでプロセスが落ちた)
  const r = await host.start();
  assert.equal(r.ok, false, "起動失敗はok:false");
  assert.ok(r.error, "エラー理由が載る");
  assert.equal(failed.length >= 1, true, "mcp.failedイベントが出る");
  assert.match(failed[0].error, /ENOENT|not find|failed/i);
  host.stop();
});

test("#27: 起動失敗後のrequestは即座に失敗する(タイムアウトまで待たない)", async () => {
  const bus = new Bus();
  const host = new McpHost({ name: "missing2", command: missingCommand, args: [], bus, timeoutMs: 3000 });
  await host.start();
  const t0 = Date.now();
  await assert.rejects(() => host.request("tools/list", {}), /起動失敗/);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2500, `即座に失敗する(実際: ${elapsed}ms)`);
  host.stop();
});

test("#27: 起動失敗済みホストのcallはok:falseのツール結果を返す", async () => {
  const bus = new Bus();
  const host = new McpHost({ name: "missing3", command: missingCommand, args: [], bus, timeoutMs: 3000 });
  await host.start();
  // callはrequestのrejectを{ok:false, text}へ正規化する契約(typedef・mcp.test.jsと一致)。rejectはしない
  const out = await host.call("mcp__missing3__x", {});  assert.equal(out.ok, false, "callはok:falseへ正規化");  assert.match(String(out.text), /起動失敗/, "失敗理由がtextに載る");
  host.stop();
});
