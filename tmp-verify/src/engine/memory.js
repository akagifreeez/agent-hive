// 永続記憶(v5.3): workspace/memory/ 配下のマークダウンを「権威ファイル」として扱う。
// 運用はhermes-agentの実装パターンをhiveのblackboard方式へ翻訳したもの:
// - 書くのはAI自身(発見器がdistill-learningsを起票→idleなエージェントがclaim→抽出して追記)
// - 読むのは全エージェント(システムプロンプトへ常時注入)
// - autocompactはこの内容を要約に複製しない(権威分離。要約は記憶に無い会話固有の進捗に集中)
// - 削除ではなく上書き訂正で保守する(hermesの「削除せずアーカイブ」規律に相当)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const MEMORY_DIR_NAME = "memory";
const MAX_MEMORY_BLOCK_CHARS = 6000;
// ttl表記の単位(分/時/日)。claude-flowのメモリTTL(種別ごとに寿命を切る)の翻訳
const TTL_UNITS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

// PC操作の制限(ZCode相当の権威ルール)。全エージェントのシステムプロンプトに常時注入する。
// 新規ワークスペースで自動シードし、既存のファイルがあれば上書きしない(手動調整を尊重)。
export const PC_RULES_FILENAME = "00-pc-operation-rules.md";
const PC_RULES_BODY = `# PC操作の制限(全エージェントへの権威ルール)

このワークスペースで作業する全エージェントは、以下を必ず守る。ZCode相当の慎重さでPCを扱う。

1. **最小権限**: 作業は自分のworktree(リーダーはワークスペース)の中だけで完結させる
2. **アプリ内部データに触れない**: state/ 配下(ボードのJSONL・threads.json・セッション・usage等)は読み書きしない。横の連携は必ずボード投稿・タスク・gather_context 経由で行う
3. **ファイルの正規経路だけ使う**: タスクの状態変更は claim/finish などのタスクツール経由のみ。memory/ の保守は learnings の流れ(タスク経由)でのみ行い、それ以外の目的で記憶ファイルを書き換えない
4. **bash は最終手段**: 実行する場合も次を含むコマンドは書かない
   - ワークスペース外への影響(システム設定変更・ソフトのインストール・削除・プロセスの停止・ネットワーク経由の送信)
   - 破壊的操作(rm / git reset --hard / force push / 権限変更 等)
5. **外部送信の禁止**: webフォームへの投稿、curl等によるデータ送信、外部サービスへの公開はしない。web_fetch / web_search は読み取り専用として使う
6. **機微情報の扱い**: 認証情報・鍵・トークン・.env・設定ファイルの機微情報を読まない。ボードやmemoryへ転記しない
7. **他者の領域**: 他エージェントのworktreeを直接編集しない。引き継ぎはボードの告知経由で行う
8. **例外は承認でだけ**: 上記に抵触する作業が必要なときは、実行せずボードに「理由・方法・影響範囲」を書いてユーザーの承認を待つ
`;

export function memoryDir(workspace) {
  return join(workspace, MEMORY_DIR_NAME);
}

// 制限ルールのシード。ファイルが無い新規ワークスペースでのみ書き、既存は触らない
export function ensurePcRules(workspace) {
  const file = join(memoryDir(workspace), PC_RULES_FILENAME);
  if (existsSync(file)) return false;
  mkdirSync(memoryDir(workspace), { recursive: true });
  writeFileSync(file, PC_RULES_BODY, "utf8");
  return true;
}

export function listMemoryFiles(workspace) {
  const dir = memoryDir(workspace);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
}

// memory/*.mdの一覧に期限切れフラグを付けたもの(/api/memory・UIメモリタブ用)。
// 期限切れは注入から外れるだけなので、UIでは「期限切れ」と見せる
export function listMemoryWithExpiry(workspace) {
  return listMemoryFiles(workspace).map((name) => ({ name, expired: isMemoryExpired(workspace, name) }));
}

// 先頭のメタ行の ttl: <数><m|h|d> から寿命を解析する。宣言が無ければnull(永久)
function memoryTtlMs(body) {
  for (const l of body.split("\n")) {
    if (!l.trim()) break;
    const m = l.match(/^ttl:\s*(\d+)\s*([mhd])\s*$/i);
    if (m) return Number(m[1]) * TTL_UNITS[m[2].toLowerCase()];
  }
  return null;
}

// 記憶ファイルが寿命切れか(mtime + ttl が過去)。ファイルは消さず注入から外すだけ
// (削除ではなく上書き訂正で保守する、というmemory運用の規律を踏襲)。
export function isMemoryExpired(workspace, file, now = Date.now()) {
  try {
    const raw = readFileSync(join(memoryDir(workspace), file), "utf8");
    const ttl = memoryTtlMs(raw);
    if (ttl == null) return false;
    const st = statSync(join(memoryDir(workspace), file));
    return st.mtimeMs + ttl < now;
  } catch {
    return false;
  }
}

// ttlメタ行を本文から除く(注入物に運用メタを混ぜない)
function stripTtlLine(body) {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) break;
    if (/^ttl:\s*(\d+)\s*([mhd])\s*$/i.test(lines[i])) {
      lines.splice(i, 1);
      break;
    }
  }
  return lines.join("\n");
}

// システムプロンプトへ注入する文脈ブロック。ファイルが無ければ空文字(注入なし)。
// ttl宣言のあるファイルで寿命切れのものは注入から外す(ファイル自体は残す)。
export function buildMemoryContext(workspace) {
  const files = listMemoryFiles(workspace).filter((f) => !isMemoryExpired(workspace, f));
  if (files.length === 0) return "";
  const parts = files.map((f) => {
    let body = "";
    try {
      body = stripTtlLine(readFileSync(join(memoryDir(workspace), f), "utf8").trim());
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
