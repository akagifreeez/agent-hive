import { readFileSync, writeFileSync } from "node:fs";
const NL = String.fromCharCode(10);
const p = "src/engine/discover.js";
let s = readFileSync(p, "utf8");

// 1) import追加
const impAnchor = "import { runCommand } from";
const impLine = s.split(NL).find(l => l.startsWith(impAnchor));
if (!impLine) { console.error("anchor1 missing"); process.exit(1); }
if (s.includes("test-triage.js")) { console.log("already imported"); }
else {
  s = s.replace(impLine, impLine + NL + 'import { parseTap, classifyFailures, buildFixCandidates } from "./test-triage.js";');
}

// 2) probeTriage関数を挿入(readmeラッパコメントの直前)
const fnAnchor = "  // bin/hive.jsのHELPを取り出してcli-commandsセクション本文を作るラッパ";
if (!s.includes(fnAnchor)) { console.error("anchor2 missing"); process.exit(1); }
if (s.includes("probeTriage")) { console.log("already patched"); process.exit(0); }
const fn = [
  "  // ⑤ トリアージプローブ: フルスイート(または指定コマンド)を実行し、失敗を既知/新規へ分類。",
  "  //    新規失敗だけをエリア別のfix候補タスクへ起票する(既知リストはconfig管理・TDD途中領域の区別)。",
  "  //    重いフル実行は既定off(discovery.probes.triage.mode)。exec-test-semaphore着地後に有効化する想定。",
  "  let triageBusy = false;",
  "  async function probeTriage() {",
  "    const t = probes?.triage;",
  "    const mode = String(t?.mode ?? \"off\");",
  "    if (mode === \"off\" || triageBusy) return;",
  "    if (hasOutstandingWork()) {",
  "      bus.emit(\"discovery.skip\", { reason: \"通常タスクが残っているため、重いトリアージ実行を飛ばす\" });",
  "      return;",
  "    }",
  "    triageBusy = true;",
  "    try {",
  "      const command = t.command ?? \"npm test\";",
  "      const r = await exec({ command, cwd: workspace, timeoutMs: t.timeoutMs ?? 300000, outputLimit: 60000 });",
  "      const report = parseTap(r.text ?? \"\");",
  "      const known = Array.isArray(t.knownFailures) ? t.knownFailures : [];",
  "      if (r.ok && report.failures.length === 0) return; // 全緑: 仕事なし",
  "      const cls = classifyFailures(report, known);",
  "      const fresh = cls.fresh.filter((f) => !tasks.existsOpenOrClaimed(\"fix-triage-\" + areaSlug(deriveAreaSafe(f))));",
  "      const candidates = buildFixCandidates(fresh);",
  "      for (const c of candidates) {",
  "        if (tasks.existsOpenOrClaimed(c.id)) continue; // 重複起票防止",
  "        tasks.create(c);",
  "        bus.emit(\"discovery.created\", { taskId: c.id });",
  "      }",
  "    } finally {",
  "      triageBusy = false;",
  "    }",
  "  }",
  "  // エリア名をタスクidに安全な形へ(小文字英数字とハイフン)",
  "  function areaSlug(a) {",
  "    return String(a ?? \"unknown\").toLowerCase().replace(/[^a-z0-9-]+/g, \"-\");",
  "  }",
  "  function deriveAreaSafe(f) {",
  "    return deriveArea(f.file, f.name, f.errorType);",
  "  }",
  ""
];
s = s.replace(fnAnchor, fn.join(NL) + NL + fnAnchor);

// 3) tick() から呼ぶ(probeReadmeの後)
const tickAnchor = "      await probeReadme();";
if (!s.includes(tickAnchor)) { console.error("anchor3 missing"); process.exit(1); }
if (!s.includes("await probeTriage();")) {
  s = s.replace(tickAnchor, tickAnchor + NL + "      await probeTriage();");
}

// 4) deriveAreaをimportへ追加
s = s.replace(
  'import { parseTap, classifyFailures, buildFixCandidates } from "./test-triage.js";',
  'import { parseTap, classifyFailures, buildFixCandidates, deriveArea } from "./test-triage.js";'
);

writeFileSync(p, s);
console.log("patched discover.js OK");
