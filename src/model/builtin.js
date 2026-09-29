// 内蔵モデルカタログ(models.dev相当の静止スナップショットの最小版)。
// 設定のmodels.providers.<id>.models[]がこれを上書き/追加する。
// costは$/1Mトークン(input/output)。プラン契約(zai coding等)では単価が
// 語れないのでcost行は載せず、usage.cost(実費)が無い場合のみ設定値を使う。

/** @type {Record<string, {name: string, baseUrl: string, api: string, models: Array<Object>}>} */
export const BUILTIN_PROVIDERS = {
  zai: {
    name: "Z.AI",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    api: "openai-completions",
    models: [
      { id: "glm-5.3-flash", name: "GLM-5.3-Flash", reasoning: true, contextWindow: 200000, maxTokens: 4000 },
      { id: "glm-5.3", name: "GLM-5.3", reasoning: true, contextWindow: 200000, maxTokens: 4000 },
    ],
  },
  anthropic: {
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    // 単価は$/1Mトークン(cacheRead/cacheWrite込み)。models.dev 2026-09時点の静止スナップショット
    models: [
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true, contextWindow: 1000000, maxTokens: 128000, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true, contextWindow: 1000000, maxTokens: 128000, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true, contextWindow: 1000000, maxTokens: 128000, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", reasoning: true, contextWindow: 200000, maxTokens: 64000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true, contextWindow: 200000, maxTokens: 64000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
    ],
  },
};
