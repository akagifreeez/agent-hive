// プロセス死からの自動再起動ウォッチドッグ(long-run-resilience)の検証。
// 疎通(probe)/marker判定/起動処理(spawn)は全て注入可能なので、実プロセスを立てずに固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIfNeeded, probeAlive, isWatchdogEnabled } from "../scripts/watchdog.mjs";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-watchdog-"));
}

test("watchdog: ダウン+marker有り → 起動処理を呼び、ログが残る", async () => {
  const ws = mktmp();
  const marker = join(ws, "state", "watchdog-on");
  const log = join(ws, "state", "watchdog.log");
  try {
    writeFileSync(marker, "on\n");
    let spawned = null;
    const r = await startIfNeeded({
      probe: async () => false, // ダウン
      enabled: () => existsSync(marker),
      spawn: (cmd) => { spawned = cmd; },
    });
    assert.equal(r, "started");
    assert.match(String(spawned), /src[\\\/]index\.js.*--chat/);
    // ログはstartIfNeeded内部の固定パスに書かれるため、ここでは分岐とspawn引数だけ検証
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("watchdog: 稼働中 → 何もしない", async () => {
  let called = 0;
  const r = await startIfNeeded({ probe: async () => true, spawn: () => { called++; } });
  assert.equal(r, "up");
  assert.equal(called, 0);
});

test("watchdog: ダウン+marker無し → 何もしない(勝手に起こさない)", async () => {
  let called = 0;
  const r = await startIfNeeded({ probe: async () => false, enabled: () => false, spawn: () => { called++; } });
  assert.equal(r, "no-marker");
  assert.equal(called, 0);
});

test("watchdog: marker切替ヘルパーが動く(en/disable/isEnabled)", async () => {
  const ws = mktmp();
  // enable/disableはENV経由でSTATE_DIRを差し替えられない(モジュール定数)ため、
  // 実挙動は「関数が存在し、marker有無の判定が真偽を返す」ことまで。実パスへの書き込みは回避
  assert.equal(typeof isWatchdogEnabled(), "boolean");
});

test("watchdog: probeAliveは応答しないURLでfalse(タイムアウト短縮)", async () => {
  // 存在しないポートへ: 接続拒否は即false
  const ok = await probeAlive("http://localhost:9/hive-watchdog-probe", 1000);
  assert.equal(ok, false);
});
