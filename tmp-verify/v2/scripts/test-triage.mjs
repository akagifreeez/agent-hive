#!/usr/bin/env node
// フルテストスイート失敗のトリアージCLI。
// 使い方:
//   node scripts/test-triage.mjs                       # npm test を実行して分類結果を表示(起票なし)
//   node scripts/test-triage.mjs --command "node --test test/foo.test.js"   # 実行コマンドを差し替え
//   node scripts/test-triage.mjs --known known-failures.json                # 既知失敗リストを差し替え
//   node scripts/test-triage.mjs --apply                    # 新規失敗をfix候補タスクとして起票
//   node scripts/test-triage.mjs --json                     # JSONで出力
// 既知失敗リストの既定値は hive.config.json の discovery.probes.triage.knownFailures。
// 重いフル実行は発見器プローブからは分離(既定off)なので、手動/定期仕事として安全に回せる。
import { parseTap, classifyFailures, buildFixCandidates } from "../src/engine/test-triage.js";
import { runCommand } from "../src/engine/exec.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { Bus } from "../src/engine/board.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** コマンドライン引数を解析する(最小限・依存ゼロ) */
function parseArgs(argv) {
  const args = { command: null, known: null, apply: false, json: false, workspace: process.cwd(), timeoutMs: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--command") args.command = argv[++i] ?? null;
    else if (a === "--known") args.known = argv[++i] ?? null;
    else if (a === "--apply") args.apply = true;
    else if (a === "--json") args.json = true;
    else if (a === "--workspace") args.workspace = argv[++i] ?? process.cwd();
    else if (a === "--timeout-ms") args.timeoutMs = parseInt(argv[++i] ?? "300000", 10);
  }
  return args;
}

/** 既知失敗リストを読む(--knownファイル > hive.config.json > 空配列) */
function loadKnownFailures(args) {
  if (args.known) {
    const p = join(args.workspace, args.known);
    return JSON.parse(readFileSync(p, "utf8"));
  }
  const cfgPath = join(args.workspace, "hive.config.json");
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      const k = cfg.discovery?.probes?.triage?.knownFailures;
      if (Array.isArray(k)) return k;
    } catch { /* config壊れ時は空で継続 */ }
  }
  return [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command ?? "npm test";
  const timeoutMs = args.timeoutMs ?? 300000;
  process.stdout.write("[triage] running: " + command + " (timeout=" + timeoutMs + "ms)" + String.fromCharCode(10));
  // keep=tail: 失敗節(failing tests)は出力の末尾に出るため末尾を保持
  const r = await runCommand({ command, cwd: args.workspace, timeoutMs, outputLimit: 120000, keep: "tail" });
  const report = parseTap(r.text ?? "");
  const known = loadKnownFailures(args);
  const cls = classifyFailures(report, known);
  const candidates = buildFixCandidates(cls.fresh);
  const out = {
    command,
    ok: r.ok,
    tests: report.tests, pass: report.pass, fail: report.fail, skipped: report.skipped,
    known: cls.known,
    fresh: cls.fresh,
    candidates: candidates.map((c) => ({ id: c.id, acceptance: c.acceptance })),
    created: [],
  };
  if (args.apply && cls.fresh.length > 0) {
    const tasks = new TaskBlackboard(args.workspace, new Bus());
    for (const c of candidates) {
      const created = tasks.create(c);
      if (created) out.created.push(c.id);
    }
  }
  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(cls.summary);
    console.log("--- known (" + cls.known.length + "):");
    for (const f of cls.known) console.log("  [known] " + f.file + " / " + f.name + " (" + f.errorType + ")");
    console.log("--- fresh (" + cls.fresh.length + "):");
    for (const f of cls.fresh) console.log("  [fresh] " + f.file + " / " + f.name + " (" + f.errorType + ": " + f.message.slice(0, 80) + ")");
    console.log("--- fix candidates (" + candidates.length + "):");
    for (const c of candidates) console.log("  " + c.id + (out.created.includes(c.id) ? " [created]" : args.apply ? " [exists]" : " [dry-run: --applyで起票]"));
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error("[triage] error:", err.message);
  process.exitCode = 1;
});
