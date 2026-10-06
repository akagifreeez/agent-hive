// モデル可視バンドルの追記専用裏ログ(dsh-vs-hive比較doc G1)。
// dshの設計不変量「Model-visible means logged」の移植: モデル呼出1回ごとの組立済みペイロード
// (system+messages+ツール定義)と応答・失敗を1レコード1行で残す。messages配列の上書き保存
// (state/mem-<id>.json)とは独立なので、圧縮の前後・リトライ・失敗も含めて「圧縮が何を消したか」
// 「どのペイロードで壊れたか」を後から検証できる。書込の失敗は握り潰す(ログがループを止めない)。
// 保存先はusage-trace/と同じ考え方で、board persistPathの親の下 session-log/ 配下。
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

// 1ファイルの上限。超えたら session-<時刻>.jsonl へ回転する(リーダーの1ラウンドは数十MBになりうる)。
export const SESSION_LOG_MAX_BYTES = 64 * 1024 * 1024;
// 回転後に残す旧ファイルの数(古いものから削除)。
export const SESSION_LOG_KEEP = 3;

const CURRENT = "session.jsonl";
const ROTATED_RE = /^session-\d{4}-\d{2}-\d{2}T/;

/**
 * @param {{dir: string|null, maxBytes?: number, keep?: number}} o dir=nullなら何もしないno-op
 * @returns {{append: (record: object) => void, rotations: () => number}}
 */
export function createSessionLog({ dir, maxBytes = SESSION_LOG_MAX_BYTES, keep = SESSION_LOG_KEEP } = {}) {
  if (!dir) return { append() {}, rotations: () => 0 };
  let rotated = 0;
  function rotate() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    renameSync(join(dir, CURRENT), join(dir, `session-${stamp}.jsonl`));
    rotated += 1;
    const olds = readdirSync(dir).filter((f) => ROTATED_RE.test(f)).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - keep))) {
      try { rmSync(join(dir, f)); } catch { /* 掴まれているファイルは次回の回転で */ }
    }
  }
  return {
    rotations: () => rotated,
    append(record) {
      try {
        mkdirSync(dir, { recursive: true });
        const file = join(dir, CURRENT);
        if (existsSync(file) && statSync(file).size > maxBytes) rotate();
        appendFileSync(file, JSON.stringify(record) + "\n");
      } catch { /* ログの失敗でループを止めない */ }
    },
  };
}
