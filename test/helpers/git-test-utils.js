// テスト用のgit/一時ディレクトリ共通ユーティリティ(approvals-hold.test.jsで使用)。
import { rmSync } from "node:fs";

/** 一時ディレクトリを再帰削除する。Windowsのファイルロック(EPERM/EBUSY)は無視する。 */
export function rmTree(p) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* Windowsのファイルロックは無視 */
  }
}
