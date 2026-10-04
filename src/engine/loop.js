// エージェントループ: model→tools→model…を回し、ボードの新着を都度注入する。
// 仕事の発見と請求(claim)はAI自身が claim_next_task ツールで行う。
// コンテキスト管理はZCode compact/準拠: microcompact(全ターン)→autocompact(閾値超過時)。
// 予算(トークン)超過と idle(連続請求失敗)はエンジンが強制終了する。
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  microcompact,
  shouldAutocompact,
  estimateMessagesTokens,
  buildCompactRequest,
  applyCompaction,
  AUTOCOMPACT_FAILURE_LIMIT,
} from "./compact.js";

const COMMON_RULES = `
## あなたの働き方(全エージェント共通)
- 仕事はワークスペース内のタスクボードで管理されている。まず claim_next_task で担当タスクを請求する。
- タスク本文に待ち合わせ(他者の報告待ち)があれば wait_for_board を使う。空転して模型した振りをしない。
- 請求できるタスクが無いときは wait_for_board(30〜60秒)で待ち、起きたら再度 claim_next_task を試す。**3回続けて請求できなければ、待機報告を post_to_board して終了する**(最終テキストで締める)。
- fix-*/review-* で始まるタスクは発見器が自動投入した仕事である(テスト失敗の修正/未レビュー変更の査読)。通常タスクと同じく請求して消化する。
- レビューや総括で後続の仕事(修正作業等)が生まれたら create_task でタスクとして投入し、post_to_board でも告知する。
- あなたの作業場所は自分専用のgit worktree(ブランチ agent/<自分のid>)。finish_task で自動的にmainへマージされる。
- 最新のmainの内容が必要なときは bash で \`git merge main\` を実行する。マージ競合を指摘されたら、競合ファイルを編集して解決し、コミットしてから再度 finish_task する。
- ファイル操作は自分の作業ディレクトリ配下のみ。報告・指摘・質問は post_to_board で全員に見せる。
- 進行予告だけの投稿をしない(「作成します」等)。成果が出てから報告する。
- 自分の担当タスクを完了したら finish_task を必ず呼ぶ。最後のテキスト出力は総括として短く。
- 他エージェントの投稿([ボード新着])が届いたら、自分の仕事に関係するものは必ず踏まえる。
- 自分より前の経過が必要なときは gather_context でボードの全経過・完了タスクを読める。セッションをまたいだ決め事はシステムプロンプトの永続記憶(memory/)にある。
- wait_for_board で起床したら、期待する報告(完了報告など)が揃っているか確認し、揃うまで再度待ってよい。
- bashで拒否されたコマンドは、理由を読んで安全な別手段に切り替えること(再試行しない)。
`;

// 暴走検知(ZCode runtime/helpers/model-anomaly.ts の移植): 同一ツール+同一引数の
// 連続呼び出しを検知してリマインダを注入する。回数での打ち切りより先に効く保険。
export const REPEAT_CALL_WARN_THRESHOLD = 3;
// 連続で失敗するツール呼び出しの打ち切りしきい値。失敗→失敗→失敗のループはturn-limitまで
// トークンを浪費するだけなので、しきい値到達でidle退場扱い(退場時掃除も走る)にする。
export const TOOL_FAIL_STREAK_LIMIT = 3;
export const MAX_REPEAT_CALL_WARNINGS_PER_TURN = 3;
// rapid-refillブレーカー(ZCode runtime/methods/turn-loop-state.ts の移植):
// 圧縮後3ターン未満でまた圧縮が要る状態が3連続なら、圧縮が追いついていないとして打ち切る。
export const RAPID_REFILL_TOOL_TURN_THRESHOLD = 3;
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function buildSystemPrompt(agent, shellKind = "bash") {
  const persona = agent.personaText ?? readFileSync(agent.personaPath, "utf8").trim();
  return `${persona}\n${COMMON_RULES}\n## このマシンの環境\n- シェルは ${shellKind}。bashならPOSIXコマンド、cmdならWindows構文で書くこと。`;
}

export function buildKickoff(agent, scenarioName) {
  return `シナリオ「${scenarioName}」を開始します。あなた(=${agent.displayName}/ロール:${agent.role})の仕事を claim_next_task で確認し、着手してください。`;
}

// autocompactの条件にする「いま遂行中の仕事」。請求中タスクがあればその本文、
// 無ければ(chat統括など)直近の genuine なユーザー指示([で始まる注入メッセージは除外)。
// どちらも無ければnullとなり、要約は従来どおり汎用になる。
function currentTaskContext(tasks, agent, messages) {
  const claimed = tasks ? tasks.claimedBy(agent.id) : [];
  if (claimed.length) {
    const text = claimed.map((t) => `タスク ${t.id}: ${t.body.trim()}`).join("\n");
    return text.slice(0, 1500);
  }
  const user = [...messages].reverse().find((m) => m.role === "user" && !m.content.startsWith("["));
  return user ? user.content.slice(0, 1500) : null;
}

/**
 * エージェントループのオプション(常駐chatはmessages/seenBoard/drainInput/peekInputを渡す)。
 * @typedef {Object} RunAgentLoopOptions
 * @property {{id: string, displayName: string, role: string, personaPath?: string, personaText?: string, scenarioName?: string}} agent
 * @property {{maxTokens?: number, chat: Function}} model chat({messages, tools, onDelta}) → {content, toolCalls, raw, usage}
 * @property {{specs: Object[], execute: (name: string, args: Object) => Promise<import("./tools.js").ToolResult>}} tools
 * @property {import("./board.js").Board} board
 * @property {import("./tasks.js").TaskBlackboard} tasks
 * @property {import("./board.js").Bus} bus
 * @property {{add: Function}} [ledger]
 * @property {{maxTokensPerRun?: number}} [budget]
 * @property {number} [maxTurns]
 * @property {string} [shellKind]
 * @property {number} [contextWindow]
 * @property {number} [thresholdPercent]
 * @property {Array<{role: string, content: any, tool_calls?: any, tool_call_id?: string}>} [messages] 常駐chatは外部保持の記憶を渡す
 * @property {number|null} [seenBoard] ボード既読位置(二重配信の防止)
 * @property {string|null} [memory] 永続記憶の注入文脈
 * @property {(() => any[])|null} [drainInput] ターン境界で割込ませる入力の取り出し(steering)
 * @property {(() => boolean)|null} [peekInput] 未処理入力が待っているか(idle退場の抑制)
 * @property {number} [claimMissesLimit] 連続請求ミス何回でidle終了するか
 * @property {((messages: any[]) => void)|null} [checkpointFn] ツール実行済み地点でスナップショットを保存するコールバック(イシュー#4)
 */

/** @param {RunAgentLoopOptions} o */
export async function runAgentLoop({
  agent, model, tools, board, tasks, bus,
  ledger = null, budget = null,
  maxTurns = 30, shellKind = "bash",
  contextWindow = 200000, thresholdPercent,
  messages = null, // 常駐エージェント(chat)は外部で保持した記憶を渡す
  seenBoard = null, // 前回までの既読位置(chat常駐時はホストが保持。nullならラウンド開始時点まで既読)
  memory = null, // 永続記憶(memory/の権威ファイル)の注入文脈。無ければnull
  drainInput = null, // () => ターン境界で割込ませる入力の配列(steering)。呼ぶたに取り出す
  peekInput = null, // () => 未処理入力が待っているか(取り出さず覗くだけ)。idle退場の抑制に使う
  claimMissesLimit = 3, // 連続請求ミス何回でidle終了するか(追加ワーカーは1で早期退場)
  checkpointFn = null, // (messages) => void ツール実行済み地点でスナップショットを保存する(イシュー#4)
}) {
  if (!messages) {
    const sys = buildSystemPrompt(agent, shellKind);
    messages = [
      { role: "system", content: memory ? `${sys}\n\n${memory}` : sys },
      { role: "user", content: buildKickoff(agent, agent.scenarioName ?? "default") },
    ];
  }
  let seen = seenBoard ?? board.lastId();
  let nudged = false;
  let emptyStreak = 0;
  let claimMisses = 0;
  let autocompactFailures = 0;
  let lastPromptTokens = 0;
  let runTokens = 0; // このラン(ループ実行)自体の消費。予算判定はラン単位(セッション累積だと常駐chatが使い切りで brick する)
  let lastToolSig = null; // 暴走検知: 直前のツール呼び出しシグネチャ
  let repeatStreak = 0;
  let toolFailStreak = 0; // 連続で失敗したツール呼び出しの回数(打ち切り判定用)
  let toolTurnsSinceCompact = 0; // 最終圧縮からのツール実行ターン数
  let rapidRefills = 0;
  let sawInput = false; // ラウンド中にユーザー入力(steering)を届けたか。idle退場の抑制に使う
  bus.emit("agent.status", { agent: agent.id, status: "working" });

  // 担当者不在になる終わり方のとき、請求中タスクをopenへ戻す(凍結防止)
  function releaseClaims(reason) {
    if (!tasks) return;
    const released = tasks.release(agent.id, `[解放] 担当者(${agent.id})が「${reason}」で終了したため、未完了としてopenへ戻しました。`);
    if (released.length) {
      board.post("system", `[解放] ${agent.id} 終了により ${released.join(", ")} をopenへ戻しました。誰でも請求できます。`);
    }
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    // 予算ブレーキ: このランのトークンが上限を超えたら終了(ラン単位なので常駐chatは次ラウンドで復活する)
    if (budget?.maxTokensPerRun && runTokens > budget.maxTokensPerRun) {
      board.post(agent.id, `[予算停止] このランのトークン予算(${budget.maxTokensPerRun})に達したため終了します。`);
      releaseClaims("予算停止");
      bus.emit("agent.status", { agent: agent.id, status: "budget-stop" });
      return { ok: false, endedBy: "budget", seenBoard: seen };
    }

    // ボード新着の注入(既読位置以降だけ。seenはホストが保持して二重配信を防ぐ)
    const fresh = board.since(seen).filter((p) => p.from !== agent.id);
    if (fresh.length) {
      seen = fresh[fresh.length - 1].id;
      // 参照は「from #id (ISO時刻/スレッド)」形式(イシュー#20): ボードクリア後のid再採番で
      // 番号単独の参照が衝突するため、メモリに残る参照はラベル・日時付きで曖昧性をなくす。
      const fmtAt = (t) => new Date(t).toISOString().replace("T", " ").slice(0, 16);
      const text = fresh.map((p) => `${p.from} #${p.id} (${fmtAt(p.at)}/${p.thread}): ${p.text}`).join("\n---\n");
      messages.push({ role: "user", content: `[ボード新着]\n${text.slice(0, 6000)}` });
    }
    // ラウンド実行中に入ったユーザー入力をターン境界で割込ませる(steering: ZCode command-queue流)
    // 文字列は[入力]として、オブジェクト(画像などのマルチモーダルメッセージ)はそのまま注入
    if (drainInput) {
      const inputs = drainInput();
      let steered = 0;
      for (const t of inputs) {
        if (typeof t === "string") {
          messages.push({ role: "user", content: `[入力] ${t}` });
        } else {
          messages.push(t);
        }
        steered++;
      }
      if (steered) {
        sawInput = true;
        bus.emit("agent.steered", { agent: agent.id, count: steered });
      }
    }

    // microcompact(ZCode移植): 古いツール結果をプレースホルダへ(LLM不要)
    const mc = microcompact(messages, { contextWindow });
    if (mc.changed) bus.emit("compact.micro", { agent: agent.id, savingsTokens: mc.savingsTokens });

    let res;
    // 生成速度(tok/s)計測用: 1呼出の実経過時間。トレースへ残してUIの「トークン/秒」表示に使う
    const chatStartedAt = Date.now();
    try {
      // ストリーミング: 断片をbusへ流してUIのライブ表示に使う
      res = await model.chat({ messages, tools: tools.specs, onDelta: (d) => bus.emit("agent.delta", { agent: agent.id, ...d }) });
    } catch (err) {
      releaseClaims("モデルエラー");
      bus.emit("agent.status", { agent: agent.id, status: "error" });
      bus.emit("agent.error", { agent: agent.id, turn, error: err.message });
      return { ok: false, endedBy: "error", error: err.message, seenBoard: seen };
    }
    const chatMs = Date.now() - chatStartedAt;
    if (ledger) {
      ledger.add(agent.id, res.usage, { ms: chatMs });
      bus.emit("usage", { agent: agent.id, usage: res.usage });
    }
    runTokens += (res.usage?.promptTokens ?? 0) + (res.usage?.completionTokens ?? 0);
    lastPromptTokens = res.usage?.promptTokens ?? 0;
    // トークン内訳のトレース記録(消費分析用)。ボードJSONLと同じ親の usage-trace/ 配下へ1ターン1行追記する
    // (監査領域 state/ 直下は避ける)。prompt/completion/reasoningの内訳+呼出時間(ms)+コンテキスト概算サイズを記録。
    try {
      // 書込先は監査領域(state/)を避ける: 監査台帳と同じディレクトリへのエンジン書込は運用と衝突する。
      // board.persistPathがあればその親の下 usage-trace/ へ、無ければスキップ(監査領域へは書かない)
      const baseDir = board.persistPath ? dirname(board.persistPath) : null;
      if (!baseDir) throw new Error("usage-trace: persistPath無し(state/監査領域を避けるため書かない)");
      const traceDir = join(baseDir, "usage-trace");
      mkdirSync(traceDir, { recursive: true });
      const ctxChars = messages.reduce((n, m) => n + String(m.content ?? "").length, 0);
      appendFileSync(join(traceDir, "usage-trace.jsonl"), JSON.stringify({
        ts: new Date().toISOString(), agent: agent.id, turn,
        prompt: res.usage?.promptTokens ?? 0,
        completion: res.usage?.completionTokens ?? 0,
        reasoning: res.usage?.reasoningTokens ?? 0,
        ms: chatMs,
        tokPerSec: chatMs > 0 ? (res.usage?.completionTokens ?? 0) / (chatMs / 1000) : null,
        ctxChars, msgCount: messages.length,
      }) + "\n");
      // UIのリアルタイム表示用(イシュー#17): トレースと同じ値をbusへ流す。
      // server.jsが受けて live.agents[id].ctx へ使用/上限/残りを、tok へ直近/平均のtok/sを計算して保持する
      bus.emit("usage.trace", { agent: agent.id, turn, ctxChars, ms: chatMs, completion: res.usage?.completionTokens ?? 0 });
    } catch { /* トレースの失敗でループを止めない */ }
    // サーバー側web_searchが走ったら活動ログへ(ZCodeの検索表示相当)
    if (res.searches?.length) {
      bus.emit("agent.search", {
        agent: agent.id, turn, count: res.searches.length,
        titles: res.searches.map((s) => s.title ?? "").filter(Boolean).slice(0, 3),
      });
    }
    bus.emit("agent.turn", { agent: agent.id, turn, content: res.content ?? "", reasoning: res.reasoning ?? "" });

    if (res.toolCalls.length > 0) {
      // GLM/OpenRouterはcontent:nullのassistantメッセージを拒むため文字列に正規化。
      // 呼び出しは共通形 res.toolCalls から組み立てる(rawはワイヤ形式ごとに形が違うため依存しない:
      // OpenAI=OpenAI形 / anthropic-messages={stop_reason,blocks} / chatgpt-responses=completed)
      const calls = (res.toolCalls ?? []).map((tc) => ({
        id: tc.id, type: "function",
        function: { name: tc.name, arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}) },
      }));
      messages.push({ role: "assistant", content: res.content ?? "", tool_calls: calls });
      const reminders = []; // 暴走検知のリマインダ(全ツール結果の後にまとめて注入)
      let warningsThisTurn = 0;
      for (const tc of res.toolCalls) {
        bus.emit("tool.call", { agent: agent.id, tool: tc.name, args: tc.arguments });
        let out;
        try {
          out = await tools.execute(tc.name, tc.arguments ?? {});
        } catch (err) {
          out = { ok: false, text: `ツール実行エラー: ${err.message}` };
        }
        bus.emit("tool.result", { agent: agent.id, tool: tc.name, ok: out.ok, brief: out.text.slice(0, 120) });
        messages.push({ role: "tool", tool_call_id: tc.id, content: out.text.slice(0, 12000) });
        // 失敗ツール結果の連続は打ち切り: モデルが失敗を学習せず同じ失敗を繰り返す場合、
        // turn-limitまでトークンを浪費するより1回の失敗で次の手(諦め/別アプローチ)へ進ませる
        if (!out.ok) toolFailStreak += 1; else toolFailStreak = 0;
        if (toolFailStreak >= TOOL_FAIL_STREAK_LIMIT) {
          releaseClaims("ツール失敗の連続");
          board.post(agent.id, `[停止] ツール呼び出しが${toolFailStreak}回連続で失敗したため終了します。同じ入力では同じ結果になります。`);
          bus.emit("agent.status", { agent: agent.id, status: "tool-fail-loop" });
          return { ok: false, endedBy: "tool-fail-loop", error: `ツール失敗が${toolFailStreak}回連続`, seenBoard: seen };
        }
        // idle強制終了: 連続3回の請求失敗はプロンプトでなくエンジンが数える
        if (tc.name === "claim_next_task") {
          claimMisses = out.claimMiss ? claimMisses + 1 : 0;
        }
        // 暴走検知: 同一ツール+同一引数(ZCode model-anomaly.ts)。しきい値に達した瞬間だけ警告し、
        // ツール結果とassistantの間に挟まないよう全ツール結果の後にまとめて注入する
        const sig = `${JSON.stringify(tc.name)}:${stableJson(tc.arguments ?? {})}`;
        if (sig === lastToolSig) repeatStreak += 1; else { lastToolSig = sig; repeatStreak = 1; }
        if (repeatStreak === REPEAT_CALL_WARN_THRESHOLD && warningsThisTurn < MAX_REPEAT_CALL_WARNINGS_PER_TURN) {
          warningsThisTurn += 1;
          reminders.push({ role: "user", content: `[システム] 同じ入力で ${tc.name} を${repeatStreak}回連続呼び出しました。毎回同じ結果になるだけです。得られた結果を使って次の手を変えるか、行き詰まりを post_to_board で相談してください。` });
        }
      }
      messages.push(...reminders.splice(0));
      // ラウンドcheckpoint(イシュー#4): ツール実行済み地点でスナップショット。
      // 指定が無い(ワーカーラウンド等)場合は何もしない。
      checkpointFn?.(messages);
      if (claimMisses >= claimMissesLimit) {
        // ユーザー入力が待っている/届けたばかりで未応答のときはidle退場しない。
        // 退場すると入力に答える前にラウンドが捨てられる(r7で実際に発生: ラウンド中のsayが
        // steeringで届いたまま、請求ミス3回で退場して応答が消えた)。
        // 救助は入力1件につき1回。それでも応答せず請求ミスを続ければ従来どおり退場する。
        if (peekInput?.() || sawInput) {
          sawInput = false;
          claimMisses = 0;
          messages.push({ role: "user", content: "[システム] 未処理のユーザー入力があります。請求よりも先に応答してください。" });
          continue;
        }
        releaseClaims("idle待機終了");
        board.post(agent.id, `[待機終了] 請求できるタスクが${claimMissesLimit}回連続で無かったため終了します。`);
        bus.emit("agent.status", { agent: agent.id, status: "done" });
        return { ok: true, endedBy: "idle", seenBoard: seen };
      }
      toolTurnsSinceCompact += 1;
      continue;
    }

    // autocompact(ZCode移植): provider usage優先で閾値判定→要約で履歴を置換
    const ac = shouldAutocompact({
      providerPromptTokens: lastPromptTokens,
      estimatedTokens: estimateMessagesTokens(messages),
      contextWindow,
      maxOutputTokens: model.maxTokens,
      thresholdPercent,
    });
    if (ac.should && autocompactFailures < AUTOCOMPACT_FAILURE_LIMIT) {
      try {
        const acStartedAt = Date.now();
        const summary = await model.chat({ messages: buildCompactRequest(messages, { taskContext: currentTaskContext(tasks, agent, messages), hasMemory: Boolean(memory) }) });
        if (ledger) ledger.add(agent.id, summary.usage, { ms: Date.now() - acStartedAt });
        runTokens += (summary.usage?.promptTokens ?? 0) + (summary.usage?.completionTokens ?? 0);
        const text = (summary.content ?? "").trim();
        if (!text) throw new Error("要約が空でした");
        const compacted = applyCompaction(messages, text);
        messages.length = 0;
        messages.push(...compacted);
        autocompactFailures = 0;
        bus.emit("compact.auto", { agent: agent.id, tokensBefore: ac.tokens, threshold: ac.threshold });
        // rapid-refillブレーカー(ZCode turn-loop-state.ts): 圧縮後まもなくまた溢れる状態が
        // 連続したら、圧縮が追いついていないとしてループを打ち切る
        if (toolTurnsSinceCompact < RAPID_REFILL_TOOL_TURN_THRESHOLD) {
          rapidRefills += 1;
        } else {
          rapidRefills = 0;
        }
        toolTurnsSinceCompact = 0;
        if (rapidRefills >= MAX_CONSECUTIVE_RAPID_REFILLS) {
          releaseClaims("コンテキスト圧縮が追いつかない");
          board.post(agent.id, `[停止] 圧縮してもコンテキストが肥大し続けるため終了します。作業状態は保持されています。`);
          bus.emit("agent.status", { agent: agent.id, status: "compact-loop" });
          return { ok: false, endedBy: "compact-rapid-refill", seenBoard: seen };
        }
      } catch (err) {
        autocompactFailures += 1;
        bus.emit("compact.failed", { agent: agent.id, error: err.message, failures: autocompactFailures });
      }
      continue; // 圧縮したので次のターンで作業を続ける
    }

    const finalText = (res.content ?? "").trim();
    // 空応答(思考トークン消費など)は終了ではなく続行を促す
    if (!finalText) {
      emptyStreak += 1;
      if (emptyStreak > 3) {
        bus.emit("agent.status", { agent: agent.id, status: "empty-loop" });
        return { ok: false, error: "空応答が連続しました", seenBoard: seen };
      }
      messages.push({ role: "user", content: "[システム] 応答が空でした。次に行うべき行動をツール呼び出しで実行してください。" });
      continue;
    }
    // 請求中タスクが残っているのに終わろうとしたら1回だけ促す
    if (tasks && !nudged && tasks.claimedBy(agent.id).length > 0) {
      nudged = true;
      const ids = tasks.claimedBy(agent.id).map((t) => t.id).join(", ");
      messages.push({ role: "user", content: `[システム] 請求中のタスク(${ids})が未完了です。完了していれば finish_task を呼んでください。まだ継続なら作業を続けてください。` });
      continue;
    }
    board.post(agent.id, finalText);
    bus.emit("agent.status", { agent: agent.id, status: "done" });
    return { ok: true, finalText, seenBoard: seen };
  }

  bus.emit("agent.status", { agent: agent.id, status: "turn-limit" });
  return { ok: false, endedBy: "turn-limit", error: `ターン上限(${maxTurns})に達しました`, seenBoard: seen };
}
