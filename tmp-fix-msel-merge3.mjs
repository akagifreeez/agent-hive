// tmp-fix-msel-merge3.mjs — テストのリーダー判定を threadOpener 方式(main採用実装)へ統一。目的達成後に削除
import { readFileSync, writeFileSync } from "node:fs";
const p = "test/model-task-select.test.js";
let s = readFileSync(p, "utf8");
const LF = String.fromCharCode(10);
const DQ = String.fromCharCode(34);

// makeTools に threadOpener オプションを追加
const a1 = "  return { tools: createTools({ agent, workspace: ws, board, tasks, bus }), tasks };" + LF;
if (!s.includes(a1)) { console.log("A1-NOT-FOUND"); process.exit(1); }
const rep1 = "  return { tools: createTools({ agent, workspace: ws, board, tasks, bus, threadOpener: leader ? () => ({ ok: true }) : null }), tasks };" + LF;
s = s.replace(a1, rep1);

// makeTools の引数に leader を追加
const a2 = "function makeTools(ws, agent) {" + LF;
if (!s.includes(a2)) { console.log("A2-NOT-FOUND"); process.exit(1); }
s = s.replace(a2, "function makeTools(ws, agent, leader = false) {" + LF);

// 非リーダーテスト: エラー文面の期待値をmain採用実装の文面へ+depth判定でなくthreadOpener判定を明示
const a3 = "  assert.match(r.text, /リーダーだけ/);" + LF;
if (!s.includes(a3)) { console.log("A3-NOT-FOUND"); process.exit(1); }
s = s.replace(a3, "  assert.match(r.text, /リーダー専用/);" + LF);

// リーダーテスト: makeTools に leader: true を渡す
const a4 = "  const { tools, tasks } = makeTools(ws, lead);" + LF;
const n4 = s.split(a4).length - 1;
if (n4 < 1) { console.log("A4-NOT-FOUND"); process.exit(1); }
s = s.split(a4).join("  const { tools, tasks } = makeTools(ws, lead, true);" + LF);
console.log("leader-tools replaced:", n4);

writeFileSync(p, s);
console.log("WRITTEN");
