// 一時スクリプト v2: test/spawn-chat.test.js へイシュー#26回帰テストを追加(CRLF対応。目的達成後削除)
import { readFileSync, writeFileSync } from "node:fs";

const p = "test/spawn-chat.test.js";
let s = readFileSync(p, "utf8");
if (s.includes("live掃除により次のspawn")) {
  console.log("ALREADY_INSERTED");
  process.exit(0);
}

const testLines = [
  '',
  'test("spawn: maxConcurrent=1で正常終了後、live掃除により次のspawnが即座に成功する(イシュー#26)", async () => {',
  '  const { ws, root, bus, board, tasks } = makeEnv();',
  '  await ensureGitRepo(ws);',
  '  const manager = new SpawnManager({',
  '    mainWorkspace: ws, worktreeRoot: root, board, tasks, bus,',
  '    hierarchy: { maxDepth: 2, maxConcurrent: 1 },',
  '    modelFactory: () => scriptedModel([{ text: "完了" }]),',
  '  });',
  '  const main = { id: "alpha", displayName: "アルファ", depth: 0 };',
  '  const r1 = await manager.spawn({ parent: main, brief: "1体目" });',
  '  assert.ok(r1.id);',
  '  // 正常終了を待つ(status=done)。#26: 終了エントリはliveからexitedへ退避される',
  '  assert.ok(await waitUntil(() => manager.snapshot()[r1.id]?.status === "done"));',
  '  assert.equal(manager.live.size, 0, "終了後のliveエントリは掃除される(live.sizeが0に戻る)");',
  '  assert.equal(manager.activeCount(), 0, "活性数も0(二重防护の判定が詰まらない)");',
  '  // 次のspawnが即座に成功する(終了済みが残っていても詰まらせない)',
  '  const r2 = await manager.spawn({ parent: main, brief: "2体目" });',
  '  assert.ok(r2.id, "終了済みエージェントがいても次のspawnは成功する");',
  '  assert.ok(await waitUntil(() => manager.snapshot()[r2.id]?.status === "done"));',
  '  try { rmSync(ws, { recursive: true, force: true }); } catch { /* ロックは無視 */ }',
  '  try { rmSync(root, { recursive: true, force: true }); } catch { /* ロックは無視 */ }',
  '});',
].join("\n");

// アンカーは「});\r\n\r\ntest(」の最初の出現(1個目のテスト終端)。行末コードを問わず堅牢に:
const anchorIdx = s.indexOf("});" + EOL() + EOL() + "test(");
if (anchorIdx < 0) {
  console.error("ANCHOR_NOT_FOUND");
  process.exit(1);
}
const insertPos = anchorIdx + 3; // 「});」の直後(改行の前)
s = s.slice(0, insertPos) + EOL() + testLines.split("\n").join(EOL()) + s.slice(insertPos);
writeFileSync(p, s);
console.log("INSERTED at", insertPos);

function EOL() {
  return s.includes("\r\n") ? "\r\n" : "\n";
}
