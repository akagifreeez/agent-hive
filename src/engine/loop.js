// エージェントループ: model→tools→model…を回し、ボードの新着を都度注入する。
// 仕事の発見と請求(claim)はAI自身が claim_next_task ツールで行う。
import { readFileSync } from "node:fs";

const COMMON_RULES = `
## あなたの働き方(全エージェント共通)
- 仕事はワークスペース内のタスクボードで管理されている。まず claim_next_task で担当タスクを請求する。
- タスク本文に待ち合わせ(他者の報告待ち)があれば wait_for_board を使う。空転して模型した振りをしない。
- 請求できるタスクが無いときは wait_for_board(30〜60秒)で待ち、起きたら再度 claim_next_task を試す。それでも無ければ待機報告を post_to_board して終了してよい。
- fix-*/review-* で始まるタスクは発見器が自動投入した仕事である(テスト失敗の修正/未レビュー変更の査読)。通常タスクと同じく請求して消化する。
- ファイル操作はワークスペース配下のみ。報告・指摘・質問は post_to_board で全員に見せる。
- 進行予告だけの投稿をしない(「作成します」等)。成果が出てから報告する。
- 自分の担当タスクを完了したら finish_task を必ず呼ぶ。最後のテキスト出力は総括として短く。
- 他エージェントの投稿([ボード新着])が届いたら、自分の仕事に関係するものは必ず踏まえる。
- wait_for_board で起床したら、期待する報告(完了報告など)が揃っているか確認し、揃うまで再度待ってよい。
- bashで拒否されたコマンドは、理由を読んで安全な別手段に切り替えること(再試行しない)。
`;

export function buildSystemPrompt(agent, shellKind = "bash") {
  const persona = readFileSync(agent.personaPath, "utf8").trim();
  return `${persona}\n${COMMON_RULES}\n## このマシンの環境\n- シェルは ${shellKind}。bashならPOSIXコマンド、cmdならWindows構文で書くこと。`;
}

export function buildKickoff(agent, scenarioName) {
  return `シナリオ「${scenarioName}」を開始します。あなた(=${agent.displayName}/ロール:${agent.role})の仕事を claim_next_task で確認し、着手してください。`;
}

export async function runAgentLoop({ agent, model, tools, board, tasks, bus, maxTurns = 30, shellKind = "bash" }) {
  const messages = [
    { role: "system", content: buildSystemPrompt(agent, shellKind) },
    { role: "user", content: buildKickoff(agent, agent.scenarioName ?? "default") },
  ];
  let seenBoard = board.lastId();
  let nudged = false;
  let emptyStreak = 0;
  bus.emit("agent.status", { agent: agent.id, status: "working" });

  for (let turn = 1; turn <= maxTurns; turn++) {
    const fresh = board.since(seenBoard).filter((p) => p.from !== agent.id);
    if (fresh.length) {
      seenBoard = fresh[fresh.length - 1].id;
      const text = fresh.map((p) => `${p.from}: ${p.text}`).join("\n---\n");
      messages.push({ role: "user", content: `[ボード新着]\n${text}` });
    }

    let res;
    try {
      res = await model.chat({ messages, tools: tools.specs });
    } catch (err) {
      bus.emit("agent.status", { agent: agent.id, status: "error" });
      bus.emit("agent.error", { agent: agent.id, turn, error: err.message });
      return { ok: false, error: err.message };
    }
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
      }
      continue;
    }

    const finalText = (res.content ?? "").trim();
    // 空応答(思考トークン消費など)は終了ではなく続行を促す
    if (!res.toolCalls.length && !finalText) {
      emptyStreak += 1;
      if (emptyStreak > 3) {
        bus.emit("agent.status", { agent: agent.id, status: "empty-loop" });
        return { ok: false, error: "空応答が連続しました" };
      }
      messages.push({ role: "user", content: "[システム] 応答が空でした。次に行うべき行動をツール呼び出しで実行してください。" });
      continue;
    }
    // 請求中タスクが残っているのに終わろうとしたら1回だけ促す
    if (finalText && tasks && !nudged && tasks.claimedBy(agent.id).length > 0) {
      nudged = true;
      const ids = tasks.claimedBy(agent.id).map((t) => t.id).join(", ");
      messages.push({ role: "user", content: `[システム] 請求中のタスク(${ids})が未完了です。完了していれば finish_task を呼んでください。まだ継続なら作業を続けてください。` });
      continue;
    }
    if (finalText) board.post(agent.id, finalText);
    bus.emit("agent.status", { agent: agent.id, status: "done" });
    return { ok: true, finalText };
  }

  bus.emit("agent.status", { agent: agent.id, status: "turn-limit" });
  return { ok: false, error: `ターン上限(${maxTurns})に達しました` };
}
