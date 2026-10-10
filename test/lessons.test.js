// 教訓プローブ(監査ログの失敗パターン解析)の検証: シグネチャの集約・時間窓・
// 証跡付きタスクの起票・二重起票防止・done後の恒久クールダウン。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureSignature, lessonSlug, analyzeAuditFailures } from "../src/engine/lessons.js";
import { startDiscovery } from "../src/engine/discover.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Board, Bus } from "../src/engine/board.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = Date.parse("2026-10-11T00:00:00.000Z");

test("failureSignature: 数値の違いは同型に潰れ、ツールが違えば別扱い", () => {
  const a = failureSignature({ tool: "bash", brief: "コマンドがタイムアウトしました(30000ms) exit=1" });
  const b = failureSignature({ tool: "bash", brief: "コマンドがタイムアウトしました(60000ms) exit=2" });
  assert.equal(a, b);
  const c = failureSignature({ tool: "write_file", brief: "コマンドがタイムアウトしました(30000ms) exit=1" });
  assert.notEqual(a, c);
});

test("analyzeAuditFailures: 窓外は数えずminCount未満は落とし、件数降順で返す", () => {
  const mk = (n, ts, brief) => Array.from({ length: n }, () => ({ ts, tool: "bash", ok: false, brief }));
  const entries = [
    ...mk(6, new Date(NOW - 1000).toISOString(), "timeout pattern alpha"),
    ...mk(3, new Date(NOW - 1000).toISOString(), "rare failure"),
    ...mk(9, new Date(NOW - 48 * 3600 * 1000).toISOString(), "old failure outside window"),
  ];
  const report = analyzeAuditFailures({ entries, windowMs: 24 * 3600 * 1000, nowMs: NOW, minCount: 5 });
  assert.equal(report.length, 1);
  assert.equal(report[0].count, 6);
  assert.match(report[0].signature, /timeout pattern alpha/);
  assert.ok(report[0].examples.length >= 1 && report[0].examples.length <= 3);
  assert.ok(report[0].examples[0].includes("timeout pattern alpha"));
});

test("lessonSlug: 安定してタスクidに使える文字種", () => {
  const s = failureSignature({ tool: "bash", brief: "x".repeat(200) });
  const slug = lessonSlug(s);
  assert.match(slug, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(slug, lessonSlug(s));
});

test("教訓プローブ: 繰り返す失敗から証跡付きタスクを1件起票し、2度目は作らない", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-lessons-"));
  try {
    const bus = new Bus();
    const board = new Board(bus);
    const tasks = new TaskBlackboard(ws, bus);
    mkdirSync(join(ws, "state"), { recursive: true });
    const audit = join(ws, "state", "audit.jsonl");
    const line = JSON.stringify({ ts: new Date().toISOString(), agent: "impl-1", tool: "bash", ok: false, ms: 30000, cmd: "npm test", brief: "コマンドがタイムアウトしました(30000ms)。timeout_msを指定してください" }) + "\n";
    writeFileSync(audit, line.repeat(6));
    const d = startDiscovery({ workspace: ws, tasks, bus, intervalSec: 3600, testCommand: null, probes: { tests: "off" } });
    await d.tick();
    const open = tasks.snapshot().open.map((f) => f.replace(/\.md$/, ""));
    assert.equal(open.length, 1, "教訓タスクが1件だけ起票: " + open.join(","));
    assert.match(open[0], /^distill-lesson-bash-/);
    const body = readFileSync(join(ws, "tasks", "open", open[0] + ".md"), "utf8");
    assert.match(body, /audit\.jsonl/);
    assert.match(body, /6件/);
    assert.match(body, /タイムアウト/);
    assert.match(body, /memory\/lessons\.md/);
    // 教訓タスクが動いている間は次を出さない(1件ずつ)
    writeFileSync(audit, readFileSync(audit, "utf8") + line); // mtimeを動かして再解析させる
    await sleep(10);
    await d.tick();
    assert.equal(tasks.snapshot().open.length, 1, "二重起票しない");
    // 完了後も同じパターンでは再起票しない(done参照の恒久クールダウン)
    // 注: cancelでdoneが増えるため③の記憶プローブ(distill-learnings)は別途起票されうる。
    // ここでは教訓タスク(distill-lesson-*)が再び出ないことだけを見る。
    tasks.cancel(open[0], "テスト完了扱い");
    writeFileSync(audit, readFileSync(audit, "utf8") + line);
    await sleep(10);
    await d.tick();
    assert.ok(!tasks.snapshot().open.some((f) => f.includes("distill-lesson-")), "同じ失敗パターンの再教訓化はしない");
    d.stop();
  } finally {
    rmTree(ws);
  }
});
