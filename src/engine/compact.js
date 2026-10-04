// コンテキスト管理(ZCode compact/の移植)。
// ① microcompact: LLMを使わない局所圧縮。直近N件のツール結果だけ残し、
//    古いものはプレースホルダへ置換(ZCode: DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS=5、
//    MIN_TOKEN_SAVINGS=256、しきい値比0.9)。
// ② autocompact: provider usage(優先)または推定が閾値を超えたら、モデルに構造化要約させ
//    履歴を置換。連続失敗は3回でサーキットブレーク(ZCode: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES)。
export const KEEP_RECENT_TOOL_RESULTS = 5;
export const MIN_TOKEN_SAVINGS = 256;
export const MICROCOMPACT_THRESHOLD_RATIO = 0.9;
export const MICROCOMPACT_PLACEHOLDER = "[Older tool result content removed]";
export const AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21000;
export const AUTOCOMPACT_THRESHOLD_PERCENT = 90; // ZCode既定は100だが、hiveはpreflight再試行を持たないため安全側
export const AUTOCOMPACT_FAILURE_LIMIT = 3;

export function estimateTokens(text) {
  // 簡易推定: 日英混在を雑にカバーする(正確さより判定用の速さ)
  return Math.ceil(String(text ?? "").length / 3);
}

export function estimateMessagesTokens(messages) {
  // 画像(マルチモーダルcontent配列)は1枚を概算1,000トークンとして数える
  const count = (c) => {
    if (Array.isArray(c)) {
      return c.reduce((s, p) => s + (p.type === "image_url" ? 1000 : estimateTokens(p.text)), 0);
    }
    return estimateTokens(c);
  };
  return messages.reduce((sum, m) => sum + count(m.content) + 8, 0);
}

// ツール結果の間引き。messages配列を直接書き換える(ZCodeと同様、ローカル文脈の破壊的整理)。
// 戻り値: {changed, savingsTokens}
/**
 * 古いツール結果をプレースホルダへ置き換える(LLM不要の軽量圧縮)。
 * @param {Array<{role: string, content: any}>} messages
 * @param {{thresholdRatio?: number, contextWindow?: number}} opts
 */
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
// ツールを禁止し、テキストのみで要約させる。プロンプト自体は英語(要約精度・トークン効率)。
// 要約の出力言語は日本語を明示指定(エージェントの作業言語が日本語のため)。
export const COMPACT_SYSTEM_PROMPT = `You are a conversation summarizer. Do not use any tools; respond with text only.
Summarize the following conversation (the history of one agent working in a multi-agent environment) with enough precision that the work can continue without interruption.

You MUST include these sections:
1. Current task: the claimed/most recent task id and its completion criteria
2. Work done: file names created or modified, and the essence of each change (important code elements at function-name level)
3. Errors and fixes: problems encountered and how they were resolved
4. Key information from the board: feedback, decisions, and agreements from other agents
5. Next steps: remaining work not yet completed

Output only these bullet sections. No preamble, no commentary.
Write the summary in Japanese.`;

// タスク文脈を渡すと読み取り時キュレーション(JIT memory, arXiv:2609.27334)に切り替える:
// 圧縮の瞬間には遂行中タスクが判明しているので、「何を残すか」を汎用に決めず
// 現在タスクを条件に取捨選択する。文脈が無い(=タスク外の会話)場合は従来どおり汎用要約。
export function buildCompactRequest(messages, { taskContext = null, hasMemory = false } = {}) {
  let system = taskContext
    ? `${COMPACT_SYSTEM_PROMPT}
Read-time curation: this summary will be read while the following task is in progress.
--- Current task ---
${taskContext}
--- End of task ---
You may shorten details irrelevant to this task (unrelated exploration, details of failed attempts). Conversely, you MUST keep anything the task depends on (target files, constraints, decisions, current progress).`
    : COMPACT_SYSTEM_PROMPT;
  // 権威分離(hermes-agentの規律): 永続記憶はシステムプロンプトに常に生きたまま注入されるので、
  // 要約に複製すると二重管理になり、食い違い時にどちらが正か分からなくなる。
  if (hasMemory) {
    system += `\nAuthority separation: the persistent memory in workspace/memory/ is always injected via the system prompt. Do NOT duplicate it into the summary. Focus the summary on conversation-specific progress, decisions, and events that are not already in memory.`;
  }
  return [
    { role: "system", content: system },
    { role: "user", content: "Summarize the following conversation history:\n\n" + messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 4000) : ""}`).join("\n---\n") },
  ];
}

// 要約を先頭に置き、直近のメッセージ数件を残して履歴を組み替える
export function applyCompaction(messages, summaryText, keepRecent = 4) {
  const system = messages.find((m) => m.role === "system");
  const tail = messages.slice(-keepRecent);
  const compacted = [
    ...(system ? [system] : []),
    { role: "user", content: `[Session summary (auto-compacted)]\n${summaryText}\n\nContinue the work from the state described above.` },
    ...tail,
  ];
  return compacted;
}

// ===== 会話メモリ(mem-<id>.json)の刈り取り(イシュー#20 提案2) =====
// ラウンド間で永続化されるmemories配列が無制限に育つとstate/mem-*.jsonが肥大し、
// 復元・保存コストも増える。LLMを呼ばない軽量ポリシーで刈り取りする:
//  - 先頭のsystemメッセージは常に保護(人格・ルールの源なので削らない)
//  - 直近keepRecent件は保護(作業の続きが分かる最小限)
//  - それより古い分は「要点ヘッダ1件」へ置換する(全削除ではなく輪郭を残す)
//    置換ヘッダには元メッセージ数・役割内訳・日時を入れ、記憶が飛んだことが
//    モデル自身から見て分かるようにする(黙って欠落させない)。
// 戻り値: {messages(新配列), changed, removed}
export const MEM_KEEP_RECENT = 12;
export const MEM_HEADER = "[記憶の刈り取り] この会話の古い部分は省略されています。";

/**
 * @param {Array<{role: string, content: any}>} messages
 * @param {{keepRecent?: number, maxMessages?: number, maxBytes?: number}} opts
 *   maxMessages: 総件数の上限(この件数を超えたら刈り取り)
 *   maxBytes: 本文の合計バイト数上限(JSON.stringify長で近似。超えたら刈り取り)
 */
export function pruneMemories(messages, { keepRecent = MEM_KEEP_RECENT, maxMessages = 200, maxBytes = 512 * 1024 } = {}) {
  const arr = Array.isArray(messages) ? messages : [];
  // 0/nullは無効化(config化の契約): 上限を設けない
  const disabled = (v) => v == null || v === 0;
  if (disabled(maxMessages) && disabled(maxBytes)) {
    return { messages: [...arr], changed: false, removed: 0 };
  }
  // system(先頭)は常に残す。保護枠は system + keepRecent
  const head = arr.length && arr[0].role === "system" ? [arr[0]] : [];
  const body = head.length ? arr.slice(1) : arr;
  const bytes = (m) => Buffer.byteLength(typeof m.content === "string" ? m.content : JSON.stringify(m.content), "utf8");
  const total = arr.reduce((s, m) => s + bytes(m), 0);
  // 上限内なら何もしない(新配列を返すが非破壊)
  // 0指定は刈り取り無効(config化の契約。memMaxMessages=0/memMaxBytes=0で使う)
  if (!maxMessages || !maxBytes) return { messages: [...arr], changed: false, removed: 0 };
  if (arr.length <= maxMessages && total <= maxBytes) {
    return { messages: [...arr], changed: false, removed: 0 };
  }
  // 保護枠がmaxMessagesを食い潰す場合は縮める(system+ヘッダ+最低2件の tail を残す)
  let keep = Math.max(2, Math.min(keepRecent, maxMessages - head.length - 1));
  // keepRecent保護がバイト上限を食い潰す場合: 保護枠を削ってでも最低1件は刈り取る
  // (body全体が保護されて dropped=0 になると、バイト超過のまま何も起きない不正状態を残す)
  const protectedBytes = () => head.reduce((s, m) => s + bytes(m), 0)
    + body.slice(-keep).reduce((s, m) => s + bytes(m), 0)
    + bytes({ content: MEM_HEADER + " " + new Date().toISOString() });
  if (!disabled(maxBytes)) {
    // dropped(初期keepで刈れる件数)が0のときだけ保護枠を削る。
    // 1件以上刈れるならkeepを維持(上限に収まらない単価のメッセージでも、刈り取り自体で
    // バイト合計は下がるため「何も起きない不正状態」を先に解消する。)

    const droppedFor = (k) => body.length - k;
    while (keep > 1 && droppedFor(keep) < 1 && keepRecent > body.length) keep--;
  }
  const tail = body.slice(-keep);
  const dropped = body.slice(0, Math.max(0, body.length - keep));
  if (!dropped.length) {
    return { messages: [...arr], changed: false, removed: 0 };
  }
  const roles = dropped.reduce((m, x) => ((m[x.role] = (m[x.role] ?? 0) + 1), m), {});
  const roleText = Object.entries(roles).map(([k, v]) => `${k}:${v}`).join("/");
  const header = {
    role: "user",
    content: `${MEM_HEADER} ${dropped.length}件(${roleText})を省略。${new Date().toISOString()}`,
  };
  return { messages: [...head, header, ...tail], changed: true, removed: dropped.length };
}
