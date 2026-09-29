// README自動更新(イシュー#18): コード変更を検知してREADMEの該当セクションを
// 自動更新する。人間が書いた部分は保護(自動セクションマーカーの外は一切触らない)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateReadmeSections, detectStaleSections, updateReadmeFromCode, genCliCommands, genRepoLayout } from "../src/engine/readme-auto.js";

function makeFixture(ws, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(ws, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

function closeFixture(ws) {
  try { rmSync(ws, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

const mk = (id) => ({ start: `<!-- auto:${id} start -->`, end: `<!-- auto:${id} end -->` });

test("genCliCommands: HELPからコマンド一覧のコードブロックを作る", () => {
  const help = [
    "agent-hive CLI",
    "",
    "  status                    稼働状態を一覧",
    "  say <テキスト>            メインチャットへ発言",
    "",
    "  --port N                  ポート",
  ].join("\n");
  const md = genCliCommands(help);
  assert.match(md, /^```$/m); // 開閉フェンス両方ある
  assert.match(md, /node bin\/hive\.js status\s{2,}稼働状態を一覧/);
  assert.match(md, /node bin\/hive\.js say <テキスト>\s{2,}メインチャットへ発言/);
  assert.ok(!md.includes("--port")); // グローバルオプションはコマンド一覧に入れない
});

test("genCliCommands: 空HELPでも安全(空ブロック)", () => {
  const md = genCliCommands("");
  assert.match(md, /^```$/m);
  assert.ok(!md.includes("undefined"));
});

test("genRepoLayout: 実在ディレクトリから構成一覧を作る", () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-readme-auto-"));
  try {
    makeFixture(ws, { "src/engine/x.js": "", "src/ui/y.js": "", "bin/hive.js": "", "agents/alpha.md": "", "docs/n.md": "" });
    const md = genRepoLayout(ws);
    assert.match(md, /src\/engine\//);
    assert.match(md, /src\/ui\//);
    assert.match(md, /bin\//);
    assert.match(md, /agents\//);
    assert.match(md, /docs\//);
    assert.ok(!md.includes("test/")); // 実在しないものは載らない
  } finally { closeFixture(ws); }
});

test("updateReadmeSections: マーカー間だけが自動更新される", () => {
  const M = mk("cli-commands");
  const readme = [
    "# タイトル",
    "",
    "人間の書いた導入文。ここは絶対に変わらない。",
    "",
    M.start,
    "```",
    "node bin/hive.js old-cmd   古い説明",
    "```",
    M.end,
    "",
    "## 後続のセクション",
    "",
    "これも人間の文章。",
  ].join("\r\n");
  const ws = mkdtempSync(join(tmpdir(), "hive-readme-auto-"));
  try {
    makeFixture(ws, { "README.md": readme, "bin/hive.js": "" });
    const r = updateReadmeSections({
      repoRoot: ws,
      sections: [{ id: "cli-commands", content: "```\nnode bin/hive.js new-cmd   新しい説明\n```" }],
    });
    assert.equal(r.changed, true);
    assert.deepEqual(r.updated, ["cli-commands"]);
    const after = readFileSync(join(ws, "README.md"), "utf8");
    assert.match(after, /node bin\/hive\.js new-cmd/);
    assert.ok(!after.includes("old-cmd"));
    // 人間部分の保護(マーカー内外の文章がそのまま残る)
    assert.match(after, /人間の書いた導入文。ここは絶対に変わらない。/);
    assert.match(after, /## 後続のセクション/);
    assert.match(after, /これも人間の文章。/);
    assert.ok(!after.includes("!!!!!!!!")); // 余計な文字の混入もない
  } finally { closeFixture(ws); }
});

test("updateReadmeSections: マーカーが無いREADMEは1文字も変わらない(保護)", () => {
  const readme = "# 手書きREADME\r\n\r\nここに自動セクションの目印は無い。\r\n";
  const ws = mkdtempSync(join(tmpdir(), "hive-readme-auto-"));
  try {
    makeFixture(ws, { "README.md": readme });
    const r = updateReadmeSections({
      repoRoot: ws,
      sections: [{ id: "cli-commands", content: "自動生成したい内容" }],
    });
    assert.equal(r.changed, false);
    assert.deepEqual(r.skipped, ["cli-commands"]);
    assert.equal(readFileSync(join(ws, "README.md"), "utf8"), readme); // バイト等値
  } finally { closeFixture(ws); }
});

test("updateReadmeSections: 内容が同じなら書き換えない(冪等・changed=false)", () => {
  const content = "```\nnode bin/hive.js status   稼働状態\n```";
  const readme = ["導入。", "", mk("cli-commands").start, content, mk("cli-commands").end, ""].join("\n");
  const ws = mkdtempSync(join(tmpdir(), "hive-readme-auto-"));
  try {
    makeFixture(ws, { "README.md": readme });
    const r = updateReadmeSections({ repoRoot: ws, sections: [{ id: "cli-commands", content }] });
    assert.equal(r.changed, false);
    assert.equal(readFileSync(join(ws, "README.md"), "utf8"), readme);
  } finally { closeFixture(ws); }
});

test("updateReadmeSections: 複数セクションのうち該当だけ更新", () => {
  const A = mk("a"), B = mk("b");
  const readme = [A.start, "旧A", A.end, "", B.start, "旧B", B.end].join("\n");
  const ws = mkdtempSync(join(tmpdir(), "hive-readme-auto-"));
  try {
    makeFixture(ws, { "README.md": readme });
    const r = updateReadmeSections({ repoRoot: ws, sections: [{ id: "a", content: "新A" }] });
    assert.deepEqual(r.updated, ["a"]);
    const after = readFileSync(join(ws, "README.md"), "utf8");
    assert.match(after, /新A/);
    assert.match(after, /旧B/); // 指定されていないセクションは触らない
  } finally { closeFixture(ws); }
});

test("updateReadmeSections: 不正なidは拒否(シェル・パス系インジェクション防止)", () => {
  const ws = mkdtempSync(join(tmpdir(), "hive-readme-auto-"));
  try {
    makeFixture(ws, { "README.md": "本文" });
    for (const bad of ["a-b/cli", "../x", "a b", "", "a|b"]) {
      assert.throws(() => updateReadmeSections({ repoRoot: ws, sections: [{ id: bad, content: "x" }] }), /invalid section id/);
    }
  } finally { closeFixture(ws); }
});

test("detectStaleSections: 生成結果とREADMEの現在値が違うidを返す", () => {
  const M = mk("cli-commands");
  const ws = mkdtempSync(join(tmpdir(), "hive-readme-auto-"));
  try {
    makeFixture(ws, { "README.md": [M.start, "```\nnode bin/hive.js old   古い\n```", M.end].join("\n"), "bin/hive.js": "" });
    const gens = { "cli-commands": () => "```\nnode bin/hive.js new   新しい\n```" };
    assert.deepEqual(detectStaleSections({ repoRoot: ws, generators: gens }), ["cli-commands"]);
    // 一致していれば空
    writeFileSync(join(ws, "README.md"), [M.start, "```\nnode bin/hive.js new   新しい\n```", M.end].join("\n"));
    assert.deepEqual(detectStaleSections({ repoRoot: ws, generators: gens }), []);
  } finally { closeFixture(ws); }
});

test("detectStaleSections: 実コード(bin/hive.js)の変更を検知する", () => {
  const M = mk("cli-commands");
  const help = "  status     一覧\n  audit      監査\n";
  const readmeOld = [M.start, "```\nnode bin/hive.js old   古い説明\n```", M.end].join("\n");
  const ws = mkdtempSync(join(tmpdir(), "hive-readme-auto-"));
  try {
    makeFixture(ws, { "README.md": readmeOld, "bin/hive.js": `const HELP = \`\n${help}\`;\nexport { HELP };\n` });
    const r = updateReadmeFromCode({ repoRoot: ws });
    assert.equal(r.changed, true);
    assert.deepEqual(r.updated, ["cli-commands"]);
    const after = readFileSync(join(ws, "README.md"), "utf8");
    assert.match(after, /node bin\/hive\.js status\s{2,}一覧/);
    assert.match(after, /node bin\/hive\.js audit\s{2,}監査/);
    assert.ok(!after.includes("古い説明"));
  } finally { closeFixture(ws); }
});
