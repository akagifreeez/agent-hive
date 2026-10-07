// フルスイートトリアージのテスト固定。
// - parseTap: node:test のverboseサマリ形式(failing tests節)とsimple形式(not ok)の両対応
// - classifyFailures: 既知/新規の分類(照合キーは file+name)
// - buildFixCandidates: エリア別集約とfix候補の組み立て
// - 発見器統合: probes.triage 経由で新規失敗だけがfix候補タスクとして起票される
// フィクスチャは2026-10-07の実ログ(603中8失敗)に由来する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTap, classifyFailures, buildFixCandidates, normalizeTestFile, extractErrorType, deriveArea } from "../src/engine/test-triage.js";
import { startDiscovery } from "../src/engine/discover.js";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";

const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);

// 実ログ由来の失敗節フィクスチャ(8件。名前とファイルは実物)
const REAL_SUMMARY_TAIL = [
  "ℹ tests 603",
  "ℹ pass 588",
  "ℹ fail 8",
  "ℹ skipped 7",
  "✖ failing tests:",
  "",
  "test at test" + BS + "cli.test.js:103:1",
  "✖ CLI: cancel/release/reopen/auditが実サーバーに対して動く (1505ms)",
  "  AssertionError [ERR_ASSERTION]: Expected \"actual\" to be strictly unequal to: 0",
  "",
  "test at test" + BS + "long-run-resilience.test.js:35:1",
  "✖ ストリーム途中切断(TypeError: terminated)はリトライされて成功する(プロセスは落ちない) (2ms)",
  "  TypeError: Cannot read properties of null (reading 'message')",
  "",
  "test at test" + BS + "long-run-resilience.test.js:100:1",
  "✖ 子プロセス: ガード付きはunhandledRejection後に生存しログへ残る (659ms)",
  "  AssertionError [ERR_ASSERTION]: ガード無しの対照はrejectionで死ぬ(exit 1)",
  "",
  "test at test" + BS + "long-run-resilience.test.js:129:1",
  "✖ ガードはuncaughtExceptionも捕捉し、必ずログへ残す (603ms)",
  "  AssertionError [ERR_ASSERTION]: 生存(er=Command failed)",
  "",
  "test at test" + BS + "long-run-resilience.test.js:153:1",
  "✖ 異常頻度: 1時間の窓でしきい値超過したら「異常頻度」警告を1回だけ出す (8ms)",
  "  TypeError: t0",
  "",
  "test at test" + BS + "long-run-resilience.test.js:175:1",
  "✖ onEvent/onPostフック経由でbusに流れ、board投稿に使える (6ms)",
  "  TypeError: terminated",
  "",
  "test at test" + BS + "model-policy.test.js:117:1",
  "✖ 承認フロー競合経路: 差し戻し記録がtools.jsから呼ばれてもReferenceErrorしない(modelPolicy未指定=既定動作) (7512ms)",
  "  AssertionError [ERR_ASSERTION]: 競合が返る: マージに失敗しました",
  "",
  "test at test" + BS + "retry.test.js:142:1",
  "✖ chat(stream): stall検知でリトライし、2回目で成功する (97ms)",
  "  Error: ストリームが途切れました: ストリームが0秒間無出力です(stall)",
].join(NL);

test("normalizeTestFile: バックスラッシュ・行番号接尾・絶対パスを正規化する", () => {
  assert.equal(normalizeTestFile("test" + BS + "cli.test.js:103:1"), "test/cli.test.js");
  assert.equal(normalizeTestFile("D:" + BS + "ws" + BS + "test" + BS + "a.test.js:12:3"), "test/a.test.js");
  assert.equal(normalizeTestFile("test/foo.test.js"), "test/foo.test.js");
  assert.equal(normalizeTestFile(""), "");
});

test("extractErrorType / deriveArea: エラー種別とエリアを推定する", () => {
  assert.equal(extractErrorType("AssertionError [ERR_ASSERTION]: x"), "AssertionError");
  assert.equal(extractErrorType("TypeError: t0"), "TypeError");
  assert.equal(extractErrorType("何もない"), "Error");
  assert.equal(deriveArea("test/crash-guard.test.js", "x", "Error"), "crash-guard");
  assert.equal(deriveArea("test/x.test.js", "onEvent/onPostフック経由でbusに流れ", "TypeError"), "hooks");
  assert.equal(deriveArea("test/x.test.js", "承認フロー競合経路: 差し戻し記録", "AssertionError"), "approval-conflict");
  assert.equal(deriveArea("test/retry.test.js", "chat(stream): stall検知でリトライ", "Error"), "stream-stall");
  assert.equal(deriveArea("test/cli.test.js", "CLI: 何か", "AssertionError"), "cli");
});

test("parseTap: 実ログ形式(verboseサマリ+failing tests節)から8失敗を列挙する", () => {
  const r = parseTap("exit=1" + NL + REAL_SUMMARY_TAIL);
  assert.equal(r.tests, 603);
  assert.equal(r.pass, 588);
  assert.equal(r.fail, 8);
  assert.equal(r.skipped, 7);
  assert.equal(r.failures.length, 8);
  const files = r.failures.map((f) => f.file);
  assert.ok(files.includes("test/cli.test.js"));
  assert.equal(files.filter((f) => f === "test/long-run-resilience.test.js").length, 4);
  assert.ok(files.includes("test/model-policy.test.js"));
  assert.ok(files.includes("test/retry.test.js"));
  const names = r.failures.map((f) => f.name);
  assert.ok(names.includes("CLI: cancel/release/reopen/auditが実サーバーに対して動く"));
  assert.ok(names.includes("chat(stream): stall検知でリトライし、2回目で成功する"));
  const errTypes = r.failures.map((f) => f.errorType);
  assert.ok(errTypes.includes("AssertionError"));
  assert.ok(errTypes.includes("TypeError"));
  assert.ok(r.failures.every((f) => f.message.length > 0), "エラーメッセージが1行で取れる");
});

test("parseTap: simple形式(not ok行)も解析する", () => {
  const tap = [
    "# Subtest: すべて成功するテスト",
    "ok 1 - よいテスト",
    "not ok 2 - 壊れたテスト",
    "  ---",
    "    at test/whatever.test.js:9:1",
    "# tests 2",
    "# pass 1",
    "# fail 1",
  ].join(NL);
  const r = parseTap(tap);
  assert.equal(r.tests, 2);
  assert.equal(r.fail, 1);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].name, "壊れたテスト");
  assert.equal(r.failures[0].source, "simple");
});

test("parseTap: 失敗数はあるが失敗を特定できないときはrawHeadを添える", () => {
  const r = parseTap("# tests 5" + NL + "# pass 3" + NL + "# fail 2" + NL + "(意味不明の出力)");
  assert.equal(r.fail, 2);
  assert.equal(r.failures.length, 0);
  assert.ok(r.rawHead.includes("意味不明"));
});

test("classifyFailures: 既知リストと照合し新規のみをfreshへ出す(順序非依存)", () => {
  const r = parseTap("exit=1" + NL + REAL_SUMMARY_TAIL);
  const known = r.failures.slice(0, 5).map((f) => ({ file: f.file, name: f.name, area: "tdd-wip" }));
  const cls = classifyFailures(r, known);
  assert.equal(cls.known.length, 5);
  assert.equal(cls.fresh.length, 3);
  assert.ok(cls.summary.includes("tests=603"));
  assert.ok(cls.summary.includes("known=5"));
  assert.ok(cls.summary.includes("fresh=3"));
  // ファイルが空の既知宣言は名前だけで照合する
  const cls2 = classifyFailures(r, r.failures.slice(0, 2).map((f) => ({ file: "", name: f.name })));
  assert.equal(cls2.known.length, 2);
  assert.equal(cls2.fresh.length, 6);
});

test("classifyFailures: 既知ゼロなら全て新規(現mainの8失敗が全て列挙される)", () => {
  const r = parseTap("exit=1" + NL + REAL_SUMMARY_TAIL);
  const cls = classifyFailures(r, []);
  assert.equal(cls.known.length, 0);
  assert.equal(cls.fresh.length, 8);
});

test("buildFixCandidates: エリア別に集約し、単一ファイルなら絞り込みコマンドを添える", () => {
  const r = parseTap("exit=1" + NL + REAL_SUMMARY_TAIL);
  const cls = classifyFailures(r, []);
  const candidates = buildFixCandidates(cls.fresh);
  assert.ok(candidates.length >= 2 && candidates.length <= 5, "エリア集約で過剰起票しない: got " + candidates.length);
  const ids = candidates.map((c) => c.id);
  assert.ok(new Set(ids).size === ids.length, "id重複なし");
  for (const c of candidates) {
    assert.match(c.id, /^fix-triage-/);
    assert.equal(c.role, "impl");
    assert.equal(c.project, "test-triage");
    assert.ok(c.acceptance.length > 0);
    assert.ok(c.body.includes("git merge main"));
    assert.ok(c.body.includes("件を修正せよ"));
  }
  const single = buildFixCandidates([{ name: "CLI: 何かが壊れる", file: "test/cli.test.js", errorType: "AssertionError", message: "boom", source: "summary" }]);
  assert.equal(single.length, 1);
  assert.equal(single[0].id, "fix-triage-cli");
  assert.ok(single[0].body.includes("node --test test/cli.test.js"), "単一ファイルは絞り込みコマンド");
});
// プローブ別に応答を返すfakeExec(smoke→失敗は返さない・diff→差分なし・triage→フィクスチャ)
function makeProbeAwareExec(fixtures) {
  return async (o) => {
    const c = String(o.command ?? "");
    if (c.includes("--name-status")) return { ok: true, text: "exit=0" + NL };
    if (c.startsWith("node --test")) return { ok: true, text: "exit=0" + NL + "# pass 1" + NL };
    return fixtures.triage ?? { ok: true, text: "exit=0" + NL };
  };
}

test("発見器統合: probes.triageで新規失敗だけがfix候補タスクとして起票される", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-triage-"));
  try {
    const bus = new Bus();
    const tasks = new TaskBlackboard(ws, bus);
    const created = [];
    bus.on("discovery.created", ({ taskId }) => created.push(taskId));
    // 既知: ガード系2件だけ既知扱い(残りは新規)
    const full = parseTap("exit=1" + NL + REAL_SUMMARY_TAIL);
    const known = full.failures
      .filter((f) => f.name.includes("ガード"))
      .map((f) => ({ file: f.file, name: f.name, area: "crash-guard" }));
    const d = startDiscovery({
      workspace: ws, tasks, bus, intervalSec: 3600,
      probes: { triage: { mode: "on", knownFailures: known } },
      exec: makeProbeAwareExec({ triage: { ok: false, text: "exit=1" + NL + REAL_SUMMARY_TAIL } }),
    });
    await d.tick();
    assert.equal(created.length, 4, "新規6件をエリア集約して4候補: got " + created.join(","));
    assert.ok(created.every((id) => id.startsWith("fix-triage-")));
    assert.ok(!created.includes("fix-triage-crash-guard"), "既知のガード系は起票しない");
    const body = readFileSync(join(ws, "tasks", "open", created[0] + ".md"), "utf8");
    assert.ok(body.includes("## 失敗テスト"));
    await d.tick();
    assert.equal(created.length, 4, "重複起票なし");
    d.stop();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("発見器統合: 全緑なら起票せず、全て既知でも起票しない", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-triage-"));
  try {
    const bus = new Bus();
    const tasks = new TaskBlackboard(ws, bus);
    const created = [];
    bus.on("discovery.created", ({ taskId }) => created.push(taskId));
    const d = startDiscovery({
      workspace: ws, tasks, bus, intervalSec: 3600,
      probes: { triage: { mode: "on" } },
      exec: makeProbeAwareExec({ triage: { ok: true, text: "exit=0" + NL + "ℹ tests 10" + NL + "ℹ pass 10" + NL + "ℹ fail 0" } }),
    });
    await d.tick();
    assert.equal(created.length, 0);
    // 全失敗が既知リストに載っていれば起票しない(TDD途中領域の静観)
    const full = parseTap("exit=1" + NL + REAL_SUMMARY_TAIL);
    const d2 = startDiscovery({
      workspace: ws, tasks, bus, intervalSec: 3600,
      probes: { triage: { mode: "on", knownFailures: full.failures.map((f) => ({ file: f.file, name: f.name })) } },
      exec: makeProbeAwareExec({ triage: { ok: false, text: "exit=1" + NL + REAL_SUMMARY_TAIL } }),
    });
    await d2.tick();
    assert.equal(created.length, 0, "全て既知なら新規ゼロ・起票なし");
    d.stop(); d2.stop();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("発見器統合: 既定(off)ではトリアージプローブは動かない(従来動作を壊さない)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-triage-"));
  try {
    const bus = new Bus();
    const tasks = new TaskBlackboard(ws, bus);
    let triageCalls = 0;
    const exec = async (o) => {
      const c = String(o.command ?? "");
      if (c.includes("--name-status")) return { ok: true, text: "exit=0" + NL };
      if (c.startsWith("node --test")) return { ok: true, text: "exit=0" + NL + "# pass 1" + NL };
      triageCalls++;
      return { ok: true, text: "exit=0" + NL };
    };
    const d = startDiscovery({ workspace: ws, tasks, bus, intervalSec: 3600, exec });
    await d.tick();
    assert.equal(triageCalls, 0, "triageプローブは発火しない");
    d.stop();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
