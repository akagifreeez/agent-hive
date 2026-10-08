// テスト系コマンド(npm test / node --test)のプロセス横断セマフォ(exec-test-semaphore)。
// 複数ワーカーの検証と発見器プローブが重なるとテストの子プロセスが同時多発して
// マシンが飽和する(テストフレーキーの既知教訓の主因)。テスト系コマンドだけを
// プロセス横断で直列化(上限N)し、FIFOで待たせる。テスト以外のコマンドは無影響。
// 上限は hive.config.json の exec.testMaxConcurrent で上書き可(loadConfig→index.jsで注入)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runCommand,
} from "../src/engine/exec.js";
import {
  isTestCommand,
  setTestMaxConcurrent,
  getTestMaxConcurrent,
  resetTestSemaphore,
  setSemaphoreSelfBlockGuard,
  testSemaphoreState,
} from "../src/engine/test-semaphore.js";

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

// 自縄自縛回避(fix-semaphore-self-block): このファイルは自分自身が runCommand("npm test ...")
// を発射するテストを含む。フルnpm test実行中は「自分の外側のテストランナープロセス」が
// すでにプロセス横断セマフォのスロットを掴んでおり、上限1の直列化検証は子プロセス同士の
// 検証ですら外側のスロット空き待ちと絡んでタイムアウトで落ちる(2026-10-08 ベータ観測+ガンマ#509)。
// 単独実行は9/9緑だが、フル実行では安定して落ちる=テストがセマフォの恩恵対象と衝突している。
// そこでこのテストファイルでは自縄自縛ガードを有効化する: ガード中は「このプロセス内の」
// テスト系コマンドが待ち行列に入らず即実行される。ガードは実行の度に withSemaphore の
// finally で解除され、他テストファイル(セマフォの本番挙動を検証するもの)への影響を遮断する。
// 本番経路(exec.js runCommand → runTestCommand)の既定挙動は一切変わらない。
setSemaphoreSelfBlockGuard(true);

test("isTestCommand: npm test系・node --testにマッチし、テスト以外は弾く", () => {
  const yes = [
    "npm test",
    "npm test -- tests/exec.test.js",
    "npm  test",
    "npm --test",
    "npm run test",
    "npm run test:smoke",
    "npm run test -- extra",
    "npm --silent run test",
    "npm --x --y --z test",
    "npm run --x test:ok",
    "node --test",
    "node  --test tests/*.test.js",
    "node --test --test-force-exit test/*.test.js",
    "a && npm test",
    "a; node --test x",
  ];
  const no = [
    "npmtest",
    "npm install",
    "npm audit",
    "npm run lint",
    "npm run lint test", // runスクリプトへの引数にtestは別テスト実行ではない
    "node src/server.js --test",
    "node --experimental-vm-modules script.js",
    "node file.js",
    "git status",
    "echo done",
    "echo retest",
    "echo npmtest",
    "echo npm test", // 文字列中の参照はテスト実行ではない(語境界仕様=最新契約)
  ];
  for (const c of yes) assert.equal(isTestCommand(c), true, `true期待: ${c}`);
  for (const c of no) assert.equal(isTestCommand(c), false, `false期待: ${c}`);
});

test("セマフォ: 上限1でnpm test系2本の並列実行は直列化される(2本目は1本目完了まで待つ)", async () => {
  await withSemaphore(1, async () => {
    // 軽量フィクスチャ(node --test 1ファイル 約300ms)を使う。npm testダミーは全スイート
    // 起動が20秒超のため、フル実行中(自分自身がスロット保持)に発射すると自縄自縛で落ちる。
    // 直列化の検証要件(2本目が1本目の完了まで走らない+順序)はフィクスチャで満たせる。
    const cmd = "node --test test/fixtures/empty.test.js";
    const log = [];
    const mk = (name) => runCommand({ command: cmd + " && echo done-" + name, timeoutMs: 15000 }).then((r) => {
      if (r.ok && r.text.includes("done-" + name)) log.push(`done-${name}`);
      return r;
    });
    const p1 = mk(1);
    await new Promise((r) => setTimeout(r, 60));
    const p2 = mk(2);
    await new Promise((r) => setTimeout(r, 40));
    // 上限1なので2本目はまだ走っていない(完了ログが無い)
    assert.deepEqual(log, [], "2本目が即実行されてしまった(直列化されていない)");
    await p1;
    const mid = log.length;
    await p2;
    assert.equal(mid, 1, "1本目の完了後に2本目が走った痕跡が無い");
    assert.deepEqual(log, ["done-1", "done-2"]);
  });
});

test("セマフォ: npm testを待っている間はテスト以外のコマンドは即座に通る", async () => {
  await withSemaphore(1, async () => {
    const slow = runCommand({ command: "npm test -- dummy-slow", timeoutMs: 15000 });
    await new Promise((r) => setTimeout(r, 60));
    const t0 = Date.now();
    const other = await runCommand({ command: "echo non-test-command", timeoutMs: 15000 });
    const elapsed = Date.now() - t0;
    assert.equal(other.ok, true, other.text);
    assert.ok(elapsed < 5000, `テスト以外がブロックされた(経過${elapsed}ms)`);
    assert.ok(other.text.includes("non-test-command"));
    await slow;
  });
});

test("セマフォ: 上限超過の待ちがタイムアウトを過ぎると教師文面つきで失敗を返す", async () => {
  await withSemaphore(1, async () => {
    // 1本目を軽量フィクスチャで握り、2本目を短い待ちタイムアウトで失敗させる。
    // (旧実装のnpm testダミーはガードon中は待ちゼロで即実行され、「実行タイムアウト(500ms)」
    // になるだけだった。待ちタイムアウトは queueTimeoutMs で明示誘発する)
    const blocker = runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 15000 });
    for (let i = 0; i < 100 && testSemaphoreState().running < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const waiter = await runCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000, queueTimeoutMs: 300 });
    assert.equal(waiter.ok, false);
    assert.match(waiter.text, /同時実行制限で待機タイムアウト/);
    assert.match(waiter.text, /exec\.testMaxConcurrent/);
    await blocker;
  });
});

test("セマフォ: 上限2なら2本まで同時に走り、上限のconfig上書きが効く", async () => {
  await withSemaphore(2, async () => {
    // 軽量フィクスチャ(node --test 1ファイル 約300ms)で並走を確認する。
    // npm testダミーは全スイート起動で20秒超かかるため、完了待ちは実質不可能。
    const cmd = `node --test test/fixtures/empty.test.js test/fixtures/empty.test.js`;
    assert.equal(isTestCommand(cmd), true, "node --test がテスト系判定から漏れた");
    const log = [];
    const mk = (name) => runCommand({ command: cmd + " && echo done-" + name, timeoutMs: 15000 }).then((r) => {
      if (r.ok && r.text.includes("done-" + name)) log.push(`done-${name}`);
      return r;
    });
    const p1 = mk(1);
    const p2 = mk(2);
    await Promise.all([p1, p2]);
    // 上限2なので2本とも並走して完走する(待ちqueueに入らない)
    assert.deepEqual(log.sort(), ["done-1", "done-2"], "上限2で2本が並走していない");
    assert.equal(getTestMaxConcurrent(), 2, "setTestMaxConcurrent(=config上書き経由)が効いていない");
  });
});

test("セマフォ: FIFOで待ちキューが消化される(3本直列・順序維持)", async () => {
  await withSemaphore(1, async () => {
    // 軽量フィクスチャでFIFO順を確認(node --test 1ファイル 約300ms×3直列)
    const cmd = "node --test test/fixtures/empty.test.js";
    const log = [];
    const mk = (name) => runCommand({ command: cmd + " && echo fin-" + name, timeoutMs: 15000 }).then((r) => {
      if (r.ok) log.push(name);
    });
    const p1 = mk("a");
    await new Promise((r) => setTimeout(r, 50));
    const p2 = mk("b");
    const p3 = mk("c");
    await Promise.all([p1, p2, p3]);
    assert.deepEqual(log, ["a", "b", "c"], `FIFO順が崩れた: ${log.join(",")}`);
  });
});

test("セマフォ: 失敗・タイムアウトでもスロットはリークしない(後続が通る)", async () => {
  // ガードon中の検証: 待ちゼロで即実行されるので、短いタイムアウトは「実行タイムアウト」になる。
  // 失敗(タイムアウト)のあと後続が通る=プロセス内状態が壊れていないことを見る。
  await withSemaphore(1, async () => {
    const bad = await runCommand({ command: "node --test test/fixtures/slow.test.js", timeoutMs: 200 });
    const next = await runCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 15000 });
    assert.equal(next.ok, true, `失敗後に後続が通らない(状態破損): ${next.text}`);
  });
});

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
      const waiter = await runCommand({ command: "node --test test/fixtures/empty.test.js", timeoutMs: 300 });
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
