// README自動更新(イシュー#18): コード変更を検知してREADMEの auto: セクションを再生成する。
//
// 仕組み:
// - READMEの保護区間は `<!-- auto:<名前> start -->` 〜 `<!-- auto:<名前> end -->` のコメント対。
//   区間外は人間が書いた部分として絶対に触らない(誤編集防止の保護契約)。
// - 各セクションはジェネレータ関数が「コードの実態」から本文を組み立てる。実態が変われば
//   生成結果も変わる=コード変更の検知は再生成と現行本文の比較で行う(diff無しなら書かない)。
// - 現在のセクション: cli-commands(bin/hive.jsのHELPから) / repo-layout(ディレクトリ実在チェック付き)。
//
// 使い方: updateReadme(path, { root }) が { changed, after } を返す。書込は呼び出し側が行う
// (checkモードは scripts/doctor.js やテストから dryRun で使用)。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * README本文を auto セクション単位に分割する。
 * @param {string} text README本文
 * @returns {Array<{kind: "text"|"auto", name?: string, body: string}>} 順序を保った断片列
 */
export function splitAutoSections(text) {
  const parts = [];
  const lines = text.split("\n");
  let buf = [];
  let cur = null; // { name, body: string[] }
  for (const line of lines) {
    if (cur === null) {
      const m = line.match(/^<!-- auto:([a-z0-9-]+) start -->\s*$/);
      if (m) {
        if (buf.length) parts.push({ kind: "text", body: buf.join("\n") });
        buf = [];
        cur = { name: m[1], body: [] };
        continue;
      }
      buf.push(line);
    } else {
      if (new RegExp(`^<!-- auto:${cur.name} end -->\\s*$`).test(line)) {
        parts.push({ kind: "auto", name: cur.name, body: cur.body.join("\n") });
        cur = null;
        buf = [];
        continue;
      }
      cur.body.push(line);
    }
  }
  // auto閉じが無い場合は保護契約として触らない(テキスト扱いでそのまま返す)
  if (cur !== null) {
    parts.push({ kind: "text", body: [...buf, `<!-- auto:${cur.name} start -->`, ...cur.body].join("\n") });
  } else if (buf.length) {
    parts.push({ kind: "text", body: buf.join("\n") });
  }
  return parts;
}

/** bin/hive.js のHELP本文からコマンド一覧ブロックを組み立てる(コードの実態=HELP定数)。 */
export function generateCliCommands(root) {
  const hivePath = join(root, "bin", "hive.js");
  if (!existsSync(hivePath)) return null;
  const src = readFileSync(hivePath, "utf8");
  const helpMatch = src.match(/const HELP = `([\s\S]*?)`;/);
  if (!helpMatch) return null;
  const help = helpMatch[1];
  const usageIdx = help.indexOf("使い方:");
  if (usageIdx < 0) return null;
  const lines = help.slice(usageIdx).split("\n").slice(1);
  const cmds = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) {
      if (cmds.length) break; // コマンド列の終端(オプション群の手の空行)
      continue;
    }
    if (/^--port/.test(t)) continue; // グローバルオプションはREADME従来形では列挙しない
    cmds.push(`node bin/hive.js ${t}`);
  }
  if (!cmds.length) return null;
  return ["```", ...cmds, "```"].join("\n");
}

/** リポジトリのディレクトリ構成から layout セクションを組み立てる。
 * 役割説明は実在ディレクトリのみ列挙(説明は既知マップから引く。未知ディレクトリは載せない)。 */
const LAYOUT_ROLES = {
  "src/engine": "コア(ボード/タスク/worktree/ループ/発見器/記憶/権限/MCP/監査)",
  "src/ui": "HTTPサーバー+ブラウザUI(依存ゼロ)",
  "src/model": "モデルアダプタ(ワイヤ形式ごと)+ファクトリ+共有スロットリング",
  "src/desktop": "Electron殻(トレイ常駐・通知・梱包時のデータ分離)",
  bin: "CLI",
  agents: "エージェントのペルソナ",
  docs: "設計ノート・監査レポート(redteam結果含む)",
  scripts: "補助スクリプト(doctor/e2e等)",
  test: "テスト(node --test)",
  memory: "エージェント用の永続記憶(制約・決定事項)",
};

export function generateRepoLayout(root) {
  const rows = [];
  try {
    const top = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const name of top.filter((n) => LAYOUT_ROLES[n])) rows.push(name);
    // src/ はコードの本体。既知の役割を持つ子ディレクトリ(src/engine 等)を展開して載せる
    const srcDir = join(root, "src");
    if (existsSync(srcDir)) {
      const kids = readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `src/${e.name}`);
      rows.push(...kids.filter((n) => LAYOUT_ROLES[n]));
    }
  } catch {
    return null;
  }
  const entries = [...new Set(rows)];
  if (!entries.length) return null;
  const rank = (n) => (n.startsWith("src/") ? 0 : n === "bin" ? 1 : n === "agents" ? 2 : n === "docs" ? 3 : 4);
  entries.sort((a, b) => {
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.localeCompare(b);
  });
  return ["```", ...entries.map((name) => `${name}/ ${LAYOUT_ROLES[name]}`), "```"].join("\n");
}

/** セクション名 → ジェネレータ。 */
function generators(root) {
  return {
    "cli-commands": () => generateCliCommands(root),
    "repo-layout": () => generateRepoLayout(root),
  };
}

/**
 * READMEを更新する。auto区間だけを再生成し、区間外(人間の書いた部分)は一切触らない。
 * @param {string} readmePath READMEのパス
 * @param {{root?: string, write?: (p: string, content: string) => void}} [opts]
 *   writeを渡した場合のみ差分あり時にファイルへ書く(テストはメモリ注入、運用はfs.writeFileSync)。
 *   渡さない場合は何も書かず changed だけ返す(check用途)。
 * @returns {{changed: boolean, after: string, sections: string[], updatedSections: string[]}}
 */
export function updateReadme(readmePath, opts = {}) {
  const root = opts.root ?? dirname(readmePath);
  const before = readFileSync(readmePath, "utf8");
  const gen = generators(root);
  const parts = splitAutoSections(before);
  const updatedSections = [];
  const after = parts
    .map((p) => {
      if (p.kind !== "auto") return p.body;
      const wrap = (body) => `<!-- auto:${p.name} start -->\n${body}\n<!-- auto:${p.name} end -->`;
      const g = gen[p.name];
      if (!g) return wrap(p.body); // 未知セクションは保護(そのまま)
      const generated = g();
      if (generated === null) return wrap(p.body); // 生成不能は現状維持
      const next = wrap(generated);
      if (next !== wrap(p.body)) updatedSections.push(p.name);
      return next;
    })
    .join("\n");
  const changed = after !== before;
  if (changed && typeof opts.write === "function") opts.write(readmePath, after);
  return { changed, after, sections: parts.filter((p) => p.kind === "auto").map((p) => p.name), updatedSections };
}
