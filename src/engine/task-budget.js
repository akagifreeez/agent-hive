// 起票予算(正則化): エージェントが create_task で新しい仕事を起こすレートに上限を課す。
// 自己増殖(掃除→起票→検収→また起票でタスクだけが増える)の恒久対策。終局指示を
// 人間が毎回送る代わりに、ハーネス側で「停滞したら起票を絞る」を構造的に強制する。
// 着地(タスク完了/マージ)で上限が全回復し、着地ゼロのラウンド停止で上限が半減する
// (時間とともに逓減する編集予算=RRSIのannealed edit budgetの翻訳)。
// 対象はエージェント経由のcreate_taskのみ。finish_taskの検証タスク起票・発見器・seedなど
// ハーネス内部の起票は対象外なので、検収パイプラインがこの予算で詰まることはない。

const clampInt = (v, lo, hi, d) => {
  const x = Math.floor(Number(v));
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
};

/**
 * 時間窓あたりの起票数に上限を課す予算オブジェクトを作る。
 * @param {{max?: number, windowSec?: number}} [cfg] chat.taskCreationBudget。max=0で無効
 */
export function createTaskBudget(cfg = {}) {
  const max = clampInt(cfg.max, 0, 200, 12); // 0=無効(従来どおり無制限)
  const windowMs = clampInt(cfg.windowSec, 10, 86400, 600) * 1000;
  let cap = max; // 現在の上限(停滞で逓減・着地で回復)
  let used = 0;
  let windowStart = 0; // 0=未開始(初回tryConsumeで窓を開始)
  return {
    get max() { return max; },
    get windowSec() { return Math.round(windowMs / 1000); },
    get cap() { return cap; },
    get remaining() { return Math.max(0, cap - used); },
    /** 消費を試みる。@returns {{ok: boolean, retryInSec: number}} */
    tryConsume(now = Date.now()) {
      if (max <= 0) return { ok: true, retryInSec: 0 };
      if (!windowStart) windowStart = now;
      if (now - windowStart >= windowMs) {
        windowStart = now;
        used = 0;
      }
      if (used >= cap) {
        return { ok: false, retryInSec: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)) };
      }
      used += 1;
      return { ok: true, retryInSec: 0 };
    },
    noteLanding() { cap = max; }, // 着地(タスク完了/マージ)で予算を全回復
    noteStall() { cap = Math.floor(cap / 2); }, // 着地ゼロのラウンド停滞で逓減
  };
}
