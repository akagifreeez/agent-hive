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
