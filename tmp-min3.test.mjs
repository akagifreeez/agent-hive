// テスト系コマンド(npm test / node --test)のプロセス横断セマフォ(exec-test-semaphore)。
// 複数ワーカーの検証と発見器プローブが重なるとテストの子プロセスが同時多発して
// マシンが飽和する(テストフレーキーの既知教訓の主因)。テスト系コマンドだけを
// プロセス横断で直列化(上限N)し、FIFOで待たせる。テスト以外のコマンドは無影響。
// 上限は hive.config.json の exec.testMaxConcurrent で上書き可(loadConfig→index.jsで注入)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runCommand,
  runCommandInner,
} from "./src/engine/exec.js";
import {
  isTestCommand,
  runTestCommand,
  setTestMaxConcurrent,
  getTestMaxConcurrent,
  resetTestSemaphore,
  setSemaphoreSelfBlockGuard,
  testSemaphoreState,
} from "./src/engine/test-semaphore.js";

// 並列テストファイル同士でセマフォ状態を持ち越さない。各テストの終了時に必ず戻す。
// (同一ファイル内では各テストが直列に動く前提。node:testの並列concurrencyは無効)
async function withSemaphore(max, fn) {
  resetTestSemaphore();
  if (max !== null && max !== undefined) setTestMaxConcurrent(max);
  try {
    await fn();
  } finally {
    resetTestSemaphore();
    setSemaphoreSelfBlockGuard(false); // ガードはテストごとに必ず戻す(他テストへの漏出防止)
  }
}
test("セマフォ(ガード解除): 待ちタイムアウトで失敗してもスロットはリークしない(後続が通る)", async () => {
  // 実セマフォ(ガードoff・上限1)での本番経路検証。軽量フィクスチャでスロットを握り、
  // 2本目を短い待ちタイムアウトで失敗させ、1本目完了後に3本目が通る=リーク無し。
  // ガード解除はwithSemaphoreの中で行い、テスト終了時に必ず戻す(finallyで復帰)。
  await withSemaphore(1, async () => {
    setSemaphoreSelfBlockGuard(false);
    try {
      // slow(1.5秒)を握らせた直後だと、環境によっては runCommandInner の起動が遅れて
      // 2本目の到着時点でまだ空き扱い(走り出す)ことがある。確実に保持させるため
      // slow がスロットを掴むのを十分待つ(空き状況はテスト用APIで確認)。
      const hold = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000 });
      for (let i = 0; i < 100 && testSemaphoreState().running < 1; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // 待ちタイムアウト(300ms)の誘発は runTestCommand 直叩きで行う。runCommand経由は
      // 待ち上限がセマフォ既定(10分)固定のため(2026-10-08 9d35dc4の契約)。
      const waiter = await runTestCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300 }, runCommandInner);
      assert.equal(waiter.ok, false, "待ちタイムアウトで失敗するはず");
      assert.match(waiter.text, /同時実行制限で待機タイムアウト/);
      await hold;
      const next = await runCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000 });
      assert.equal(next.ok, true, `スロットがリークして後続が永久待ちになった: ${next.text}`);
    } finally {
      setSemaphoreSelfBlockGuard(true); // ファイル方針へ戻す(withSemaphoreのfinallyでも二重に戻る)
    }
  });
});
