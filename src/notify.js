// CLI(--chat/--run)モードの通知チャネル(#11)。
// デスクトップ殻(desktop/main.jsのNative通知)と同じ3系統の出来事を、UIを開いていない
// 端末にも届ける: (1) permission.request 承認待ち (2) merge.completed マージ完了
// (3) 長時間タスク完了(claimedから一定秒以上経ってからfinishしたもの)。
// 方式: busのリスナで検知 → コンソールへ目立つ1行 + onNotifyコールバック(UIサーバーの
// /api/monitor経由の監視配信に使う)。依存ゼロ(node:processのみ)。
import { stderr } from "node:process";

/** 通知1件の形(bus由来の項目 + 種別/時刻)。/api/monitorのnotificationsとconsole出力で共用。
 * @typedef {{kind: "permission.request"|"merge.completed"|"task.finished.long"|"round.stall"|"tool.fail.stall"|"budget.stop"|"idle.stall", at: string, title: string, body: string, id?: number, taskId?: string, agent?: string}} NotifyItem
 */

const ANSI = { yellow: "\x1b[33m", bold: "\x1b[1m", reset: "\x1b[0m" };

/** 通知1件をコンソール( stderr )へ目立つ1行で出す。NO_COLORで色なし。
 * @param {NotifyItem} n */
export function printNotifyLine(n) {
  const c = /** @type {{yellow: string, bold: string, reset: string}} */ (process.env.NO_COLOR ? "" : ANSI);
  const line = `🔔 [通知] ${n.title}: ${n.body}`;
  stderr.write(`${c.bold}${c.yellow}${line}${c.reset}\n`);
}

/** 定数: ラウンド静止(全スレッド無音)とみなす無音秒。既定10分。テストではstallSecで上書きする。
 * wireCliNotify の opts.stallSec で上書き可。 */
const DEFAULT_STALL_SEC = 600;

/**
 * 停止系の通知(自動継続停止/ツール失敗停止/予算停止/ラウンド静止)を配線する。
 * - 自動継続停止: chat.jsが発火する "round.stalled" イベントを購読
 * - ツール失敗停止/予算停止: loop.jsが既に発火する "agent.status" の
 *   status="tool-fail-loop"/"budget-stop" を購読(発火側の変更ゼロで経路だけ足す)
 * - ラウンド静止: 任意のbusイベント(=活動の証拠)が stallSec の間無音なら1回だけ通知。
 *   通知後に再び活動があってから再静止したときは、また1回通知する(静止1回ごとに1通知)。
 * ON/OFF: opts.enabled=false で何も配線しない(設定notify.stallのOFFに対応)。
 * @param {import("./engine/board.js").Bus} bus
 * @param {{enabled?: boolean, stallSec?: number, onNotify?: (n: NotifyItem) => void, log?: (line: string) => void}} [opts]
 * @returns {{unwire: () => void}} unwire()で全リスナとタイマーを外せる(テスト用)
 */
export function wireStallNotify(bus, opts = {}) {
  const anyBus = /** @type {any} */ (bus);
  /** @type {(n: NotifyItem) => void} */
  const deliver = (n) => {
    printNotifyLine(n);
    if (opts.onNotify) { try { opts.onNotify(n); } catch { /* 配信先の失敗で通知本体を止めない */ } }
  };
  if (opts.enabled === false) {
    // 通知OFF(設定notify.stall=false): どんな停止イベントでも送らない
    return { unwire: () => {} };
  }
  const stallSec = Number(opts.stallSec) > 0 ? Number(opts.stallSec) : DEFAULT_STALL_SEC;
  const stallMs = stallSec * 1000;
  const offs = [];
  // --- 停止3種: 1イベント=1通知(静止検出とは独立) ---
  offs.push(bus.on("round.stalled", (p) => {
    deliver({ kind: "round.stall", at: new Date().toISOString(), agent: p.agent, title: `自動継続停止(${p.reason ?? "着地ゼロ"})`, body: `${p.agent ?? "?"} が自動継続を停止(${p.rounds ?? "?"}ラウンド進行)。続きは「続けて」で再開` });
  }));
  offs.push(bus.on("agent.status", (p) => {
    if (p.status === "tool-fail-loop") {
      deliver({ kind: "tool.fail.stall", at: new Date().toISOString(), agent: p.agent, title: `ツール失敗停止(${p.agent ?? "?"})`, body: "ツール呼び出しが連続で失敗したためエージェントが終了。担当タスクは解放済み" });
    } else if (p.status === "budget-stop") {
      deliver({ kind: "budget.stop", at: new Date().toISOString(), agent: p.agent, title: `予算停止(${p.agent ?? "?"})`, body: "このランのトークン予算に達したため終了。次ラウンドで復活します" });
    }
  }));
  // --- ラウンド静止(全エージェント無音 stallSec 秒→1回だけ通知) ---
  // bus.emitの全イベントを活動の証拠とみなす(投稿・ツール・マージ等、何かが起きている間は静止しない)。
  // Bus.listenersへ監視リスナを足すのではなく、emitを直接は触らず「全イベント型の購読」を
  // Busに追加するのは設計変更になるため、ここでは既知の活動イベント群を購読して最終活動時刻を更新する。
  const ACTIVITY_EVENTS = [
    "board", "task.created", "task.claimed", "task.finished", "task.released", "task.cancelled",
    "agent.status", "agent.turn", "tool.call", "tool.result", "merge.completed", "agent.merged",
    "thread.opened", "permission.request",
  ];
  /** @type {number} 最終活動時刻(ms) */
  let lastActivity = Date.now();
  let notified = false; // 現在の静止区間で通知済みか(1回だけ)
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer = null;
  const mark = () => { lastActivity = Date.now(); notified = false; };
  for (const ev of ACTIVITY_EVENTS) offs.push(bus.on(ev, mark));
  const checkStall = () => {
    if (Date.now() - lastActivity >= stallMs) {
      if (notified) return; // 静止中の繰り返し通知はしない
      notified = true;
      const idleMin = Math.floor((Date.now() - lastActivity) / 60000);
      deliver({ kind: "idle.stall", at: new Date().toISOString(), title: "ラウンド静止(全エージェント無音)", body: `${idleMin}分間アクティビティなし。宙吊りのタスクがないかボードを確認してください` });
    }
  };
  timer = setInterval(checkStall, Math.max(250, Math.min(stallMs / 4, 5000)));
  if (typeof timer === "object" && timer && "unref" in /** @type {any} */ (timer)) {
    /** @type {any} */ (timer).unref(); // プロセスをタイマーで生かさない(常駐テストの落ち込み防止)
  }
  return {
    unwire: () => {
      for (const off of offs) { try { off(); } catch { /* 既に外れていても続行 */ } }
      if (timer) clearInterval(timer);
    },
  };
}

/**
 * busへCLI通知を配線する。戻り値のunwire()で全リスナを外せる(テスト用)。
 * 二重配線防止: 同じbusへの2回目の呼び出しはリスナを足さず、opts.onNotifyだけを
 * 既存の配線へ追加する(--chatの起動順: index.jsが先にコンソール配線 → startUiが
 * 監視配信のonNotifyを後から追加、の順序の逆でも正しく動く)。デスクトップ殻は
 * 独自のNative通知配線を持つため、wireCliNotifyを呼んでいれば併存しても壊れない。
 * @param {import("./engine/board.js").Bus} bus
 * @param {{longTaskSec?: number, onNotify?: (n: NotifyItem) => void, log?: (line: string) => void}} [opts]
 * @returns {{unwire: () => void}|null} 既に配線済みのときnull(onNotifyの追加だけは実施)
 */
export function wireCliNotify(bus, opts = {}) {
  const anyBus = /** @type {any} */ (bus);
  if (anyBus.__cliNotifyWired) {
    if (opts.onNotify) anyBus.__cliNotifyOnNotify.push(opts.onNotify);
    return null;
  }
  anyBus.__cliNotifyWired = true;
  anyBus.__cliNotifyOnNotify = [];
  if (opts.onNotify) anyBus.__cliNotifyOnNotify.push(opts.onNotify);
  const longTaskSec = Number(opts.longTaskSec) > 0 ? Number(opts.longTaskSec) : 600;
  const emit = (n) => {
    // コンソール出力は常に本体(通知の最低保証)。onNotifyは監視(/api/monitor)への追加配信
    printNotifyLine(n);
    for (const f of anyBus.__cliNotifyOnNotify) {
      try { f(n); } catch { /* 配信先の失敗で通知本体を止めない */ }
    }
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
    const tookSecF = (Date.now() - t0) / 1000;
    if (tookSecF < longTaskSec) return;
    const tookSec = Math.round(tookSecF);
    const took = tookSec >= 3600 ? `${Math.floor(tookSec / 3600)}時間${Math.round((tookSec % 3600) / 60)}分` : `${Math.floor(tookSec / 60)}分${tookSec % 60}秒`;
    emit({ kind: "task.finished.long", at: new Date().toISOString(), taskId: id, agent: p.agent, title: `長時間タスク完了 ${id}`, body: `${p.agent ?? "?"} が${took}かけて完了` });
  });
  return {
    unwire: () => {
      offReq(); offMerge(); offClaimed(); offReleased(); offCancelled(); offFinished();
      claimedAt.clear();
      anyBus.__cliNotifyOnNotify = [];
      delete anyBus.__cliNotifyWired;
    },
  };
}
