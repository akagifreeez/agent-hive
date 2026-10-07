// プロセス生存ガード(long-run-resilience): unhandledRejection / uncaughtException を
// 捕まえてプロセスを落とさない。背景: 2026-10-04夜、GLM APIのTLS切断で undici の
// TypeError: terminated(Fetch.onAborted)が未捕捉のままプロセス死(ラウンド全体が死んだ)。
//
// 方針(黙殺しない): 捕捉した全エラーを (1)ログファイルへスタック全文 (2)busへ
// "process.error" イベント(UIのボードへ[システム]投稿に使う) (3)可能ならnotify経路。
// 同種エラーの連発を数え、1時間に20件超えたら「異常頻度」警告を1回出す(黙殺防止)。
// 依存ゼロ(node内蔵のみ)。
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 既定のログファイル名(ワークスペース直下。*.logはgitignore済み) */
export const GUARD_LOG_FILE = "run-chat.err.log";
/** 異常頻度のしきい値(1時間にこの件数を超えたら警告) */
export const GUARD_BURST_THRESHOLD = 20;
/** 異常頻度の計測窓(ms) */
export const GUARD_BURST_WINDOW_MS = 60 * 60 * 1000;

/**
 * ガードを配線する。戻り値はテスト用のハンドル(unwire/集計リセット/窓内件数)。
 * @param {import("./board.js").Bus} [bus] 省略可。渡せば "process.error"/"process.burst" を発火
 * @param {{logFile?: string|null, notify?: (line: string) => void, threshold?: number, windowMs?: number, log?: (line: string) => void}} [opts]
 *   logFile: nullでログ書きを止める(テスト用)。notify: 通知経路(UIサーバー配線後に渡す)
 * @returns {{unwire: () => void, count: () => number, reset: () => void}}
 */
export function installProcessGuard(bus = null, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0 ? opts.threshold : GUARD_BURST_THRESHOLD;
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : GUARD_BURST_WINDOW_MS;
  const logFile = opts.logFile === undefined ? GUARD_LOG_FILE : opts.logFile;
  /** @type {number[]} 窓内の発生時刻(ms) */
  const hits = [];
  let burstWarned = false; // 窓内で1回だけ警告(連投防止)

  const writeLog = (kind, err) => {
    const ts = new Date().toISOString();
    const stack = err && typeof err.stack === "string" && err.stack.trim() ? err.stack : `${kind}: ${String(err)}`;
    const line = `[${ts}] ${kind}: ${stack}\n`;
    // まずファイル(スタック全文)。失敗しても本体の配信は止めない
    if (logFile) {
      try {
        mkdirSync(dirname(logFile), { recursive: true });
        appendFileSync(logFile, line);
      } catch { /* 読み取り専用環境等。コンソール出力は下で必ず行う */ }
    }
    // コンソールへも必ず出す(ログファイルが無い環境でも追跡可能に)
    try { (opts.log ?? console.error)(`🛡 [process-guard] ${kind}: ${String(err?.message ?? err)}`); } catch {}
    return line;
  };

  const notifyAll = (kind, err, line) => {
    // (2) bus → UIボードへ[システム]投稿(配線は受信側。ここはイベントだけ流す)
    if (bus) {
      try { bus.emit("process.error", { kind, message: String(err?.message ?? err), stack: String(err?.stack ?? ""), at: new Date().toISOString(), logLine: line }); } catch {}
    }
    // (3) 通知経路(可能なら。配信先の失敗でガード本体を止めない)
    if (opts.notify) {
      try { opts.notify(`[process-guard] ${kind}: ${String(err?.message ?? err).slice(0, 200)}`); } catch {}
    }
  };

  const onUnhandled = (err, origin) => {
    const kind = origin === "uncaughtException" ? "uncaughtException" : "unhandledRejection";
    writeLog(kind, err);
    notifyAll(kind, err, null);
    // 異常頻度の監視(黙殺防止): 窓内の件数がしきい値を超えたら1回だけ警告
    const now = Date.now();
    hits.push(now);
    while (hits.length && now - hits[0] > windowMs) hits.shift();
    if (hits.length > threshold && !burstWarned) {
      burstWarned = true;
      const msg = `[プロセス警告] ${kind}系エラーが1時間に${hits.length}件(しきい値${threshold}件超)。異常頻度です。ログ ${logFile ?? "(ファイル無し)"} を確認してください`;
      try { (opts.log ?? console.error)(`🛡 [process-guard] ${msg}`); } catch {}
      if (bus) {
        try { bus.emit("process.burst", { count: hits.length, threshold, windowMs, at: new Date().toISOString() }); } catch {}
      }
      if (opts.notify) {
        try { opts.notify(msg); } catch {}
      }
    }
  };

  process.on("unhandledRejection", onUnhandled);
  process.on("uncaughtException", (err) => onUnhandled(err, "uncaughtException"));

  return {
    unwire() {
      process.off("unhandledRejection", onUnhandled);
      process.off("uncaughtException", (err) => onUnhandled(err, "uncaughtException"));
      hits.length = 0;
    },
    count() { return hits.length; },
    reset() { hits.length = 0; burstWarned = false; },
  };
}
