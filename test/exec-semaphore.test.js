// テスト系コマンド(npm test / node --test)のプロセス横断セマフォ(exec-test-semaphore)。
// 複数ワーカーの検証と発見器プローブが重なるとテストの子プロセスが同時多発して
// マシンが飽和する(テストフレーキーの既知教訓の主因)。テスト系コマンドだけを
// プロセス横断で直列化(上限N)し、FIFOで待たせる。テスト以外のコマンドは無影響。
// 上限は hive.config.json の exec.testMaxConcurrent で上書き可(loadConfig→index.jsで注入)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTestCommand,
  runCommand,
  setTestMaxConcurrent,
  getTestMaxConcurrent,
  resetTestSemaphore,
} from "../src/engine/exec.js";

// 並列テストファイル同士でセマフォ状態を持ち越さない。各テストの終了時に必ず戻す。
// (同一ファイル内では各テストが直列に動く前提。node:testの並列concurrencyは無効)
async function withSemaphore(max, fn) {
  resetTestSemaphore();
  if (max !== null && max !== undefined) setTestMaxConcurrent(max);
  try {
    await fn();
  } finally {
    resetTestSemaphore();
  }
}

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
    "echo npm test", // 文字列中の参照もテスト実行の意図として保守的に捕捉
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
  ];
  for (const c of yes) assert.equal(isTestCommand(c), true, `true期待: ${c}`);
  for (const c of no) assert.equal(isTestCommand(c), false, `false期待: ${c}`);
});

test("セマフォ: 上限1でnpm test系2本の並列実行は直列化される(2本目は1本目完了まで待つ)", async () => {
  await withSemaphore(1, async () => {
    const log = [];
    const mk = (name) => runCommand({ command: `npm test -- dummy-${name}`, timeoutMs: 15000 }).then((r) => {
      log.push(`done-${name}:${r.ok ? "ok" : "fail"}`);
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
    assert.deepEqual(log, ["done-1:ok", "done-2:ok"]);
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
    // 1本目を人力で長く握る: 実際のテスト起動は重いのでnpm testダミーを2本立て、
    // 2本目に短いタイムアウトを渡して「待ちタイムアウト」を誘発する
    const blocker = runCommand({ command: "npm test -- dummy-block", timeoutMs: 15000 });
    await new Promise((r) => setTimeout(r, 60));
    const waiter = await runCommand({ command: "npm test -- dummy-wait", timeoutMs: 500 });
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

test("セマフォ: 失敗・タイムアウト・起動エラーでもスロットはリークしない(後続が通る)", async () => {
  await withSemaphore(1, async () => {
    const bad = await runCommand({ command: "npm test -- dummy-leak", timeoutMs: 200 });
    assert.equal(bad.ok, false, "200msでは終わらないのでタイムアウト失敗になる");
    const next = await runCommand({ command: "npm test -- dummy-next", timeoutMs: 15000 });
    assert.equal(next.ok, true, `スロットがリークして後続が永久待ちになった: ${next.text}`);
  });
});
