// 差分→テスト一覧の対応付け(検証テスト選定)。
// feat-verify-test-select: verifyごとのフルスイート(650件・4〜5分)を避け、
// 「差分に関連するテスト+スモーク」へ絞り込むための純関数。I/Oなし・依存ゼロ。
//
// 規則:
//   1. 差分に含まれる test/**.test.js はそのまま候補(テスト自身の変更は必ず回す)
//   2. src/ 配下のファイルはファイル名(拡張子除き)から対応テストを推測:
//      - src/engine/exec.js → test/exec*.test.js(glob展開: exec.test.js / exec-semaphore.test.js 等)
//      - 先頭一致なので executor-* のようなプレフィックス拡張も拾う(過少検出より過剰検出を優先)
//   3. 対応するテストが1つも無ければ空配列(=スモークのみの合図。呼び出し側がsmokeを足す)
//   4. 重複排除+安定ソート(辞書順)

/**
 * 差分ファイルパス配列から実行すべきテストファイルパス配列を返す(純関数)。
 * @param {string[]} diffPaths git diff --name-only main...<branch> の結果
 * @param {{allTestFiles?: string[]}} [opts] リポジトリの全テストファイル一覧(未指定時はglob想定の規則ベース判定)
 * @returns {string[]} 実行候補テスト(test/配下相対パス・重複排除・ソート済み)
 */
export function selectTestsForDiff(diffPaths, opts = null) {
  const files = Array.isArray(diffPaths) ? diffPaths.filter((f) => typeof f === "string") : [];
  const all = Array.isArray(opts?.allTestFiles) ? opts.allTestFiles : null;
  const result = new Set();

  for (const f of files) {
    // 規則1: 差分に直接含まれるテストはそのまま
    if (/^test\/.+\.test\.js$/.test(f)) {
      result.add(f);
      continue;
    }
    // 規則2: src/配下はファイル名から対応テストを推測
    const m = /^src\/.+\/([A-Za-z0-9._-]+)\.js$/.exec(f);
    if (!m) continue;
    const base = m[1];
    if (all) {
      // 実一覧があれば先頭一致で拾う(過剰検出可・過少検出は避ける)
      for (const t of all) {
        const name = t.replace(/^test\//, "");
        if (name === base + ".test.js" || name.startsWith(base)) result.add(t);
      }
    } else {
      // 実一覧が無い場合はglob想定の規則ベース(対応テスト存在を前提にglob式を返す)
      result.add(`test/${base}*.test.js`);
    }
  }
  return [...result].sort();
}
