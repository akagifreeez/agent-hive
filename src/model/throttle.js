// プロバイダ横断スロットリング(イシュー#1): 429/529の共有クールダウン。
// アダプタ単位のリトライ(openai.jsのZCode流リトライ)は「その呼び出し」だけを待たせるが、
// ここでは「同プロバイダ(baseUrl)を叩く全エージェント」へクールダウンを共有する。
// modelFactoryはエージェントごとに新しいモデル実体を作るため、状態はモジュール単位
// (プロセス全体)で持つ=同一プロセスの全モデル実体が同じ地図を参照する。
// gateは「最後に429/529を見た時刻+クールダウン」より前なら何もせず通す。過ぎていれば
// クールダウン明けまで待つ(明けた瞬間に全員が同時に通ると再び連鎖するため、待ちの先頭に
// 短いジッタを足す: computeRetryDelayと同じ方針)。既存のRetry-After対応と統合:
// note()にはアダプタがparseRetryAfterMsで抽出したRetry-Afterを渡す(妥当性判定はcomputeRetryDelayと同基準)。
import { modelSleep } from "./openai.js";

// baseUrl => { until: number(エポックms), retryAfterMs?: number }
const cooldowns = new Map();

// クールダウンの上限。openai.jsのRetry-After妥当上限(MAX_REASONABLE_RETRY_AFTER_MS=5分)と
// 同値を保つ(妙な大値で全員停止させない)。非export定数なので数値を同期して持つ。
export const THROTTLE_MAX_COOLDOWN_MS = 5 * 60_000;
// 429/529を受けなかった場合の既定クールダウン(Retry-After無し時の下限保証)
export const THROTTLE_DEFAULT_COOLDOWN_MS = 5_000;
// gate待ち先頭ジッタの上限。明けの一瞬に全員が突撃して429連鎖が再発するのを避ける
export const THROTTLE_GATE_JITTER_MS = 1_000;

/** レート制限を記録する。既存の until は単調延長のみ(短縮はしない: 複数エージェントが
 * 別々のRetry-Afterを見ても一番長い制約を全員が守る)。
 * @param {string} key プロバイダ識別(baseUrl)
 * @param {number} [retryAfterMs] Retry-Afterヘッダ由来の待ち(妥当性は呼び出し側で判断してもよいが、ここでも上限で刈る)
 * @returns {{until: number, retryAfterMs: number|null}} 適用されたクールダウン */
export function noteProviderRateLimited(key, retryAfterMs = undefined) {
  const now = Date.now();
  const valid = retryAfterMs !== undefined && retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0;
  const cd = valid ? Math.min(retryAfterMs, THROTTLE_MAX_COOLDOWN_MS) : THROTTLE_DEFAULT_COOLDOWN_MS;
  const prev = cooldowns.get(key);
  const until = Math.max(now + cd, prev?.until ?? 0);
  const entry = { until, retryAfterMs: valid ? cd : null };
  cooldowns.set(key, entry);
  return entry;
}

/** 成功時のリセット。429後に成功したら次の制限に備えて実体を捨てる(地図が太り続けない)。
 * @param {string} key プロバイダ識別(baseUrl) */
export function clearProviderRateLimit(key) {
  cooldowns.delete(key);
}

/** 共有クールダウン状態の可視化/テスト用。 */
export function providerRateLimits() {
  return new Map(cooldowns);
}

/** gate: このプロバイダの共有クールダウンが明けるまで待つ。クールダウン中でなければ即時。
 * モデルごとの個別リトライと組み合わせても二重待ちにならないよう、ここでは「最低限の待ち」
 * (クールダウン明け+ジッタ)だけを保証する。
 * @param {string} key プロバイダ識別( baseUrl )
 * @param {{jitter?: boolean}} [opts] テストでジッタを切る
 * @returns {Promise<void>} */
export async function gateProvider(key, { jitter = true } = {}) {
  const e = cooldowns.get(key);
  if (!e) return;
  const waitMs = e.until - Date.now();
  if (waitMs <= 0) {
    cooldowns.delete(key);
    return;
  }
  const jitterMs = jitter ? Math.round(THROTTLE_GATE_JITTER_MS * Math.random()) : 0;
  await modelSleep(waitMs + jitterMs);
}

/** テスト用: 共有状態を空にする(実行中の呼び出しには影響しない)。 */
export function resetProviderThrottleForTest() {
  cooldowns.clear();
}
