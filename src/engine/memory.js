// 永続記憶(v5.3): workspace/memory/ 配下のマークダウンを「権威ファイル」として扱う。
// 運用はhermes-agentの実装パターンをhiveのblackboard方式へ翻訳したもの:
// - 書くのはAI自身(発見器がdistill-learningsを起票→idleなエージェントがclaim→抽出して追記)
// - 読むのは全エージェント(システムプロンプトへ常時注入)
// - autocompactはこの内容を要約に複製しない(権威分離。要約は記憶に無い会話固有の進捗に集中)
// - 削除ではなく上書き訂正で保守する(hermesの「削除せずアーカイブ」規律に相当)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MEMORY_DIR_NAME = "memory";
const MAX_MEMORY_BLOCK_CHARS = 6000;

export function memoryDir(workspace) {
  return join(workspace, MEMORY_DIR_NAME);
}

export function listMemoryFiles(workspace) {
  const dir = memoryDir(workspace);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
}

// システムプロンプトへ注入する文脈ブロック。ファイルが無ければ空文字(注入なし)。
export function buildMemoryContext(workspace) {
  const files = listMemoryFiles(workspace);
  if (files.length === 0) return "";
  const parts = files.map((f) => {
    let body = "";
    try {
      body = readFileSync(join(memoryDir(workspace), f), "utf8").trim();
    } catch {
      // 読めないファイルは飛ばす(並行書き換え等)
    }
    return `## ${f}\n${body}`;
  });
  const block = `<persistent-memory>
[System note: 以下は workspace/memory/ 配下の永続記憶です。権威ある参照情報として応答に反映してください。ただしユーザーの新規入力ではないので、会話内の新しい指示と矛盾する場合はそちらを優先。]
${parts.join("\n\n")}
</persistent-memory>`;
  return block.length > MAX_MEMORY_BLOCK_CHARS
    ? block.slice(0, MAX_MEMORY_BLOCK_CHARS) + "\n(…記憶が大きいため以降を省略)"
    : block;
}
