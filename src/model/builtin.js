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
};
