// モデル選択ポリシー(イシュー#12の仕組み化)。リーダーがcreate_task時にモデルを選ぶ
// 基準の明文化(システムプロンプトへ乗る文面)と、検証差し戻しの追跡・エスカレーション。
//
// 差し戻しの定義: 承認フロー(approvals.require)で検証者がマージした結果競合/失敗、
// または検証者が明示的にverifyタスクを「差し戻し」扱いで完了した(返却)ケース。
// 実装はverify完了経路(tools.js)から notifyRejected() を呼ぶ形でだけ記録する。
// 自動再起票はしない(リーダーがcreate_taskし直す)。しきい値到達でリーダーへ推奨投稿。
//
// 既定モデルは zai/glm-5.3-flash 維持・コスト無増原則。エスカレーション先の既定は
// コード内定数で、hive.config.json の chat.modelPolicy で上書き可能。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/** 既定のしきい値(検証差し戻し何回でエスカレーション推奨に出すか) */
export const DEFAULT_ESCALATION_THRESHOLD = 2;
/** 既定のエスカレーション先モデルref(null=リーダーが接続済みから選ぶ) */
export const DEFAULT_ESCALATE_MODEL = null;
/** クォータ保護: エスカレーション推奨に含める緩い制限の文面 */
export const QUOTA_NOTE = "スレッド内で同時1タスクまで(既存タスクの消化後に再起票)。";

/**
 * ポリシーの設定を取り出す(config.chat.modelPolicy、未設定は既定値)
 * @param {{chat?: {modelPolicy?: {escalationThreshold?: number, escalateModel?: string|null}}} | null} config
 * @returns {{escalationThreshold: number, escalateModel: string|null}}
 */
export function readModelPolicy(config) {
  const p = config?.chat?.modelPolicy ?? {};
  const th = Number(p.escalationThreshold);
  return {
    escalationThreshold: Number.isFinite(th) && th >= 1 ? Math.floor(th) : DEFAULT_ESCALATION_THRESHOLD,
    escalateModel: typeof p.escalateModel === "string" && p.escalateModel.trim() ? p.escalateModel.trim() : DEFAULT_ESCALATE_MODEL,
  };
}

/** 差し戻し記録の保存先(workspace起点。state/配下は触らない) */
function counterPath(workspace) {
  return join(workspace, "memory", ".model-policy.json");
}

function readCounters(workspace) {
  try {
    const raw = JSON.parse(readFileSync(counterPath(workspace), "utf8"));
    return raw && typeof raw === "object" && raw.rejects && typeof raw.rejects === "object" ? raw : { rejects: {} };
  } catch {
    return { rejects: {} };
  }
}

function writeCounters(workspace, data) {
  const p = counterPath(workspace);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(data));
  } catch {
    // 記録できない環境ではエスカレーションが出ないだけ(本体の動きは止めない)
  }
}

/**
 * タスクの検証差し戻しを1件記録し、現在の回数を返す
 * @param {string} workspace mainワークスペース
 * @param {string} taskId
 * @returns {number} 記録後の差し戻し回数
 */
export function recordRejection(workspace, taskId) {
  const id = String(taskId ?? "").trim();
  if (!id) return 0;
  const data = readCounters(workspace);
  data.rejects[id] = (data.rejects[id] ?? 0) + 1;
  writeCounters(workspace, data);
  return data.rejects[id];
}

/**
 * タスクの差し戻し回数を返す(未記録は0)
 * @param {string} workspace
 * @param {string} taskId
 * @returns {number}
 */
export function rejectionCount(workspace, taskId) {
  const data = readCounters(workspace);
  return data.rejects[String(taskId ?? "").trim()] ?? 0;
}

/**
 * しきい値に達したときのエスカレーション推奨文面を組み立てる(達していなければnull)。
 * 自動再起票はしない(リーダーがcreate_taskし直す)。クォータ保護の文面を含める。
 * @param {string} taskId
 * @param {number} count 現在の差し戻し回数
 * @param {{escalationThreshold: number, escalateModel: string|null}} policy
 * @returns {string|null}
 */
export function escalationNotice(taskId, count, policy) {
  if (count < policy.escalationThreshold) return null;
  const modelNote = policy.escalateModel
    ? `エスカレーション先(設定値): ${policy.escalateModel}`
    : "エスカレーション先: 接続済みの強いモデル(既定はFlash。下記基準で検討)";
  return [
    `[モデル選択エスカレーション推奨] タスク ${taskId} が検証差し戻し ${count} 回に達しました(しきい値 ${policy.escalationThreshold})。`,
    `強いモデルでの再起票(create_taskし直し+model指定)を検討してください。${modelNote}。`,
    `理由: 同一タスクの検証差し戻しが繰り返すとき、既定モデルでは成果の質が受け入れ基準に届いていない可能性が高い。`,
    `クォータ保護: ${QUOTA_NOTE}`,
  ].join("\n");
}

/**
 * 差し戻しを記録し、しきい値到達時はリーダー宛ての推奨文面を返す。
 * 投稿は呼び出し側(board.post / host.say)で行う(モジュールからボードに依存しない)。
 * @param {string} workspace
 * @param {string} taskId
 * @param {{chat?: {modelPolicy?: {escalationThreshold?: number, escalateModel?: string|null}}} | null} config
 * @returns {{count: number, notice: string|null}}
 */
export function noteRejection(workspace, taskId, config = null) {
  const count = recordRejection(workspace, taskId);
  return { count, notice: escalationNotice(taskId, count, readModelPolicy(config)) };
}

/** リーダー向けのモデル選択基準(COMMON_RULESへ差し込む文面。システムプロンプトに乗る) */
export const MODEL_SELECTION_POLICY = `
## モデル選択ポリシー(リーダーがcreate_task時に適用)
- 既定は接続済みの既定モデル(Flash)のまま。コスト無増が原則で、指定なきタスクは既定モデルで動く。
- 次の種類のタスクは強いモデル(接続済みの上位モデル。例: zai/glm-5.3)の使用を検討する: 検証(review・verify)/設計/競合解消/難しいデバッグ。
- 使うと決めたら create_task の model に ref(provider/model)を付け、タスク本文の冒頭にその理由を1行書く(#12機構。指定なしならmodel行は付けない)。
- 同一タスクが検証差し戻しに繰り返すとき(しきい値は chat.modelPolicy.escalationThreshold、既定2回)は、エンジンからエスカレーション推奨が投稿される。推奨に従って強いモデルで再起票するか、根拠を添えて継続判断する。
- エスカレーション起票の際は ${QUOTA_NOTE}
`;
