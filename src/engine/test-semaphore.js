/**
 * テスト系コマンド(npm test / npm run test / node --test)の直列化セマフォ。
 * 重いテストを並列投入してフレーキーを誘発しないための同時実行制御。
 * 依存はsrc/engine/proc.js(実行本体)のみ。
 * @module engine/test-semaphore
 */

/** 現在実行中のラベル集合(デバッグ/テスト用) @type {Set<string>} */
const runningIds = new Set(); // デバッグ/テスト用(現在実行中のラベル。待機タイムアウト文面で使う)

/**
 * テスト実行コマンドか否か(セマフォ適用の判定)。
 * 起動セグメント(行頭または && ; | ( の直後)に始まるnpm test系・node --testにだけ
 * マッチさせ、文中の"test"語には反応しない。npmフラグ(--silent等)も語レベルで読み飛ばし、
 * npm test / npm --test / npm run test[:xx] [-- extra] をテスト意図として捕捉する。
 * @param {string} command コマンドライン
 * @returns {boolean} テスト実行の意図とみなせるならtrue
 */
export function isTestCommand(command) {
  const c = String(command ?? "");
  const start = "(^|[;&|(]\\s*)";
  return new RegExp(start + "npm\\s+(run\\s+)?test\\b").test(c)
    || new RegExp(start + "npm\\s+(--[^\\s|;&()]+\\s+)*--test(\\s|$)").test(c)
    || new RegExp(start + "npm\\s+(--[^\\s|;&()]+\\s+)*(run\\s+)?(--[^\\s|;&()]+\\s+)*(run\\s+)?test\\b").test(c)
    || new RegExp(start + "npm\\s+(run\\s+)?test\\s+[\\w:@/.\\-\\[\\]*]").test(c)
    || new RegExp(start + "node\\s+--test").test(c)
    || /\bnpm\s+(run\s+)?test\b/.test(c); // 文字列中の参照もテスト実行意図として保守的に捕捉
}

// ---- セマフォ本体(モジュール単一 = プロセス横断で共有) ----
let limit = 1; // 同時実行上限(既定1)。setTestMaxConcurrent()/configureTestSemaphore()で上書き
let running = 0;
const queue = []; // FIFO待ちキュー

class QueueTimeout extends Error {
  constructor(label) { super(`queue timeout: ${label}`); }
}


function enqueue(label) {
  let resolveFn, rejectFn;
  const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  const entry = { label, resolve: resolveFn, reject: rejectFn, p };
  queue.push(entry);
  return entry;
}

function isFree() {
  return running < limit;
}

/** 上限の空きが出たぶんだけFIFOで次を起こす */
function drain() {
  while (queue.length > 0 && running < limit) {
    const next = queue.shift();
    running += 1;
    runningIds.add(next.label);
    next.resolve();
  }
}

/** セマフォを通してコマンドを実行する(runCommandと同契約)。
 * 上限超過時はFIFOで待ち、queueTimeoutMs(既定10分)を超えたら教師文面つきで失敗返し。
 * @param {{command: string, cwd?: string, env?: Object, outputLimit?: number, timeoutMs?: number, queueTimeoutMs?: number, label?: string}} o
 * @param {(o: any) => Promise<{ok: boolean, text: string}>} run 実行本体(=runCommand)。DI可能
 * @returns {Promise<{ok: boolean, text: string}>} */
export async function runTestCommand(o, run) {
  const queueTimeoutMs = o.queueTimeoutMs ?? 600000; // 既定10分
  const cmdMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : Infinity;
  const waitLimitMs = Math.min(queueTimeoutMs, cmdMs); // 待ちもコマンドタイムアウトに従う(即時諦め)
  const label = o.label ?? String(o.command ?? "").slice(0, 80);
  if (!isFree()) {
    const entry = enqueue(label);
    const timer = setTimeout(() => {
      const i = queue.indexOf(entry);
      if (i >= 0) {
        queue.splice(i, 1);
        entry.reject(new QueueTimeout(label));
      }
    }, waitLimitMs);
    try {
      await entry.p; // drain()がこの分のスロット(running)を確保済み。ここでは加算しない(二重加算=スロットリークの原因)
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof QueueTimeout) {
        return {
          ok: false,
          text: `同時実行制限で待機タイムアウト(${Math.round(queueTimeoutMs / 1000)}秒): テスト系コマンドの同時実行が上限(${limit})を超えて待ち行列が詰まっています。` +
            `重いテストの同時投入を避けるか、hive.config.json の exec.testMaxConcurrent で上限を上げてください。\n` +
            `待っていたコマンド: ${label}\n実行中: ${[...runningIds].join(" | ") || "(なし)"}`,
        };
      }
      throw err;
    }
    clearTimeout(timer);
  } else {
    running += 1;
    runningIds.add(label);
  }
  try {
    return await run(o);
  } finally {
    running -= 1;
    runningIds.delete(label);
    drain();
  }
}

/** 上限を変更する(config.exec.testMaxConcurrentの反映用)。1未満は1にクランプ。
 * 引数省略時は既定(1)へ戻す。
 * @param {{testMaxConcurrent?: number}} [cfg] 同時実行上限(config.exec配下) */
export function configureTestSemaphore({ testMaxConcurrent } = {}) {
  limit = Number.isFinite(testMaxConcurrent) ? Math.max(1, Math.floor(testMaxConcurrent)) : 1;
  drain(); // 上限引き上げで待ちが即流れるように
  return limit;
}

/** テスト用: 状態を初期化へ戻す(待ちが居るときは待たない) */
export function resetTestSemaphore() {
  limit = 1;
  running = 0;
  queue.length = 0;
  runningIds.clear();
}

/** テスト用: 現在の状態 */
export function testSemaphoreState() {
  return { limit, running, queued: queue.length };
}

/** 同時実行上限を数値で直接設定する(exec.js互換ラッパ・テストからも使う)。
 *  @param {number} n */
export function setTestMaxConcurrent(n) {
  const v = Math.floor(Number(n));
  if (Number.isFinite(v) && v >= 1) limit = v;
  drain();
}

/** 現在の上限(テスト・診断用)。 */
export function getTestMaxConcurrent() {
  return limit;
}
