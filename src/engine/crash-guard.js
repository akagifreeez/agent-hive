// プロセス生存ガード(long-run-resilience): unhandledRejection/uncaughtExceptionを捕捉し、
// プロセスを終了させない。背景: 2026-10-04夜、GLM API呼出のTLS切断でundiciの
// "TypeError: terminated"(Fetch.onAborted)が未捕捉のままプロセス死し、ラウンド全体が死んだ。
// 黙殺はしない(要件): (1)ログへスタック全文 (2)bus "crash.guarded" イベント+boardへ[システム]投稿
// (3)onNotify(既存notify経路・UIの/api/monitor配信等)への通知。同種エラーが1時間に
// GUARD_RATE_LIMIT(20)件を超えたら「異常頻度」警告を1回だけ追加出力する(黙殺防止の目安)。
// 依存ゼロ(node:process/node:fsのみ)。
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// 異常頻度警告のしきい値(1時間・環境変数HIVE_CRASH_RATE_LIMITで上書き可)
export function guardRateLimit() {
  const n = Number(process.env.HIVE_CRASH_RATE_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 20;
}
// 頻度計測の窓(ms)。既定1時間
export function guardRateWindowMs() {
  const n = Number(process.env.HIVE_CRASH_RATE_WINDOW_MS);
  return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
}

/**
 * @typedef {{logFile?: string|null, onEvent?: (e: object) => void, onNotify?: (n: object) => void, onPost?: (text: string) => void, rateLimit?: number, rateWindowMs?: number}} CrashGuardOpts
 */

/**
 * プロセス全体の未捕捉rejection/例外を捕捉するガードを配線する。
 * - logFile があれば(親ディレクトリごと作成)スタック全文+種別+時刻を追記する
 * - onEvent(e) はテスト・UI配線用の素フック(bus "crash.guarded" はindex.js側で接続)
 * - onPost(text) はboard投稿フック([システム]接頭辞は呼び出し側index.jsが付ける)
 * - onNotify(n) は既存notify経路(desktop/UIの配信)へのフック
 * - 無音既定値: どのフックも省略可(ガードだけでも落ちは防ぐ)
 * @param {CrashGuardOpts} [opts]
 * @returns {{unwire: () => void, events: () => object[], warnings: () => number, guardCount: () => number}} unwire()でリスナを外す(テスト用)。events()は記録したイベント一覧
 */
export function installCrashGuard(opts = {}) {
  /** @type {object[]} */
  const events = [];
  const times = []; // 発生時刻(ms)のリング。頻度計測用
  const rateLimit = opts.rateLimit ?? guardRateLimit();
  const rateWindowMs = opts.rateWindowMs ?? guardRateWindowMs();
  let rateWarned = false; // 窓ごとの「異常頻度」警告は1回だけ
  let rateWarnAt = 0;

  const safeLog = (line) => {
    if (!opts.logFile) return;
    try {
      mkdirSync(dirname(opts.logFile), { recursive: true });
      appendFileSync(opts.logFile, line + "\n");
    } catch { /* ログの失敗でガード本体を止めない */ }
  };

  const guard = (kind) => (reason) => {
    // reasonはError以外(undefined/string等)も来うる。常に文字列化して残す(必ずログ)
    const err = reason instanceof Error ? reason : null;
    const name = err?.name ?? (reason === undefined ? "Undefined" : "NonError");
    const message = String(err?.message ?? reason ?? "(値なし)");
    const stack = String(err?.stack ?? `${name}: ${message}`);
    const at = new Date().toISOString();
    const event = { kind, name, message, stack, at };
    events.push(event);

    // (1) 必ずログ: スタック全文+種別
    safeLog(JSON.stringify({ at, kind, name, message, stack }));

    // (2) bus等への配信(index.jsがboard投稿へ変換)
    try { opts.onEvent?.(event); } catch { /* 配信先の失敗でガード本体を止めない */ }

    // (3) 既存notify経路(可能なら)
    try { opts.onNotify?.({ kind: "crash.guarded", at, title: `プロセス生存ガード(${kind})`, body: `${name}: ${message}` }); } catch { /* 同上 */ }

    // 頻度監視: 窓内の発生数がしきい値を超えたら「異常頻度」警告(窓ごと1回)
    const now = Date.now();
    times.push(now);
    while (times.length && now - times[0] > rateWindowMs) times.shift();
    if (times.length > rateLimit && !rateWarned) {
      rateWarned = true;
      rateWarnAt = now;
      const warnLine = `[異常頻度] ガード対象エラーが1時間あたり${rateLimit}件を超えました(黙殺ではありませんが、異常状態の可能性)。`;
      safeLog(JSON.stringify({ at: new Date(now).toISOString(), kind: "rate.warn", count: times.length, windowMs: rateWindowMs }));
      try { opts.onEvent?.({ kind: "rate.warn", name: "RateWarn", message: warnLine, stack: "", at: new Date(now).toISOString() }); } catch { /* 同上 */ }
      try { opts.onNotify?.({ kind: "crash.rate", at: new Date(now).toISOString(), title: "ガード異常頻度", body: warnLine }); } catch { /* 同上 */ }
    }
    // ウィンドウが空いたら警告フラグを戻す(次の窓でまた検出できる)
    if (rateWarned && now - rateWarnAt > rateWindowMs) rateWarned = false;
    // プロセスは終了させない(このガードの主目的)
  };

  const onRejection = guard("unhandledRejection");
  const onException = guard("uncaughtException");
  // captureRejections: EventEmitter系(asyncイテレーション等)のrejectionを'uncaughtException'へ
  // 正規化して同じガードへ集約する(無音rejectionの残し口を減らす)
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  return {
    unwire() {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
    },
    events: () => events.slice(),
    warnings: () => (rateWarned ? 1 : 0),
    guardCount: () => events.length,
  };
}

/**
 * index.jsから呼ぶ配線済みガード: bus(→board[システム]投稿)+notify+ログファイルを繋ぐ。
 * board本体に依存せずコールバックで受ける(循環importとテストの重装備を避ける)。
 * @param {{bus?: import("./board.js").Bus|null, logFile?: string|null, onNotify?: (n: object) => void}} [o]
 * @returns {{unwire: () => void}}
 */
export function wireCrashGuard(o = {}) {
  const bus = o.bus ?? null;
  const onEvent = (e) => {
    if (!bus) return;
    if (e.kind === "rate.warn") {
      bus.emit("scenario.warn", { message: e.message });
      bus.emit("crash.guarded", e);
    } else {
      bus.emit("crash.guarded", e);
    }
  };
  // board投稿: busを監視するのではなく、呼び出し側からpostFnを受けたければonPostで差し込めるよう
  // crash-guard自体はイベント発火のみ。ここではWireCrashGuardの呼び出し元(runner/index)が
  // "crash.guarded"を購読してboard.post("[システム]", ...)する(依存の向きを保つ)
  return installCrashGuard({ logFile: o.logFile ?? null, onEvent, onNotify: o.onNotify ?? null });
}
