// トークン/コストの台帳。provider usage(OpenRouterのusage.costは実費)を集計する。
export class UsageLedger {
  constructor() {
    this.byAgent = new Map();
  }

  add(agentId, usage) {
    const e = this.byAgent.get(agentId) ?? { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };
    e.calls += 1;
    e.promptTokens += usage?.promptTokens ?? 0;
    e.completionTokens += usage?.completionTokens ?? 0;
    e.reasoningTokens += usage?.reasoningTokens ?? 0;
    e.costUsd += usage?.costUsd ?? 0;
    this.byAgent.set(agentId, e);
    return e;
  }

  agent(agentId) {
    return this.byAgent.get(agentId) ?? { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };
  }

  totals() {
    const t = { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };
    for (const e of this.byAgent.values()) {
      t.calls += e.calls;
      t.promptTokens += e.promptTokens;
      t.completionTokens += e.completionTokens;
      t.reasoningTokens += e.reasoningTokens;
      t.costUsd += e.costUsd;
    }
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