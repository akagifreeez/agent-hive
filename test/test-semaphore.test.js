// テスト系コマンドのプロセス横断セマフォの検証(exec-test-semaphore)。
// ポリシー: セマフォ本体はDI可能なのでテストから実コマンドを立てない(短いダミーのrunで検証)。
// 実ファイルを介する統合確認(config反映)だけは実モジュールimportで行う。
// 依存ゼロ(純node)。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  isTestCommand,
  runTestCommand,
  configureTestSemaphore,
  resetTestSemaphore,
  testSemaphoreState,
} from "../src/engine/test-semaphore.js";
import { applyTestSemaphoreConfig } from "../src/engine/exec.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

beforeEach(() => {
  resetTestSemaphore();
});

// ---- isTestCommand: テスト系だけにマッチし、非テストは無影響 ----

test("isTestCommand: npm test系・node --testにマッチし、非テストコマンドには反応しない", () => {
  // テスト系(起動セグメントで始まるもの)
  for (const c of [
    "npm test",
    "npm run test",
    "node --test test/exec.test.js",
    "cd /d/x && npm test",
    "git add -A; npm test",
    "echo hi | node --test",
  ]) {
    assert.equal(isTestCommand(c), true, `should match: ${c}`);
  }
  // 非テスト(影響ゼロ)
  for (const c of [
    "git status",
    "echo npm test",
    "cat README.md",
    "git log --oneline -1",
    "npm run typecheck",
    "node scripts/doctor.js",
    "git diff reviewed main --name-status",
  ]) {
    assert.equal(isTestCommand(c), false, `should not match: ${c}`);
  }
});

test("isTestCommand: 文中のtest語に誤反応しない", () => {
  for (const c of [
        "node build/test-helper.js",
    "git show main:test/discover.test.js",
  ]) {
    assert.equal(isTestCommand(c), false, `should not match: ${c}`);
  }
});

// ---- FIFO直列化 ----

test("runTestCommand: 上限1で2つの実行はFIFO直列化され、順序が保たれる", async () => {
  const events = [];
  const run = async ({ label }) => {
    events.push(`start:${label}`);
    await new Promise((r) => setTimeout(r, 20));
    events.push(`end:${label}`);
    return { ok: true, text: label };
  };
  const p1 = runTestCommand({ label: "first", command: "npm test" }, run);
  // secondは必ず待ち行列に入る
  await new Promise((r) => setTimeout(r, 1));
  const p2 = runTestCommand({ label: "second", command: "npm test" }, run);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.deepEqual(events, ["start:first", "end:first", "start:second", "end:second"]);
  assert.equal(testSemaphoreState().queued, 0);
  assert.equal(testSemaphoreState().running, 0);
});

test("runTestCommand: 上限内なら並列実行される(configureTestSemaphoreで上限を上げる)", async () => {
  configureTestSemaphore({ testMaxConcurrent: 2 });
  assert.equal(testSemaphoreState().limit, 2);
  const events = [];
  const slow = async ({ label }) => {
    events.push(`start:${label}`);
    await new Promise((r) => setTimeout(r, 30));
    events.push(`end:${label}`);
    return { ok: true, text: label };
  };
  const p1 = runTestCommand({ label: "a", command: "npm test" }, slow);
  const p2 = runTestCommand({ label: "b", command: "npm test" }, slow);
  await Promise.all([p1, p2]);
  assert.deepEqual(events, ["start:a", "start:b", "end:a", "end:b"]);
});

// ---- FIFOキュー・タイムアウト文面 ----

test("runTestCommand: 待ち上限タイムアウトで教師文面つき失敗を返す(FIFOで後続も扱われる)", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const blocker = runTestCommand({ label: "blocker", command: "npm test" }, async () => {
    await gate;
    return { ok: true, text: "blocker done" };
  });
  await new Promise((r) => setTimeout(r, 1));
  const timeouts = [];
  const victim = runTestCommand({ label: "victim", command: "npm test", queueTimeoutMs: 30 }, async () => ({ ok: true, text: "" }));
  await new Promise((r) => setTimeout(r, 1));
  const latecomer = runTestCommand({ label: "latecomer", command: "npm test", queueTimeoutMs: 5000 }, async () => ({ ok: true, text: "" }));
  const res = await victim;
  assert.equal(res.ok, false);
  assert.match(res.text, /同時実行制限で待機タイムアウト/);
  assert.match(res.text, /exec\.testMaxConcurrent/);
  assert.match(res.text, /待っていたコマンド: victim/);
  assert.match(res.text, /実行中: blocker/);
  // victimが抜けても、後続(latecomer)はFIFOで順番待ちに戻り、ブロッカー解放後に実行される
  assert.equal(testSemaphoreState().queued, 1);
  release();
  const [rb, rl] = await Promise.all([blocker, latecomer]);
  assert.equal(rb.ok, true);
  assert.equal(rl.ok, true);
});

// ---- config反映・非テスト無影響 ----

test("configureTestSemaphore: 上限は1未満を1へクランプし、省略時は既定1に戻す", () => {
  assert.equal(configureTestSemaphore({ testMaxConcurrent: 0 }), 1);
  assert.equal(configureTestSemaphore({ testMaxConcurrent: 2.9 }), 2);
  assert.equal(configureTestSemaphore({ testMaxConcurrent: -5 }), 1);
  assert.equal(configureTestSemaphore(), 1);
  assert.equal(configureTestSemaphore({}), 1);
});

test("applyTestSemaphoreConfig: exec設定がそのままセマフォ上限へ反映される", () => {
  assert.equal(applyTestSemaphoreConfig({ testMaxConcurrent: 3 }), 3);
  assert.equal(testSemaphoreState().limit, 3);
  assert.equal(applyTestSemaphoreConfig(null), 1);
  assert.equal(testSemaphoreState().limit, 1);
});

test("非テストコマンドはセマフォを通らない(runTestCommand不使用=runCommandの実装固定)", () => {
  const src = readFileSync(join(ROOT, "src", "engine", "exec.js"), "utf8");
  // セマフォ経由は isTestCommand を通ったときだけ
  assert.match(src, /if \(isTestCommand\(command\)\) \{[\s\S]*?runTestCommand\(/);
});

test("runCommand実統合: npm test系はセマフォを通る・非テストは即座に通る(bash検出時のみ)", async (t) => {
  if (process.platform !== "win32") return t.skip("Windowsのbash統合確認のみ");
  const { runCommand } = await import("../src/engine/exec.js");
  // 非テスト: 影響ゼロで即実行できる
  const r1 = await runCommand({ command: "echo nontest-ok" });
  assert.equal(r1.ok, true, r1.text);
  // テスト系: セマフォを通って成功する(実行は1本なので待ちなし)
  const r2 = await runCommand({ command: "node --test test/exec.test.js" });
  assert.equal(r2.ok, true, r2.text);
});
