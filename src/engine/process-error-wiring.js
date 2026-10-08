// process-guardのUI/ボード/通知配線(long-run-resilience)。
// process.error / process.burst イベント(bus)を各スレッドのBoardへ[システム]投稿し、
// 通知へのフックは opts.notify で受ける。このモジュールはboardインスタンスの列挙を
// 呼び出し側(runner/index)に委ねる(テストからダミーboardを渡せる)。
/**
 * @param {import("./board.js").Bus} bus
 * @param {{boards?: Array<{post: (from: string, text: string) => unknown, name?: string}>, notify?: (line: string) => void, getBoards?: () => Array<{post: (from: string, text: string) => unknown, name?: string}>}} opts
 *   boards/getBoards: 投稿先のBoard配列(スレッド動的生成に対応するならgetBoards)。
 * @returns {{unwire: () => void, handled: () => number}}
 */
export function wireProcessErrorToBoards(bus, opts = {}) {
  const getBoards = typeof opts.getBoards === "function" ? opts.getBoards : () => opts.boards ?? [];
  let handled = 0;
  const postAll = (text) => {
    for (const b of getBoards()) {
      try { b.post("system", text); handled++; } catch { /* 投稿先の失敗でガードを止めない */ }
    }
  };
  const offErr = bus.on("process.error", (p) => {
    postAll(`[プロセス警告] ${p.kind} を捕捉(プロセスは生存しています): ${String(p.message).slice(0, 300)}\n詳細は run-chat.err.log へ出力済み`);
  });
  const offBurst = bus.on("process.burst", (p) => {
    postAll(`[プロセス警告] ${p.kind ?? "異常頻度"}: 1時間に${p.count}件(しきい値${p.threshold}件超)。異常頻度です。ログ run-chat.err.log を確認してください`);
  });
  return { unwire() { offErr(); offBurst(); }, handled: () => handled };
}
