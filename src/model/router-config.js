// モデルルーティングの設定と判定ロジック(RouterModelの判定部)。
// ファイルを分けた理由: 判定は純関数(状態を持たない)なので、RouterModelクラス
// なしで単体テストできる。依存ゼロ(node内蔵のみ)。
// 判定は追加のLLM呼出をしない(無料シグナルのみ):
//   ① 直近のプロンプトトークン実測が閾値超 → 文脈が重い
//   ② 呼出元ロールが heavyRoles(review/verify等) → 検証は品質重要
//   ③ 空応答・モデルエラーの連続 → 品質問題の兆候
//   ④ メッセージ列の概算トークンが閾値超 → 文脈が重い(実測が無い最初のターン用)
//   ⑤ ツール定義が多数(>8個) → 複雑なターン
// 既定(どれも当てはまらない)は軽量側(flash)のまま。

/** @typedef {{enabled: boolean, heavyPromptTokens: number, heavyRoles: string[], heavyQualityStrikes: number, heavyTools: number, heavyModelRef: string|null, lightModelRef: string|null}} RoutingConfig */

/** 既定のルーティング設定(enabled=false: config未設定なら現状どおり全て既定モデル)。
 * heavyModelRef/heavyModelIdは「呼び先の実体を決める」ためのヒントで、RouterModelは
 * 受け取ったstrong実体へ委譲するだけ(実体の組立はfactory側)。
 * @returns {RoutingConfig} */
export function defaultRouterConfig() {
  return {
    enabled: false,
    heavyPromptTokens: 60000,
    heavyRoles: ["review", "verify", "lead"],
    heavyQualityStrikes: 2,
    heavyTools: 8,
    heavyModelRef: "zai/glm-5.3",
    lightModelRef: "zai/glm-5.3-flash",
  };
}

/** routing設定の正規化(configの断片または未定義を受け取り、全キーを揃える)。
 * 設定の型が違う値は既定へ落とす(起動を止めない)。
 * @param {Object|undefined|null} raw models.routing の値
 * @returns {RoutingConfig} */
export function normalizeRoutingConfig(raw) {
  const d = defaultRouterConfig();
  if (!raw || typeof raw !== "object") return d;
  const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);
  const roles = Array.isArray(raw.roles) && raw.roles.length
    ? raw.roles.map((r) => String(r).toLowerCase()).filter(Boolean)
    : d.heavyRoles;
  return {
    enabled: raw.enabled === true,
    heavyPromptTokens: num(raw.heavyPromptTokens, d.heavyPromptTokens),
    heavyRoles: roles,
    heavyQualityStrikes: num(raw.heavyQualityStrikes, d.heavyQualityStrikes),
    heavyTools: num(raw.heavyTools, d.heavyTools),
    heavyModelRef: typeof raw.heavyModel === "string" && raw.heavyModel ? raw.heavyModel : d.heavyModelRef,
    lightModelRef: typeof raw.lightModel === "string" && raw.lightModel ? raw.lightModel : d.lightModelRef,
  };
}

/** メッセージ列の概算トークン数(概算: 文字数/4。日本語混在でも過小になりすぎない丸め)。
 * 正確さより一貫性が目的(追加のLLM呼出・トークナイザ依存を避ける)。
 * @param {Array<{role?: string, content?: unknown}>} [messages]
 * @returns {number} */
export function estimateTokens(messages = []) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (typeof m?.content === "string") chars += m.content.length;
    else if (m?.content != null) chars += String(JSON.stringify(m.content)).length;
  }
  return Math.ceil(chars / 4);
}

/** メッセージ列からシステムプロンプト内の実行ロールを推定する。
 * hiveのsystemペルソナは agents/<id>.md 由任で、role語(review/verify/impl/lead等)が
 * 含まれる行(ロール: / Role: 等)を探す。見つからなければnull(判定から除外)。
 * @param {Array<{role?: string, content?: unknown}>} [messages]
 * @returns {string|null} */
export function inferRole(messages = []) {
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    if (m?.role !== "system" || typeof m.content !== "string") continue;
    const head = m.content.slice(0, 2000);
    let mm = /(?:ロール|Role)\s*[:：]\s*([a-z]+)/i.exec(head);
    if (mm) return mm[1].toLowerCase();
    mm = /あなたは(?:[^。\n]{0,30}?)?(設計|実装|検証|レビュー|進行)[^。\n]*?です/.exec(head);
    if (mm) {
      return { "設計": "impl", "実装": "impl", "検証": "verify", "レビュー": "review", "進行": "lead" }[mm[1]] ?? null;
    }
  }
  return null;
}

/**
 * 1呼出のルーティング判定(純関数: 状態は引数で受ける)。
 * @param {{messages?: Array, tools?: Array|number, role?: string|null}} opts chat()実引数由来
 * @param {{lastPromptTokens: number, qualityStrikes: number}} state RouterModelが持つ直近状態
 * @param {RoutingConfig} cfg 正規化済設定
 * @returns {{heavy: boolean, reason: string}} reasonは1語(usage-trace/session-logの記録用)
 */
export function routingDecision(opts = {}, state = { lastPromptTokens: 0, qualityStrikes: 0 }, cfg = defaultRouterConfig()) {
  if (!cfg?.enabled) return { heavy: false, reason: "disabled" };
  // ② 呼出元ロール(実引数role > システムプロンプト推定)
  const role = (typeof opts.role === "string" && opts.role ? opts.role : inferRole(opts.messages)) ?? null;
  if (role && cfg.heavyRoles.includes(role)) return { heavy: true, reason: "role" };
  // ① 直近の実測プロンプトトークン(前ターンのusage報告)が閾値超
  if (state.lastPromptTokens > 0 && state.lastPromptTokens >= cfg.heavyPromptTokens) return { heavy: true, reason: "prompt" };
  // ④ いま渡るメッセージ列の概算が閾値超(実測が無い初回等)
  if (estimateTokens(opts.messages) >= cfg.heavyPromptTokens) return { heavy: true, reason: "prompt" };
  // ③ 品質問題の兆候(空応答/モデルエラーの連続)
  if (state.qualityStrikes >= cfg.heavyQualityStrikes) return { heavy: true, reason: "quality" };
  // ⑤ ツール定義が多数
  const nTools = typeof opts.tools === "number" ? opts.tools : (Array.isArray(opts.tools) ? opts.tools.length : 0);
  if (nTools > cfg.heavyTools) return { heavy: true, reason: "tools" };
  return { heavy: false, reason: "default" };
}
