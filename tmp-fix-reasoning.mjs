// 一時パッチスクリプト(実行後削除)。edit_file失敗の代替としてnodeで安全置換する。
// 教訓(2026-09 search-alert-r7)に従い、バッククォートとテンプレートリテラルは使わない。
import { readFileSync, writeFileSync } from "node:fs";

const path = "src/model/openai.js";
let src = readFileSync(path, "utf8");

// --- 置換1: ストリーム経路で reasoning_content も蓄積 ---
const old1 = [
  "        if (d.reasoning) {",
  "          reasoning += d.reasoning;",
  '          onDelta?.({ kind: "think", text: d.reasoning });',
  "        }",
].join("\n");
const new1 = [
  "        // 思考テキスト: OpenRouter流reasoningに加えDeepSeek/zai流reasoning_contentも拾う",
  "        // (両方来たときは出現順に連結)。UI思考表示用に断片もonDeltaへ流す。",
  "        const think = d.reasoning ?? d.reasoning_content;",
  "        if (think) {",
  "          reasoning += think;",
  '          onDelta?.({ kind: "think", text: think });',
  "        }",
].join("\n");

// --- 置換2: 非ストリーム経路で msg.reasoning_content をフォールバック ---
const old2 = [
  "        content: msg.content ?? null,",
  "        reasoning: msg.reasoning ?? null, // 思考テキスト(OpenRouterのreasoningモデル。UIの活動ログ用)",
].join("\n");
const new2 = [
  "        content: msg.content ?? null,",
  "        // 思考テキスト: OpenRouter流reasoning、無ければzai/DeepSeek流reasoning_content(UIの活動ログ用)",
  "        reasoning: msg.reasoning || msg.reasoning_content || null,",
].join("\n");

function apply(src, old, repl, label) {
  const count = src.split(old).length - 1;
  if (count !== 1) {
    console.error(label + ": match count=" + count);
    process.exit(1);
  }
  return src.replace(old, repl);
}

src = apply(src, old1, new1, "stream-patch");
src = apply(src, old2, new2, "nonstream-patch");
writeFileSync(path, src);
console.log("patched OK");
