// %TEMP%に溜まったhive-*一時ワークスペースの掃除。
// テスト各ファイルはmkdtempSync(join(tmpdir(), "hive-<scenario>-"))で作業場所を作るが、
// クラッシュや--test-force-exitで後始末が飛ぶとdirが溜まり続ける
// (2026-10-18実測: 約2か月で56.9万dir/約920万エントリ、Everythingの索引が肥大する原因)。
// 本モジュールは「maxAgeMsより最終更新が古いhive-* dirだけ」を消す。
// 実運用のworktree/workspaceはリポジトリ内(worktrees//workspace/)にあり、
// %TEMP%側はテスト・e2eの使い捨て前提なので、古いものは捨ててよい。
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** 掃除対象のプレフィックス(テストがmkdtempSyncで使う接頭辞) */
export const HIVE_TEMP_PREFIX = "hive-";

/** 既定の保護期間: これより新しいdirは実行中テストの可能性があるため触らない */
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * root直下の hive-* dir を掃除する。
 * @param {Object} [o]
 * @param {string} [o.root] 掃除対象の親dir(既定はos.tmpdir()。テストでは隔離した一時dirを渡す)
 * @param {string} [o.prefix] 対象プレフィックス(既定"hive-")
 * @param {number} [o.maxAgeMs] このmsよりmtimeが古いdirだけ消す(既定24時間)
 * @param {boolean} [o.dryRun] trueなら削除せず対象数だけ数える
 * @param {number} [o.now] 現在時刻ms(テストで時刻を固定する用)
 * @returns {{removed: number, failed: number, kept: number}} removed=削除数(dryRun時は対象数) kept=保護したhive-*数
 */
export function sweepHiveTempWorkspaces({ root = tmpdir(), prefix = HIVE_TEMP_PREFIX, maxAgeMs = DEFAULT_MAX_AGE_MS, dryRun = false, now = Date.now() } = {}) {
  let removed = 0;
  let failed = 0;
  let kept = 0;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed, failed, kept }; // rootが無い/読めない: 対象なしとして扱う
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
    const full = join(root, e.name);
    let old = false;
    try {
      old = now - statSync(full).mtimeMs > maxAgeMs;
    } catch {
      continue; // statの間に消えた等の競合は無視
    }
    if (!old) {
      kept++;
      continue;
    }
    if (dryRun) {
      removed++;
      continue;
    }
    try {
      // 読み取り専用(.gitオブジェクト等)もrecursive+forceで消える(Windows実測済み)
      rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed++;
    } catch {
      failed++; // 使用中/権限不足。無理せず次回の掃除に委ねる
    }
  }
  return { removed, failed, kept };
}
