// コンテキスト管理(ZCode compact/の移植)。
// ① microcompact: LLMを使わない局所圧縮。直近N件のツール結果だけ残し、
//    古いものはプレースホルダへ置換(ZCode: DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS=5、
//    MIN_TOKEN_SAVINGS=256、しきい値比0.9)。
// ② autocompact: provider usage(優先)または推定が閾値を超えたら、モデルに構造化要約させ
//    履歴を置換。連続失敗は3回でサーキットブレーク(ZCode: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES)。
export const KEEP_RECENT_TOOL_RESULTS = 5;
export const MIN_TOKEN_SAVINGS = 256;
export const MICROCOMPACT_THRESHOLD_RATIO = 0.9;
export const MICROCOMPACT_PLACEHOLDER = "[古いツール結果の内容は削除済み]";
export const AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21000;
export const AUTOCOMPACT_THRESHOLD_PERCENT = 90; // ZCode既定は100だが、hiveはpreflight再試行を持たないため安全側
export const AUTOCOMPACT_FAILURE_LIMIT = 3;

export function estimateTokens(text) {
  // 簡易推定: 日英混在を雑にカバーする(正確さより判定用の速さ)
  return Math.ceil(String(text ?? "").length / 3);
}

export function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 8, 0);
}

// ツール結果の間引き。messages配列を直接書き換える(ZCodeと同様、ローカル文脈の破壊的整理)。
// 戻り値: {changed, savingsTokens}
export function microcompact(messages, { contextWindow, thresholdRatio = MICROCOMPACT_THRESHOLD_RATIO } = {}) {
  const budget = (contextWindow ?? 200000) * thresholdRatio;
  const est = estimateMessagesTokens(messages);
  if (est < budget) return { changed: false, savingsTokens: 0, estimatedTokens: est };

  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  if (toolIdx.length <= KEEP_RECENT_TOOL_RESULTS) return { changed: false, savingsTokens: 0, estimatedTokens: est };

  const before = toolIdx.slice(0, toolIdx.length - KEEP_RECENT_TOOL_RESULTS);
  let savings = 0;
  for (const i of before) {
    const msg = messages[i];
    if (msg.content === MICROCOMPACT_PLACEHOLDER) continue;
    savings += estimateTokens(msg.content);
    messages[i] = { ...msg, content: MICROCOMPACT_PLACEHOLDER };
  }
  if (savings < MIN_TOKEN_SAVINGS) return { changed: false, savingsTokens: savings, estimatedTokens: est };
  return { changed: true, savingsTokens: savings, estimatedTokens: est - savings };
}

export function shouldAutocompact({ providerPromptTokens = 0, estimatedTokens = 0, contextWindow = 200000, maxOutputTokens = 4000, thresholdPercent = AUTOCOMPACT_THRESHOLD_PERCENT }) {
  // ZCode policy: 窓から出力予約(上限を21Kに丸める)を引いた分が入力側の正味枠
  const reserve = Math.min(maxOutputTokens, AUTOCOMPACT_OUTPUT_RESERVE_TOKENS);
  const effective = Math.max(0, contextWindow - reserve);
  const threshold = Math.floor((effective * thresholdPercent) / 100);
  // provider usage(provider_prompt_tokens)を優先し、無ければ推定
  const tokens = providerPromptTokens > 0 ? providerPromptTokens : estimatedTokens;
  return { should: tokens >= threshold, tokens, threshold, source: providerPromptTokens > 0 ? "provider_usage" : "estimate" };
}

// 要約プロンプト(ZCode compact/prompt.tsの構造をhive用に簡略化)。
// ツールを禁止し、テキストのみで要約させる。
export const COMPACT_SYSTEM_PROMPT = `あなたは会話の要約器です。ツールは一切使わず、テキストのみで応答してください。
以下の会話(マルチエージェント環境で働く1エージェントの履歴)を、作業を中断なく継続できる精度で要約してください。

必ず含める節:
1. 現在のタスク: 請求中/直近のタスクidと、その完了条件
2. 実施した作業: 作成・修正したファイル名と、その内容の要点(重要なコードの要素は関数名レベルで)
3. エラーと対処: 起きた問題と解決方法
4. ボード上の重要情報: 他エージェントからの指摘・合意事項
5. 次にやること: 未完了の残作業

出力は上記の箇条書き形式のみ。前置き・感想は不要。`;

// タスク文脈を渡すと読み取り時キュレーション(JIT memory, arXiv:2609.27334)に切り替える:
// 圧縮の瞬間には遂行中タスクが判明しているので、「何を残すか」を汎用に決めず
// 現在タスクを条件に取捨選択する。文脈が無い(=タスク外の会話)場合は従来どおり汎用要約。
export function buildCompactRequest(messages, { taskContext = null, hasMemory = false } = {}) {
  let system = taskContext
    ? `${COMPACT_SYSTEM_PROMPT}
読み取り時キュレーション: この要約は、下記の遂行中タスクが判明した状態で読まれます。
--- 遂行中のタスク ---
${taskContext}
--- ここまで ---
上記の遂行に不要な細部(無関係な探索・失敗した試行の詳細)は短くしてよい。逆に遂行に必要な要素(対象ファイル・制約・決定事項・現在の進捗)は必ず残すこと。`
    : COMPACT_SYSTEM_PROMPT;
  // 権威分離(hermes-agentの規律): 永続記憶はシステムプロンプトに常に生きたまま注入されるので、
  // 要約に複製すると二重管理になり、食い違い時にどちらが正か分からなくなる。
  if (hasMemory) {
    system += `\n権威分離: workspace/memory/ の永続記憶はシステムプロンプトに常に注入されるため、要約に複製しないこと。要約は記憶に無い、この会話固有の経過・進捗・決定に集中せよ。`;
  }
  return [
    { role: "system", content: system },
    { role: "user", content: "以下の会話履歴を要約してください:\n\n" + messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 4000) : ""}`).join("\n---\n") },
  ];
}

// 要約を先頭に置き、直近のメッセージ数件を残して履歴を組み替える
export function applyCompaction(messages, summaryText, keepRecent = 4) {
  const system = messages.find((m) => m.role === "system");
  const tail = messages.slice(-keepRecent);
  const compacted = [
    ...(system ? [system] : []),
    { role: "user", content: `[セッション要約(自動圧縮)]\n${summaryText}\n\n上記の続きとして作業を継続してください。` },
    ...tail,
  ];
  return compacted;
}
