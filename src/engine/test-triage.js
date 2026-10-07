// フルテストスイート失敗のトリアージ(純関数コア)。
// node:test のTAP出力(verboseサマリ形式・simple形式の両対応)を解析し、
// 失敗テストを「既知失敗(TDD途中領域)」と「新規失敗」へ分類する。
// 既知リストはconfig(discovery.probes.triage.knownFailures)で管理し、
// 新規失敗だけをfix候補タスクとして起票する(重複起票は発見器側で抑止)。
// 実行コマンドは差し替え可能(重いフル実行はプローブ既定から分離。exec-test-semaphore
// 着地後に安全へ)。UI/LLM非依存・依存ゼロ(node:標準のみ)。

/**
 * 1件の失敗テスト
 * @typedef {Object} TriageFailure
 * @property {string} name テスト名
 * @property {string} file テストファイル(test/ 基準・セパレータ正規化済み)
 * @property {string} errorType エラー種別(AssertionError/TypeError/Error...)
 * @property {string} message エラーメッセージ(1行・長すぎる場合は切り詰め)
 * @property {"summary"|"simple"} source 検出元(failing tests節 / not ok行)
 */

/**
 * トリアージレポート
 * @typedef {Object} TriageReport
 * @property {number} tests 総テスト数(不明は-1)
 * @property {number} pass
 * @property {number} fail
 * @property {number} skipped
 * @property {TriageFailure[]} failures 検出された全失敗
 * @property {string} [rawHead] 出力の先頭付近(パース不能時の診断用)
 */

/**
 * 既知失敗1件の宣言(configで管理)
 * @typedef {Object} KnownFailure
 * @property {string} file テストファイル(test/ 基準)
 * @property {string} name テスト名(完全一致)
 * @property {string} [area] 分類ラベル(未指定ならderiveAreaで推定)
 * @property {string} [note] 備考(TDD途中領域の説明など)
 */

/**
 * 分類結果
 * @typedef {Object} TriageClassification
 * @property {TriageFailure[]} known 既知失敗(リスト照合済み)
 * @property {TriageFailure[]} fresh 新規失敗(要対応)
 * @property {string} summary 人間向け1行サマリ
 */

/** テストファイルパス表記を正規化する(バックスラッシュ→スラッシュ、test/ 基準へ) */
export function normalizeTestFile(raw) {
  let p = String(raw ?? "").split(String.fromCharCode(92)).join("/");
  // test at test/foo.test.js:103:1 のような行と列の接尾を落とす(数字のみの接尾を最大2段除去)
  for (let k = 0; k < 2; k++) {
    const j = p.lastIndexOf(":");
    if (j <= 0) break;
    const tail = p.slice(j + 1);
    if (!/^[0-9]+$/.test(tail)) break;
    p = p.slice(0, j);
  }
  const i = p.lastIndexOf("test/");
  if (i > 0) p = p.slice(i); // 絶対パスやワークスペース接頭辞を落とす
  return p;
}

/** エラー種別を抽出する("AssertionError [ERR_ASSERTION]: ..." → "AssertionError") */
export function extractErrorType(line) {
  const m = String(line ?? "").match(/^\s*([A-Za-z_$][\w$]*(?:Error|Exception))\s*(?:\[[A-Z_]+\])?/);
  return m ? m[1] : "Error";
}

/** エリア(系統)を推定する。既知リストの補助ラベル・fix候補の見出しに使う */
export function deriveArea(file, name, errorType) {
  const f = normalizeTestFile(file);
  const n = String(name ?? "");
  if (/crash[- ]?guard/.test(f) || /process-guard/.test(f)) return "crash-guard";
  if (/hook/i.test(n) || /hooks/.test(f)) return "hooks";
  if (/承認フロー/.test(n) || /approval/.test(f)) return "approval-conflict";
  if (/stall|stream|切断|リトライ/i.test(n) || /retry|stream/.test(f)) return "stream-stall";
  if (/cli/.test(f)) return "cli";
  return f.replace(/^test\//, "").replace(/\.test\.js$/, "") || (errorType || "unknown");
}

/** エラーメッセージを1行へ整える(長すぎる場合は切り詰め) */
function tidyMessage(line) {
  let m = String(line ?? "").replace(/\s+/g, " ").trim();
  if (m.length > 200) m = m.slice(0, 197) + "...";
  return m;
}

/**
 * TAP出力(node:test)を解析する。failing tests節(失敗詳細つき)を優先し、
 * 無ければ "not ok N - name" 行から簡易検出する。
 * @param {string} output テストランナーの出力全体
 * @returns {TriageReport}
 */
export function parseTap(output) {
  const text = String(output ?? "");
  const report = { tests: -1, pass: -1, fail: -1, skipped: -1, failures: [] };

  // サマリ(ℹ tests 603 形式)。旧形式(# tests 603)も許容
  const grab = (re) => {
    const m = text.match(re);
    return m ? parseInt(m[1], 10) : null;
  };
  report.tests = grab(/^[ℹ#]+\s*tests\s+(\d+)/m) ?? -1;
  report.pass = grab(/^[ℹ#]+\s*pass\s+(\d+)/m) ?? -1;
  report.fail = grab(/^[ℹ#]+\s*fail\s+(\d+)/m) ?? -1;
  report.skipped = grab(/^[ℹ#]+\s*skipped\s+(\d+)/m) ?? -1;

  // ── failing tests節(メイン経路)────────────────────────────
  const idx = text.indexOf("failing tests:");
  if (idx >= 0) {
    const section = text.slice(idx);
    const entryRe = /^test at (.+)$/gm; // ブロック区切り: "test at <file>"
    const starts = [];
    let m;
    while ((m = entryRe.exec(section)) !== null) {
      starts.push({ file: m[1], at: m.index + m[0].length });
    }
    for (let i = 0; i < starts.length; i++) {
      const end = section.indexOf("test at", starts[i].at);
      const block = section.slice(starts[i].at, end >= 0 ? end : undefined);
      const nameLine = block.match(/^\s*[✖xX]\s+(.+?)(?:\s*\(\d[\d.]*ms\))?\s*$/m);
      if (!nameLine) continue;
      const errLine = block.match(/^\s{0,4}([A-Za-z_$][\w$]*(?:Error|Exception))(?:\s*\[[A-Z_]+\])?:?\s*(.*)$/m);
      report.failures.push({
        name: nameLine[1].trim(),
        file: normalizeTestFile(starts[i].file),
        errorType: errLine ? errLine[1] : "Error",
        message: errLine ? tidyMessage(errLine[2]) : "",
        source: "summary",
      });
    }
  }
  if (report.failures.length > 0) return finish(report);

  // ── simple形式(not ok行)────────────────────────────────────
  let currentFile = "";
  for (const line of text.split("\n")) {
    const atFile = line.match(/at\s+(\S+\.test\.js)/);
    if (atFile) currentFile = normalizeTestFile(atFile[1]);
    const notOk = line.match(/^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/);
    if (notOk) {
      const name = notOk[1].replace(/\s*\(\d+[\d.]*ms\)\s*$/, "").trim();
      report.failures.push({ name, file: currentFile, errorType: "Error", message: "", source: "simple" });
    }
  }
  if (report.fail > 0 && report.failures.length === 0) {
    // 失敗数はあるが1件も特定できない(解析不能)。生出力の先頭を添えて上位へ委ねる
    report.rawHead = text.slice(0, 500);
  }
  return finish(report);
}

function finish(report) {
  if (report.fail < 0 && report.failures.length > 0) report.fail = report.failures.length;
  if (report.tests < 0 && report.pass >= 0 && report.fail >= 0) {
    report.tests = report.pass + report.fail + (report.skipped > 0 ? report.skipped : 0);
  }
  return report;
}

/**
 * 失敗を既知/新規へ分類する。照合キーは file+name(ファイルが空なら名前のみ)。
 * @param {TriageReport} report
 * @param {KnownFailure[]} knownFailures config等で管理される既知失敗リスト
 * @returns {TriageClassification}
 */
export function classifyFailures(report, knownFailures = []) {
  const knownList = Array.isArray(knownFailures) ? knownFailures : [];
  const keyOf = (file, name) => (file ? normalizeTestFile(file) + "::" + name : "*::" + name);
  const knownKeys = new Set(knownList.map((k) => keyOf(k.file, k.name)));
  const knownNames = new Set(knownList.filter((k) => !k.file).map((k) => k.name)); // file省略=名前だけで照合(ワイルドカード)
  const known = [];
  const fresh = [];
  for (const f of report.failures) {
    if (knownKeys.has(keyOf(f.file, f.name)) || knownNames.has(f.name)) known.push(f);
    else fresh.push(f);
  }
  const total = report.tests > 0 ? report.tests : report.failures.length;
  const summary = "tests=" + total + " fail=" + report.failures.length + " (known=" + known.length + " fresh=" + fresh.length + ")";
  return { known, fresh, summary };
}

/**
 * 新規失敗(群)からfix候補タスク1件を組み立てる(純関数)。
 * 失敗はエリア(系統)ごとに1タスクへ集約する(8件→最大5候補。粒度が細かすぎて
 * ボードが流れないようにする)。
 * @param {TriageFailure[]} failures 同一エリアの新規失敗群
 * @param {string} area エリアラベル(deriveAreaの結果)
 * @returns {{id: string, role: string, project: string, acceptance: string, body: string}}
 */
export function buildFixCandidate(failures, area) {
  const list = Array.isArray(failures) ? failures : [];
  const lines = list.map((f) => {
    const head = "- " + f.name + " (" + f.file + ")";
    return head + " / " + f.errorType + (f.message ? ": " + f.message : "");
  });
  const fileSet = [...new Set(list.map((f) => f.file).filter(Boolean))];
  const cmd = fileSet.length === 1 ? "node --test " + fileSet[0] : "npm test";
  const id = "fix-triage-" + String(area ?? "unknown").replace(/[^a-z0-9-]+/gi, "-");
  const body = [
    "フルスイートトリアージ(発見器)が新規失敗を検出した。エリア「" + area + "」の失敗 " + list.length + " 件を修正せよ。",
    "",
    "## 失敗テスト(" + list.length + "件)",
    ...lines,
    "",
    "- まず bash で `git merge main` して最新mainを取り込む。",
    "- 失敗原因を特定して修正する(テストがTDD途中領域なら、その旨をボードへ報告し既知失敗リストへの登録を提案する)。",
    "- 修正後 `" + cmd + "` を通し、ボードへ報告して finish_task。",
  ].join(String.fromCharCode(10));
  return {
    id,
    role: "impl",
    project: "test-triage",
    acceptance: "対象失敗テスト(" + list.length + "件)が通ること。" + cmd + " が緑であること。",
    body,
  };
}

/**
 * 失敗群をエリアごとに集約しfix候補群へ組み立てる。
 * @param {TriageFailure[]} fresh 新規失敗群
 * @returns {Array<ReturnType<typeof buildFixCandidate>>}
 */
export function buildFixCandidates(fresh) {
  const byArea = new Map();
  for (const f of Array.isArray(fresh) ? fresh : []) {
    const area = deriveArea(f.file, f.name, f.errorType);
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(f);
  }
  return [...byArea.entries()].map(([area, fs]) => buildFixCandidate(fs, area));
}
