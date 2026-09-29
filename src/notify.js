// CLI(--chat/--run)モードの通知チャネル(#11)。
// デスクトップ殻(desktop/main.jsのNative通知)と同じ3系統の出来事を、UIを開いていない
// 端末にも届ける: (1) permission.request 承認待ち (2) merge.completed マージ完了
// (3) 長時間タスク完了(claimedから一定秒以上経ってからfinishしたもの)。
// 方式: busのリスナで検知 → コンソールへ目立つ1行 + onNotifyコールバック(UIサーバーの
// /api/monitor経由の監視配信に使う)。依存ゼロ(node:processのみ)。
import { stderr } from "node:process";

/** 通知1件の形(bus由来の項目 + 種別/時刻)。/api/monitorのnotificationsとconsole出力で共用。
 * @typedef {{kind: "permission.request"|"merge.completed"|"task.finished.long", at: string, title: string, body: string, id?: number, taskId?: string, agent?: string}} NotifyItem
 */

const ANSI = { yellow: "\x1b[33m", bold: "\x1b[1m", reset: "\x1b[0m" };

/** 通知1件をコンソール( stderr )へ目立つ1行で出す。NO_COLORで色なし。
 * @param {NotifyItem} n */
export function printNotifyLine(n) {
  const c = process.env.NO_COLOR ? "" : ANSI;
  const line = `🔔 [通知] ${n.title}: ${n.body}`;
  stderr.write(`${c.bold}${c.yellow}${line}${c.reset}\n`);
}

/**
 * busへCLI通知を配線する。戻り値のunwire()で全リスナを外せる(テスト用)。
 * 二重配線防止: 同じbusに既に配線済みなら何もせずnullを返す(デスクトップ殻は
 * 独自のNative通知配線を持つため、wireCliNotifyを呼んでいても呼んでいなくても壊れない)。
 * @param {import("./engine/board.js").Bus} bus
 * @param {{longTaskSec?: number, onNotify?: (n: NotifyItem) => void, log?: (line: string) => void}} [opts]
 * @returns {{unwire: () => void}|null} 既に配線済みのときnull
 */
export function wireCliNotify(bus, opts = {}) {
  if (/** @type {any} */ (bus).__cliNotifyWired) return null;
  /** @type {any} */ (bus).__cliNotifyWired = true;
  const longTaskSec = Number(opts.longTaskSec) > 0 ? Number(opts.longTaskSec) : 600;
  const emit = (n) => {
    // コンソール出力は常に本体(通知の最低保証)。onNotifyは監視(/api/monitor)への追加配信
    printNotifyLine(n);
    if (opts.onNotify) opts.onNotify(n);
  };
  const offReq = bus.on("permission.request", (p) => {
    emit({ kind: "permission.request", at: new Date().toISOString(), id: p.id, title: `承認待ち #${p.id}`, body: String(p.command ?? "").slice(0, 120) });
  });
  const offMerge = bus.on("merge.completed", (p) => {
    const summary = String(p.summary ?? "").trim();
    emit({ kind: "merge.completed", at: new Date().toISOString(), taskId: p.taskId, agent: p.agent, title: `マージ完了 ${p.taskId ?? ""}`.trim(), body: summary || `${p.agent ?? "?"} がタスクをmainへ取り込みました` });
  });
  // 長時間タスク完了: タスクが請求された時刻を覚え、finishが閾値以上なら通知。
  // 清掃: 完了/解放/中止で抹消(メモリリーク止め)。
  /** @type {Map<string, number>} taskId → claimedAt(ms) */
  const claimedAt = new Map();
  const offClaimed = bus.on("task.claimed", (p) => { claimedAt.set(String(p.taskId ?? ""), Date.now()); });
  const forget = (p) => { claimedAt.delete(String(p.taskId ?? "")); };
  const offReleased = bus.on("task.released", forget);
  const offCancelled = bus.on("task.cancelled", forget);
  const offFinished = bus.on("task.finished", (p) => {
    const id = String(p.taskId ?? "");
    const t0 = claimedAt.get(id);
    claimedAt.delete(id);
    if (t0 == null) return;
    const tookSec = Math.round((Date.now() - t0) / 1000);
    if (tookSec < longTaskSec) return;
    const took = tookSec >= 3600 ? `${Math.floor(tookSec / 3600)}時間${Math.round((tookSec % 3600) / 60)}分` : `${Math.floor(tookSec / 60)}分${tookSec % 60}秒`;
    emit({ kind: "task.finished.long", at: new Date().toISOString(), taskId: id, agent: p.agent, title: `長時間タスク完了 ${id}`, body: `${p.agent ?? "?"} が${took}かけて完了` });
  });
  return {
    unwire: () => {
      offReq(); offMerge(); offClaimed(); offReleased(); offCancelled(); offFinished();
      claimedAt.clear();
      delete /** @type {any} */ (bus).__cliNotifyWired;
    },
  };
}
