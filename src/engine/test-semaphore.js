// テスト系コマンドのプロセス横断セマフォ(exec-test-semaphore)。
// 複数ワーカーの検証npm test+発見器プローブが重なるとnodeテストプロセスが百オーダー
// 同時起動しマシンが飽和する(テストフレーキーの既知教訓の主因)。テスト系コマンド
// (npm test / npm run test / node --test にマッチ)をFIFOセマフォで直列化する。
// テスト以外のコマンド・他モジュールには影響しない。依存ゼロ(純node)。

// ---- セマフォ本体(モジュール単一=プロセス横断で共有) ----
let limit = 1; // 同時実行上限(既定1)。configureTestSemaphore()で上書き可
let running = 0;
const queue = []; // FIFO待ちキュー
const runningIds = new Set(); // デバッグ/テスト用(現在実行中のラベル)

// 自縄自縛回避スイッチ(プロセス内)。テスト(exec-semaphore.test.js)は自分自身が
// runCommand("npm test ...")を発射するため、フルnpm test実行中は自分の外側のプロセスが
// すでにセマフォスロットを掴んでおり、直列化検証が即タイムアウトで落ちる
// (2026-10-08 fix-semaphore-self-block)。テストから setSemaphoreSelfBlockGuard(true) を
// 呼ぶと、このプロセス内での「待ち」だけを解消する(=新規テスト系コマンドは待たずに走る)。
// 本番経路の既定挙動は変えない(スイッチはテストのみが使う、ランタイムでは常にoff)。
let selfBlockGuard = false;

/** 自縄自縛ガードのon/off(テスト専用)。on中はこのプロセス内のテスト系コマンドが
 * セマフォ待ちをせず即実行される(スロット加算もしない=外側の状態に影響しない)。
 * @param {boolean} [on=true] */
export function setSemaphoreSelfBlockGuard(on = true) {
  selfBlockGuard = Boolean(on);
  if (selfBlockGuard) drain(); // 待ちが居たら流す(ガード有効化の瞬間に解消)
}

/** 自縄自縛ガードの現在値(テスト・診断用)。 */
export function semaphoreSelfBlockGuard() {
  return selfBlockGuard;
}

/** テスト系コマンド判定。runCommandのcommand文字列を見る。
 * 起動セグメント(行頭または && ; | ( の直後)に始まるnpm test系・node --testにだけ
 * マッチさせ、文中の"test"語には反応しない。npmフラグ(--silent等)も語レベルで読み飛ばす。 */
export function isTestCommand(command) {
  const c = String(command ?? "");
  // npm test系: 起動セグメント開始の npm[フラグ群] (run[フラグ群])? test[:接尾]? [引数...]
  //   - ^ (行頭)または && ; | ( の直後(セグメント開始)のみで始まるトークンに限定
  //   - testの直前が区切りでないパターン(npmtest / npm audit / npm run lint test)は不該当
  //   - test[:接尾](test:smoke等)と後続引数(npm test -- tests/x.js)は許容
  //   - node --test: node[フラグ群] --test(test-force-exit等の追加フラグ可)
  const seg = "(^|[;&|(]\\s*)";
  return new RegExp(seg + "npm\\s+(--[^\\s;&|()]+\\s+)*(run\\s+)?(--[^\\s;&|()]+\\s+)*(run\\s+)?test(?::[A-Za-z0-9._-]+)?([\\s]|$)").test(c)
    || new RegExp(seg + "npm\\s+(--[^\\s;&|()]+\\s+)*--test([\\s]|$)").test(c)
    || new RegExp(seg + "node\\s+(--[^\\s;&|()]+\\s+)*--test([\\s]|$)").test(c);
}

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
 * selfBlockGuardがonのプロセスでは待ち行列に入らず即実行する(テストの自縄自縛回避)。
 *   forceQueue: テスト専用。trueならselfBlockGuard中でもセマフォ待ち行列に入る(待ち挙動の単体検証用)。
 * @param {{command: string, cwd?: string, env?: Object, outputLimit?: number, timeoutMs?: number, queueTimeoutMs?: number, label?: string, forceQueue?: boolean}} o
 * @param {(o: any) => Promise<{ok: boolean, text: string}>} run 実行本体(=runCommand)。DI可能
 * @returns {Promise<{ok: boolean, text: string}>} */
export async function runTestCommand(o, run) {
  // テストの自縄自縛回避(上記selfBlockGuard参照): ガード中は素通し。
  // スロットを加算しないので外側のフル実行(自分の親プロセス)の状態を汚さない。
  if (selfBlockGuard && !o.forceQueue) {
    return run(o);
  }
  // 待ちタイムアウトは「待ち時間」で判定する(テスト本体のtimeoutMsは実行時間の予算)。
  // 明示がなければ timeoutMs を待ち上限に転用する(呼び出し側のタイムアウト意図を尊重:
  // timeoutMs=500で待たせたら500ms待ちで諦める、が直感どおりの挙動)。
  const queueTimeoutMs = o.queueTimeoutMs === null ? 600000 : (o.queueTimeoutMs ?? (Number.isFinite(o.timeoutMs) ? o.timeoutMs : 600000));
  const label = o.label ?? String(o.command ?? "").slice(0, 80);
  if (!isFree()) {
    const entry = enqueue(label);
    const timer = setTimeout(() => {
      const i = queue.indexOf(entry);
      if (i >= 0) {
        queue.splice(i, 1);
        entry.reject(new QueueTimeout(label));
      }
    }, queueTimeoutMs);
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
