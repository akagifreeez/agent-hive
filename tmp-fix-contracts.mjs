// 契約不整合3件の修復パッチ(2026-10-07 gamma / project: issue-22-33-fixes)
// - fixes.test.js releaseOne: 実装(重複実体done掃除・dash lab実害)に合わせ true を期待へ
// - task-id-uniqueness.test.js: done再create拒否テストを現行契約(許可・seed側防御)へ書換
// - openai.js: ストリーム途中切断の正規化漏れ(stall等のErrorはリトライ不可になっていた)を修復
// CRLF環境のため行単位の完全一致置換で処理する。テンプレートリテラル/バックスラッシュは書かない。
import { readFileSync, writeFileSync } from "node:fs";

let changed = 0;

function patchLines(path, isMatch, makeReplacement, expectCount) {
  const raw = readFileSync(path, "utf8");
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(nl);
  const out = [];
  let hits = 0;
  for (let i = 0; i < lines.length; i++) {
    const rep = isMatch(lines, i);
    if (rep) {
      hits++;
      const repl = makeReplacement(lines, i);
      out.push(...repl);
      i += rep - 1;
    } else {
      out.push(lines[i]);
    }
  }
  if (hits !== expectCount) {
    throw new Error(path + ": 期待 " + expectCount + " 件に対し " + hits + " 件しか一致しません(中断・未書込)");
  }
  writeFileSync(path, out.join(nl));
  changed += hits;
  console.log("patched:", path, "hits=", hits);
}

// ---- (1) fixes.test.js releaseOne ----
patchLines(
  "test/fixes.test.js",
  (ls, i) => {
    const l = ls[i];
    return l.includes("assert.equal(tasks.releaseOne(") && l.includes('"note"), false);') ? 1 : 0;
  },
  (ls, i) => [ls[i].replace('"note"), false);', '"note"), true); // 実装契約: 重複実体はclaimed分をdone/へ掃除して解放成功')],
  1,
);

// ---- (2) task-id-uniqueness.test.js: done再create拒否テストを現行契約へ ----
patchLines(
  "test/task-id-uniqueness.test.js",
  (ls, i) => (ls[i].includes("#30: done済みIDの再createは拒否される") ? 11 : 0),
  (ls, i) => {
    const nl = "\r\n";
    const block = [
      'test("#30: done済みIDの再createは許可(現行契約・自動再投入運用)", () => {',
      '  // 現行契約(477bdde): create()はopen/claimedのみ一意性を見る。done再createは自動再投入・',
      "  // reopen運用の後方互換として許可。seed再実行での再起票防止はseed()側のdone参照で防御",
      "  // (blog lab実害: dependsOn依存解決の永久ブロック)。",
      "  const ws = mktmp();",
      "  const tasks = new TaskBlackboard(ws, new Bus());",
      '  tasks.create({ id: "reuse", body: "1回目" });',
      '  tasks.claim({ id: "alpha", role: null });',
      '  tasks.finish({ id: "alpha" }, "reuse");',
      '  const recreated = tasks.create({ id: "reuse", body: "2回目(再投入)" });',
      '  assert.equal(recreated, true, "done済みIDの再createは許可(後方互換)");',
      '  assert.equal(existsSync(join(ws, "tasks", "open", "reuse.md")), true, "openへ再起票される");',
      "  rmTree(ws);",
      "});",
    ];
    return block.map((s) => s.replace(/\n/g, nl));
  },
  1,
);

// ---- (3) openai.js: stream catch の正規化漏れ修復 ----
patchLines(
  "src/model/openai.js",
  (ls, i) => (ls[i].includes("if (isRetryableNetworkError(err) && attempt <= RETRY_MAX_RETRIES) {") ? 1 : 0),
  (ls, i) => {
    const nl = "\r\n";
    return [
      "          // 中断/瞬断系に加え、コードを持たない汎用Errorもstall/切断の可能性があるため",
      "          // メッセージ照合でリトライ契約へ乗せる(v6.6 stall復旧の回帰。2026-10-07 gamma)",
      "          if ((isRetryableNetworkError(err) || isRetryableStreamError(err)) && attempt <= RETRY_MAX_RETRIES) {",
    ].map((s) => s.replace(/\n/g, nl));
  },
  2,
);

// helper関数を isRetryableNetworkError の後に追加
patchLines(
  "src/model/openai.js",
  (ls, i) => (ls[i].includes("function isRetryableNetworkError(err) {") ? 5 : 0),
  (ls, i) => {
    const nl = "\r\n";
    const block = [
      "// stream系の汎用Error(stall監視のreject等・code無し)も切断の可能性がある。",
      "// 中断語(stall/terminated/aborted/timeout)を含むメッセージはリトライ契約へ乗せる。",
      "function isRetryableStreamError(err) {",
      "  if (!err || err.code) return false; // code持ち・code無し非Errorは中断扱いしない",
      '  const m = String(err.message ?? "");',
      '  return /stall|terminated|aborted|timeout|premature|socket hang up|other side closed/i.test(m);',
      "}",
    ];
    return block.map((s) => s.replace(/\n/g, nl));
  },
  1,
);

console.log("done. total replaced:", changed);
