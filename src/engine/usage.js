// トークン/コストの台帳。provider usage(OpenRouterのusage.costは実費)を集計する。
// add()にopts.ms(呼出の実経過ミリ秒)を渡すと生成速度(tok/s)の累積も取り、
// エントリにavgTokPerSec(完了トークン÷累積秒)を維持する。msを渡さない呼出(旧呼出・
// 時間計測の無い統合先)は速度集計の分子・分母のどちらにも入らない(avgTokPerSecはnullのまま)。
export class UsageLedger {
  constructor() {
    this.byAgent = new Map();
    // 速度集計の実データ(agentId -> { ms, completion })。avgTokPerSecの算出元で、
    // 未計測呼出のトークンを混ぜないためエントリのcompletionTokensとは別に持つ
    this.tps = new Map();
  }

  add(agentId, usage, opts = {}) {
    const e = this.byAgent.get(agentId) ?? { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0, msSum: 0, avgTokPerSec: null };
    e.calls += 1;
    e.promptTokens += usage?.promptTokens ?? 0;
    e.completionTokens += usage?.completionTokens ?? 0;
    e.reasoningTokens += usage?.reasoningTokens ?? 0;
    e.costUsd += usage?.costUsd ?? 0;
    const ms = Number(opts.ms ?? 0);
    if (ms > 0) {
      e.msSum += ms;
      const a = this.tps.get(agentId) ?? { ms: 0, completion: 0 };
      a.ms += ms;
      a.completion += usage?.completionTokens ?? 0;
      this.tps.set(agentId, a);
      e.avgTokPerSec = a.completion / (a.ms / 1000);
    }
    this.byAgent.set(agentId, e);
    return e;
  }

  agent(agentId) {
    return this.byAgent.get(agentId) ?? { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0, msSum: 0, avgTokPerSec: null };
  }

  totals() {
    const t = { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0, msSum: 0, avgTokPerSec: null };
    let tpsMs = 0, tpsCompletion = 0;
    for (const e of this.byAgent.values()) {
      t.calls += e.calls;
      t.promptTokens += e.promptTokens;
      t.completionTokens += e.completionTokens;
      t.reasoningTokens += e.reasoningTokens;
      t.costUsd += e.costUsd;
      t.msSum += e.msSum ?? 0;
    }
    for (const a of this.tps.values()) {
      tpsMs += a.ms;
      tpsCompletion += a.completion;
    }
    if (tpsMs > 0) t.avgTokPerSec = tpsCompletion / (tpsMs / 1000);
    return t;
  }

  snapshot() {
    return Object.fromEntries(this.byAgent);
  }
}

// state/usage.json(usage.round/usage.summaryの運用履歴)から
// 日別・スレッド別・日別xスレッドの集計ビューを作る(GitHubイシュー#6)。
// 壊れた行・旧形式(thread無し)も無視せず集計に含める(thread無しは__main__扱い)。
// @param {Array<{at?: string, thread?: string, agent?: string, totals?: {calls?: number, promptTokens?: number, completionTokens?: number, reasoningTokens?: number, costUsd?: number}}|null>} history
// @param {{days?: number}} [opts] days: 集計対象日数(既定14)。0で全期間
// @returns {{byDate: Array<{date: string, calls: number, promptTokens: number, completionTokens: number, reasoningTokens: number, costUsd: number}>, byThread: Array<{thread: string, calls: number, promptTokens: number, completionTokens: number, reasoningTokens: number, costUsd: number, agentIds: string[]}>, matrix: Array<{date: string, thread: string, calls: number, costUsd: number}>}}
export function aggregateUsage(history, opts = {}) {
  const empty = { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };
  const byDate = new Map();
  const byThread = new Map();
  const matrix = new Map();
  const days = Number(opts.days ?? 14);
  const sinceMs = Number.isFinite(days) && days > 0 ? Date.now() - days * 86400000 : null;
  const list = Array.isArray(history) ? history : [];
  for (const h of list) {
    if (!h || typeof h !== "object") continue;
    const d = new Date(h.at ?? "");
    if (isNaN(d.getTime())) continue;
    if (sinceMs != null && d.getTime() < sinceMs) continue; // 期間外は除外
    // usage.summary(シナリオ全体の合計サマリ)はusage.roundの積み上げと二重計上になるため集計対象外
    if (typeof h.agent !== "string" || !h.agent) continue;
    const date = localDateKey(d); // ローカル日付基準(ユーザー視点の「日別」。深夜帯の前日バケット落ちを防ぐ)
    const thread = resolveThread(h);
    const t = h.totals ?? {};
    const calls = Number(t.calls ?? 0);
    const pt = Number(t.promptTokens ?? 0);
    const ct = Number(t.completionTokens ?? 0);
    const rt = Number(t.reasoningTokens ?? 0);
    const usd = Number(t.costUsd ?? 0);
    if (!(calls || pt || ct || rt || usd)) continue; // 空レコードは集計しない
    const dRow = byDate.get(date) ?? { date, ...empty };
    dRow.calls += calls; dRow.promptTokens += pt; dRow.completionTokens += ct; dRow.reasoningTokens += rt; dRow.costUsd += usd;
    byDate.set(date, dRow);
    const tRow = byThread.get(thread) ?? { thread, ...empty, agentIds: [] };
    tRow.calls += calls; tRow.promptTokens += pt; tRow.completionTokens += ct; tRow.reasoningTokens += rt; tRow.costUsd += usd;
    if (typeof h.agent === "string" && h.agent && !tRow.agentIds.includes(h.agent)) tRow.agentIds.push(h.agent);
    byThread.set(thread, tRow);
    const mKey = date + "|" + thread;
    const mRow = matrix.get(mKey) ?? { date, thread, ...empty };
    mRow.calls += calls; mRow.promptTokens += pt; mRow.completionTokens += ct; mRow.reasoningTokens += rt; mRow.costUsd += usd;
    matrix.set(mKey, mRow);
  }
  const dateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  return {
    byDate: [...byDate.values()].sort(dateDesc),
    byThread: [...byThread.values()].sort((a, b) => b.costUsd - a.costUsd),
    matrix: [...matrix.values()].sort((a, b) => dateDesc(a, b) || (a.thread < b.thread ? -1 : 1)),
  };
}


// レコードのスレッド名を確定する。threadフィールドが無い旧データはagent名からの
// 推測でしのぐ(usage.roundは<thread>-<worker>形式のidで走る: issue-x-alpha 等)。
// 推測できない(接尾辞が無い/lead等)場合は__main__扱い。
const WORKER_SUFFIX_SRC = "-(?:alpha|beta|gamma|delta|impl-\\d+|review|worker-?\\d+)$";
/** @type {RegExp} */
const WORKER_SUFFIX_RE = new RegExp(WORKER_SUFFIX_SRC);

function resolveThread(h) {
  if (typeof h.thread === "string" && h.thread) return h.thread;
  const agent = typeof h.agent === "string" ? h.agent : "";
  if (agent && WORKER_SUFFIX_RE.test(agent)) return agent.replace(WORKER_SUFFIX_RE, "");
  return "__main__";
}

// ローカルタイムゾーンの年月日(YYYY-MM-DD)を返す。集計の「日」はユーザーの地元日付で括る。
export function localDateKey(d) {
  const dd = d instanceof Date ? d : new Date(d);
  const y = dd.getFullYear();
  const m = String(dd.getMonth() + 1).padStart(2, "0");
  const day = String(dd.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

// ===== キャッシュヒット率の集計(cache-hit-rate)=====
// usage-trace.jsonl(1行1ターン。cachedはプロバイダ未報告時null)から、
// ヒット率 = cached ÷ prompt を日別・エージェント別(と日別xエージェント)に集計する純関数。
// UI(/api/usage-trace)・CLI(hive session)・session-reportの3経路から共利用する。
// ルール:
// - cachedがnull(未報告)の行は分母・分子とも除外(未報告と0の区別を保つ。0は有効=命中率0)
// - promptが数値で0より大きくない行も除外(0除算防止)
// - tsが読めない行は日別に分類できないため除外
// - ヒット率は「行ごとの比率の平均」でなく「合算値(cached合計÷prompt合計)」(母数の大きい行が正しく効く)

/** ヒット率の低さ警告の閾値(この値未満をlow扱い。定数化してUI/CLIで共利用) */
export const CACHE_HIT_LOW_THRESHOLD = 0.5;

/** 空の集計結果(形状の契約)。有効行ゼロではヒット率はnull */
export function emptyCacheHits() {
  return { byDate: [], byAgent: [], matrix: [], total: { calls: 0, prompt: 0, cached: 0, hitRatio: null } };
}

/** 1行(1ターン)から集計に使える数値を取り出す。無効行はnull */
function cacheRow(r) {
  if (!r || typeof r !== "object") return null;
  const d = new Date(typeof r.ts === "string" ? r.ts : "");
  if (isNaN(d.getTime())) return null;
  const prompt = Number(r.prompt);
  const cached = Number(r.cached);
  if (!Number.isFinite(prompt) || prompt <= 0) return null;
  if (!Number.isFinite(cached) || r.cached === null) return null; // 未報告(null)は除外
  return { date: localDateKey(d), agent: String(r.agent ?? "?"), prompt, cached };
}

/**
 * usage-traceの行配列からキャッシュヒット率を集計する。
 * @param {Array<{ts?: string, agent?: string, prompt?: number, cached?: number|null}|null>} history
 * @returns {{byDate: Array<{date: string, calls: number, prompt: number, cached: number, hitRatio: number|null, low: boolean}>, byAgent: Array<{agent: string, calls: number, prompt: number, cached: number, hitRatio: number|null, low: boolean}>, matrix: Array<{date: string, agent: string, calls: number, prompt: number, cached: number, hitRatio: number|null, low: boolean}>, total: {calls: number, prompt: number, cached: number, hitRatio: number|null}}}
 */
export function aggregateCacheHits(history) {
  const list = Array.isArray(history) ? history : [];
  const byDate = new Map();
  const byAgent = new Map();
  const matrix = new Map();
  let calls = 0, promptSum = 0, cachedSum = 0;
  for (const raw of list) {
    const r = cacheRow(raw);
    if (!r) continue;
    calls += 1; promptSum += r.prompt; cachedSum += r.cached;
    const targets = [byDate, byAgent, matrix];
    const keys = [r.date, r.agent, r.date + "|" + r.agent];
    for (let i = 0; i < targets.length; i++) {
      const map = targets[i];
      const key = keys[i];
      const row = map.get(key) ?? { calls: 0, prompt: 0, cached: 0 };
      row.calls += 1; row.prompt += r.prompt; row.cached += r.cached;
      map.set(key, row);
    }
  }
  const ratio = (p, c) => (p > 0 ? Math.round((c / p) * 1000) / 1000 : null);
  const decorate = (extra, row) => {
    const hitRatio = ratio(row.prompt, row.cached);
    return { ...extra, ...row, hitRatio, low: hitRatio != null && hitRatio < CACHE_HIT_LOW_THRESHOLD };
  };
  const dateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  return {
    byDate: [...byDate.entries()].map(([date, row]) => decorate({ date }, row)).sort(dateDesc),
    byAgent: [...byAgent.entries()].map(([agent, row]) => decorate({ agent }, row)).sort((a, b) => b.prompt - a.prompt),
    matrix: [...matrix.entries()].map(([k, row]) => decorate({ date: k.split("|")[0], agent: k.split("|")[1] }, row)).sort((a, b) => dateDesc(a, b) || (a.agent < b.agent ? -1 : 1)),
    total: { calls, prompt: promptSum, cached: cachedSum, hitRatio: ratio(promptSum, cachedSum) },
  };
}