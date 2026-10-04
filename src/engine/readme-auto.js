// README自動更新(イシュー#18): コード変更を検知してREADMEの該当セクションを
// 自動更新する仕組み。人間が書いた部分は保護する。
//
// 設計:
// - README内の機械管理領域は `<!-- auto:<id> start -->` 〜 `<!-- auto:<id> end -->`
//   のHTMLコメントマーカーで明示する。この外側(人間が書いた部分)は一切書き換えない。
//   マーカーが無いREADMEには何もしない(存在しない領域を勝手に生やさない=保護の最終ライン)。
// - 生成器(genCliCommands / genRepoLayout)がコード(bin/hive.jsのHELP、ディレクトリ構成)
//   から現在のセクション本文を作る。コードが変われば生成結果が変わり、差分だけが
//   マーカー間に流し込まれる。
// - 不正なセクションidは生成時点で拒否する(README破壊・パス操作の余地をなくす)。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// セクションidの正形: 英小文字・数字・ハイフンのみ(パス要素やシェル特殊文字を排除)
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function markerStart(id) { return `<!-- auto:${id} start -->`; }
export function markerEnd(id) { return `<!-- auto:${id} end -->`; }

function assertValidId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new Error(`invalid section id: ${JSON.stringify(id)} (英小文字・数字・ハイフンのみ)`);
  }
}

// READMEの文面から(改行コードを問わず)マーカー位置を探す。
// 戻り値: { index, mStart, mEnd } — いずれも-1なら未設置
function findMarker(text, id) {
  const s = markerStart(id);
  const e = markerEnd(id);
  const i = text.indexOf(s);
  const j = text.indexOf(e);
  return { index: i, mStart: s, mEnd: e, end: j };
}

/**
 * READMEの自動セクションを更新する。マーカーの外は1文字も変わらない。
 * @param {object} o
 * @param {string} o.repoRoot READMEのあるリポジトリルート
 * @param {Array<{id: string, content: string}>} o.sections 更新したいセクション(id正形・本文はMarkdown)
 * @param {string} [o.readmeName="README.md"]
 * @returns {{changed: boolean, updated: string[], skipped: string[], missing: string[]}}
 *   updated=書き換えたid / skipped=マーカー未設置で保護されたid / missing=内容一致で変化なし
 */
export function updateReadmeSections(o) {
  const { repoRoot, sections } = o || {};
  const readmeName = o?.readmeName || "README.md";
  const path = join(repoRoot, readmeName);
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  let text = original;
  const updated = [], skipped = [], missing = [];
  let changed = false;

  for (const sec of sections || []) {
    assertValidId(sec.id);
    const m = findMarker(text, sec.id);
    if (m.index < 0 || m.end < 0 || m.end < m.index) {
      // マーカー無し=機械管理領域ではない → 触らない(人間の手書き部分の保護)
      skipped.push(sec.id);
      continue;
    }
    const next = text.slice(0, m.index + m.mStart.length)
      + "\n" + sec.content.replace(/^\n+|\n+$/g, "") + "\n"
      + text.slice(m.end);
    if (next !== text) {
      text = next;
      changed = true;
      updated.push(sec.id);
    } else {
      missing.push(sec.id);
    }
  }

  if (changed) writeFileSync(path, text);
  return { changed, updated, skipped, missing };
}

/**
 * 現在の生成結果とREADMEの内容が違うセクションid一覧を返す(検知のみ・書き換えない)。
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {Record<string, () => string>} o.generators id → 本文生成関数
 * @param {string} [o.readmeName="README.md"]
 * @returns {string[]} 更新が必要なid(READMEにマーカーが無いものは検知対象外=保護)
 */
export function detectStaleSections(o) {
  const { repoRoot, generators } = o || {};
  const readmeName = o?.readmeName || "README.md";
  const path = join(repoRoot, readmeName);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const stale = [];
  for (const [id, gen] of Object.entries(generators || {})) {
    assertValidId(id);
    const m = findMarker(text, id);
    if (m.index < 0 || m.end < 0) continue; // マーカー無しは保護対象なので検知しない
    const cur = text.slice(m.index + m.mStart.length, m.end).replace(/^\n+|\n+$/g, "");
    if (cur !== gen().replace(/^\n+|\n+$/g, "")) stale.push(id);
  }
  return stale;
}

/**
 * コードから生成できるセクションを一括更新する高レベル入口。
 * bin/hive.js のHELPとリポジトリ構成を自動セクションへ反映する。
 * @param {object} o
 * @param {string} o.repoRoot
 * @returns {{changed: boolean, updated: string[], skipped: string[], missing: string[]}}
 */
export function updateReadmeFromCode(o) {
  const repoRoot = o.repoRoot;
  const sections = [];
  const hivePath = join(repoRoot, "bin", "hive.js");
  if (existsSync(hivePath)) {
    const src = readFileSync(hivePath, "utf8");
    sections.push({ id: "cli-commands", content: genCliCommands(extractHelp(src)) });
  }
  sections.push({ id: "repo-layout", content: genRepoLayout(repoRoot) });
  return updateReadmeSections({ repoRoot, sections });
}

// bin/hive.js のソースから HELP テンプレートリテラルの中身を取り出す。
// 依存ゼロ方針なのでimportはせず、`const HELP = \`...\`` の区间を素朴に抽出する。
export function extractHelp(src) {
  const m = src.match(/const HELP = `([\s\S]*?)`;/);
  return m ? m[1] : "";
}

/**
 * HELP文面からコマンド一覧のMarkdownコードブロックを作る。
 * 「  コマンド  説明」の行を対象にし、グローバルオプション(--port等)は除外。
 * @param {string} help HELP文面
 * @returns {string} Markdownコードブロック
 */
export function genCliCommands(help) {
  const lines = String(help || "").split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!/^ {2}/.test(line)) continue; // インデント2の説明行のみ
    const m = line.match(/^ {2}(.+?)\s{2,}(.+?)\s*$/); // 「名前(空白1つを含む可)  説明(空白2以上で区切る)」
    if (!m) continue;
    if (m[1].startsWith("--")) continue; // グローバルオプションはコマンドでない
    rows.push(`node bin/hive.js ${m[1]}${" ".repeat(Math.max(2, 18 - m[1].length))}${m[2]}`);
  }
  const body = rows.join("\n");
  return "```\n" + body + "\n```";
}

// README「リポジトリ構成」に載せる代表的ディレクトリ(存在するものだけ)
const LAYOUT_DIRS = [
  ["src/engine/", "コア(ボード/タスク/worktree/ループ/発見器/記憶/権限/MCP/監査)"],
  ["src/ui/", "HTTPサーバー+ブラウザUI(依存ゼロ)"],
  ["src/desktop/", "Electron殻(トレイ常駐・通知・梱包時のデータ分離)"],
  ["bin/", "CLI"],
  ["agents/", "エージェントのペルソナ"],
  ["docs/", "設計ノート・監査レポート(redteam結果含む)"],
  ["scripts/", "補助スクリプト(doctor/e2e等)"],
  ["test/", "テスト(node --test)"],
];

/**
 * 実在ディレクトリだけを載せたリポジトリ構成のMarkdownコードブロックを作る。
 * @param {string} repoRoot
 * @returns {string}
 */
export function genRepoLayout(repoRoot) {
  const rows = [];
  for (const [dir, desc] of LAYOUT_DIRS) {
    const base = dir.replace(/\/$/, "");
    if (existsSync(join(repoRoot, base))) rows.push(`${dir} ${desc}`.trimEnd());
  }
  return "```\n" + rows.join("\n") + "\n```";
}
