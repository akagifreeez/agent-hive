// README自動更新(イシュー#18)の検証。
// (1)コード変更を検知してREADME auto セクションが自動更新されること
// (2)人間が書いた部分(auto区間外)は保護されること
// の両方をテストで担保する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitAutoSections, updateReadme, generateCliCommands, generateRepoLayout } from "../src/readme-autoupdate.js";

function mkRepo() {
  const root = mkdtempSync(join(tmpdir(), "hive-readme-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src", "engine"), { recursive: true });
  return root;
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsロックは無視 */ }
}

const HELP_TEMPLATE = `agent-hive CLI — テスト用

使い方: node bin/hive.js <コマンド>

  status                    稼働状態を一覧
  __NEWCMD__                追加されたコマンド(テスト用)

  --port N                  ポート
`;

test("splitAutoSections: auto区間とテキストを分け、未閉鎖区間はテキスト扱いで保護", () => {
  const text = [
    "人間の導入文",
    "<!-- auto:cli-commands start -->",
    "旧本文",
    "<!-- auto:cli-commands end -->",
    "人間の結尾文",
  ].join("\n");
  const parts = splitAutoSections(text);
  assert.deepEqual(parts.map((p) => p.kind), ["text", "auto", "text"]);
  assert.equal(parts[1].name, "cli-commands");
  assert.equal(parts[1].body, "旧本文");
  // 未閉鎖: startだけある場合は触らない(保護)
  const broken = "A\n<!-- auto:x start -->\nB";
  const p2 = splitAutoSections(broken);
  assert.ok(p2.every((p) => p.kind === "text"));
  assert.equal(p2.map((p) => p.body).join("\n"), broken);
});

test("updateReadme: コード(HELP)変更を検知してcli-commandsセクションが自動更新される", () => {
  const root = mkRepo();
  try {
    const help1 = HELP_TEMPLATE.replace("__NEWCMD__", "oldcmd");
    writeFileSync(join(root, "bin", "hive.js"), `const HELP = \`${help1}\`;\n`);
    const readme = join(root, "README.md");
    const initial = [
      "# agent-hive",
      "人間の書いた説明(保護対象)",
      "<!-- auto:cli-commands start -->",
      "```",
      "node bin/hive.js status  古い説明",
      "```",
      "<!-- auto:cli-commands end -->",
      "フッターも人間の文章",
    ].join("\n");
    writeFileSync(readme, initial);
    // 1回目: コード(HELP)の実態に合わせて更新される
    let writes = [];
    const r1 = updateReadme(readme, { root, write: (p, c) => writes.push([p, c]) });
    assert.equal(r1.changed, true);
    assert.deepEqual(r1.updatedSections, ["cli-commands"]);
    assert.ok(r1.after.includes("node bin/hive.js status                    稼働状態を一覧"), "HELPから生成される");
    assert.ok(!r1.after.includes("古い説明"), "旧本文は置き換わる");
    assert.equal(writes.length, 1, "write注入経由で書かれる");
    writeFileSync(readme, r1.after);
    // コード変更(HELPにコマンド追加)→ 再実行で検知・更新される
    writeFileSync(join(root, "bin", "hive.js"), `const HELP = \`${HELP_TEMPLATE.replace("__NEWCMD__", "newcmd")}\`;\n`);
    const r2 = updateReadme(readme, { root, write: (p, c) => writeFileSync(p, c) });
    assert.equal(r2.changed, true);
    assert.ok(r2.after.includes("node bin/hive.js newcmd"), "コード変更がREADMEへ反映される");
    assert.equal(readFileSync(readme, "utf8").includes("node bin/hive.js newcmd"), true);
    // 3回目: コードもREADMEも変わっていない → 何もしない(idempotent)
    const r3 = updateReadme(readme, { root, write: () => { throw new Error("差分無いのに書いた"); } });
    assert.equal(r3.changed, false);
  } finally {
    rmTree(root);
  }
});

test("updateReadme: 人間が書いた部分(auto区間外)は一切変更されない", () => {
  const root = mkRepo();
  try {
    writeFileSync(join(root, "bin", "hive.js"), `const HELP = \`${HELP_TEMPLATE.replace("__NEWCMD__", "cmdx")}\`;\n`);
    mkdirSync(join(root, "docs"), { recursive: true });
    const humanHead = "# agent-hive\n\n人が書いた導入。改行や空白も含めて保護。\n\n- 箇条書き\n- もう1行\n";
    const humanTail = "\n---\nフッター。ここも絶対に触らない(コードと無関係な文)。\n";
    const readme = join(root, "README.md");
    writeFileSync(readme, humanHead + "<!-- auto:cli-commands start -->\n古い\n<!-- auto:cli-commands end -->" + humanTail);
    const r = updateReadme(readme, { root, write: (p, c) => writeFileSync(p, c) });
    assert.equal(r.changed, true);
    const after = readFileSync(readme, "utf8");
    assert.ok(after.startsWith(humanHead), "先頭の人間部分はバイト一致で保護");
    assert.ok(after.endsWith(humanTail), "末尾の人間部分はバイト一致で保護");
    // auto区間が壊れている(未閉鎖)場合は更新しない(保護契約)
    writeFileSync(readme, humanHead + "<!-- auto:cli-commands start -->\n閉じ忘れ");
    const r2 = updateReadme(readme, { root, write: () => { throw new Error("未閉鎖なのに書いた"); } });
    assert.equal(r2.changed, false, "未閉鎖のauto区間は保護(更新しない)");
  } finally {
    rmTree(root);
  }
});

test("updateReadme: 未知セクション・生成不能は現状維持(保護), repo-layoutはディレクトリ実在から生成", () => {
  const root = mkRepo();
  try {
    const readme = join(root, "README.md");
    const initial = [
      "導入",
      "<!-- auto:unknown-section start -->",
      "中身",
      "<!-- auto:unknown-section end -->",
      "<!-- auto:repo-layout start -->",
      "古いレイアウト",
      "<!-- auto:repo-layout end -->",
    ].join("\n");
    writeFileSync(readme, initial);
    mkdirSync(join(root, "docs"), { recursive: true }); // repo-layoutの期待行(docs/)用
    const r = updateReadme(readme, { root, write: (p, c) => writeFileSync(p, c) });
    assert.ok(r.after.includes("<!-- auto:unknown-section start -->\n中身"), "未知セクションはそのまま保護");
    assert.ok(r.after.includes("bin/ CLI"), "実在ディレクトリからrepo-layoutを生成");
    assert.ok(r.after.includes("src/engine/ コア"), "役割説明付き");
    assert.ok(!r.after.includes("古いレイアウト"));
    // 生成不能(bin/hive.js削除)なら現状維持
    rmSync(join(root, "bin", "hive.js"), { force: true });
    const r2 = updateReadme(readme, { root, write: () => { throw new Error("生成不能なのに書いた"); } });
    assert.equal(r2.updatedSections.includes("cli-commands"), false, "cli-commandsは現状維持");
  } finally {
    rmTree(root);
  }
});

test("generateCliCommands/generateRepoLayout: 実ファイルからの生成が動く(このリポジトリ)", () => {
  const root = join(import.meta.dirname ?? ".", "..");
  const cli = generateCliCommands(root);
  assert.ok(cli, "bin/hive.jsから生成できる");
  assert.match(cli, /node bin\/hive\.js status/);
  const layout = generateRepoLayout(root);
  assert.ok(layout && layout.includes("bin/ CLI"));
});
