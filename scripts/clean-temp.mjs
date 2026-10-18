// hive-*一時ワークスペースの掃除CLI。
// npm test / test:heavy の前処理で走り、テストが後始末し損ねた%TEMP%\hive-*を回収する。
// 失敗してもテスト実行を止めてはいけないので、常にexit 0。
import { sweepHiveTempWorkspaces } from "../src/engine/temp-sweep.js";

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const get = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? String(args[i + 1]) : def;
};

try {
  const hours = Number(get("--max-age-hours", "24"));
  const root = get("--root", "");
  const r = sweepHiveTempWorkspaces({
    ...(root ? { root } : {}),
    maxAgeMs: hours * 60 * 60 * 1000,
    dryRun: has("--dry-run"),
  });
  if (!has("--quiet") && (r.removed > 0 || r.failed > 0)) {
    const tag = has("--dry-run") ? "削除対象" : "削除";
    console.log(`[clean-temp] 古いhive-*一時dir: ${tag}${r.removed}件(失敗${r.failed}件・保護${r.kept}件)`);
  }
} catch (err) {
  // 掃除はテストの前提条件ではない。失敗はログだけ残して続行
  if (!has("--quiet")) console.log(`[clean-temp] 掃除をスキップ: ${err instanceof Error ? err.message : String(err)}`);
}
