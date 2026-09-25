// エージェントループ: model→tools→model…を回し、ボードの新着を都度注入する。
// 仕事の発見と請求(claim)はAI自身が claim_next_task ツールで行う。
// コンテキスト管理はZCode compact/準拠: microcompact(全ターン)→autocompact(閾値超過時)。
// 予算(トークン)超過と idle(連続請求失敗)はエンジンが強制終了する。
import { readFileSync } from "node:fs";
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
- wait_for_board で起床したら、期待する報告(完了報告など)が揃っているか確認し、揃うまで再度待ってよい。
- bashで拒否されたコマンドは、理由を読んで安全な別手段に切り替えること(再試行しない)。
`;

export function buildSystemPrompt(agent, shellKind = "bash") {
  const persona = agent.personaText ?? readFileSync(agent.personaPath, "utf8").trim();
  return `${persona}\n${COMMON_RULES}\n## このマシンの環境\n- シェルは ${shellKind}。bashならPOSIXコマンド、cmdならWindows構文で書くこと。`;
}

export function buildKickoff(agent, scenarioName) {
  return `シナリオ「${scenarioName}」を開始します。あなた(=${agent.displayName}/ロール:${agent.role})の仕事を claim_next_task で確認し、着手してください。`;
}

export async function runAgentLoop({
  agent, model, tools, board, tasks, bus,
  ledger = null, budget = null,
  maxTurns = 30, shellKind = "bash",
  contextWindow = 200000, thresholdPercent,
  messages = null, // 常駐エージェント(chat)は外部で保持した記憶を渡す
  seenBoard = null, // 前回までの既読位置(chat常駐時はホストが保持。nullならラウンド開始時点まで既読)
}) {
  if (!messages) {
    messages = [
      { role: "system", content: buildSystemPrompt(agent, shellKind) },
      { role: "user", content: buildKickoff(agent, agent.scenarioName ?? "default") },
    ];
  }
  let seen = seenBoard ?? board.lastId();
  let nudged = false;
  let emptyStreak = 0;
  let claimMisses = 0;
  let autocompactFailures = 0;
  let lastPromptTokens = 0;
  bus.emit("agent.status", { agent: agent.id, status: "working" });

  for (let turn = 1; turn <= maxTurns; turn++) {
    // 予算ブレーキ: ラン全体のトークンが上限を超えたら終了
    if (ledger && budget?.maxTokensPerRun && ledger.totals().promptTokens + ledger.totals().completionTokens > budget.maxTokensPerRun) {
      board.post(agent.id, `[予算停止] ラン全体のトークン予算(${budget.maxTokensPerRun})に達したため終了します。`);
      bus.emit("agent.status", { agent: agent.id, status: "budget-stop" });
      return { ok: false, endedBy: "budget", seenBoard: seen };
    }

    // ボード新着の注入(既読位置以降だけ。seenはホストが保持して二重配信を防ぐ)
    const fresh = board.since(seen).filter((p) => p.from !== agent.id);
    if (fresh.length) {
      seen = fresh[fresh.length - 1].id;
      const text = fresh.map((p) => `${p.from}: ${p.text}`).join("\n---\n");
      messages.push({ role: "user", content: `[ボード新着]\n${text.slice(0, 6000)}` });
    }

    // microcompact(ZCode移植): 古いツール結果をプレースホルダへ(LLM不要)
    const mc = microcompact(messages, { contextWindow });
    if (mc.changed) bus.emit("compact.micro", { agent: agent.id, savingsTokens: mc.savingsTokens });

    let res;
    try {
      res = await model.chat({ messages, tools: tools.specs });
    } catch (err) {
      bus.emit("agent.status", { agent: agent.id, status: "error" });
      bus.emit("agent.error", { agent: agent.id, turn, error: err.message });
      return { ok: false, error: err.message, seenBoard: seen };
    }
    if (ledger) {
      ledger.add(agent.id, res.usage);
      bus.emit("usage", { agent: agent.id, usage: res.usage });
    }
    lastPromptTokens = res.usage?.promptTokens ?? 0;
    bus.emit("agent.turn", { agent: agent.id, turn, content: res.content ?? "" });

    if (res.toolCalls.length > 0) {
      // GLM/OpenRouterはcontent:nullのassistantメッセージを拒むため文字列に正規化
      messages.push({ role: "assistant", content: res.raw.content ?? "", tool_calls: res.raw.tool_calls });
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
        // idle強制終了: 連続3回の請求失敗はプロンプトでなくエンジンが数える
        if (tc.name === "claim_next_task") {
          claimMisses = out.claimMiss ? claimMisses + 1 : 0;
        }
      }
      if (claimMisses >= 3) {
        board.post(agent.id, `[待機終了] 請求できるタスクが3回連続で無かったため終了します。`);
        bus.emit("agent.status", { agent: agent.id, status: "done" });
        return { ok: true, endedBy: "idle", seenBoard: seen };
      }
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
        const summary = await model.chat({ messages: buildCompactRequest(messages) });
        if (ledger) ledger.add(agent.id, summary.usage);
        const text = (summary.content ?? "").trim();
        if (!text) throw new Error("要約が空でした");
        const compacted = applyCompaction(messages, text);
        messages.length = 0;
        messages.push(...compacted);
        autocompactFailures = 0;
        bus.emit("compact.auto", { agent: agent.id, tokensBefore: ac.tokens, threshold: ac.threshold });
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
