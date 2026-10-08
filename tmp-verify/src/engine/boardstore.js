// ボード履歴のディスクストア(チャット肥大化対策)。
// 方針: 履歴JSONLを全文一気に読まない。
// - 起動時は各ファイルの末尾だけ読んで表示を即復元(readBoardTail)
// - 過去の頁送りは、行頭バイトオフセットの索引を一度張って2分探索→必要な範囲だけ読む
// - 索引の更新は追記差分スキャン(前回走査位置から新規バイトだけ)。全体再走査は起きない
// JSONL自体の形式は従来どおり(Board.postが書く1投稿1行)なので、旧ログともそのまま互換。
import { openSync, readSync, closeSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parsePost(line) {
  if (!line || !line.trim()) return null;
  try {
    const p = JSON.parse(line);
    if (p && typeof p.id === "number") return p;
  } catch {}
  return null;
}

// ファイル末尾maxBytesだけ読んで投稿配列にする。切り-gapの可能性がある先頭の行は捨てる
export function readBoardTail(path, maxBytes = 256 * 1024) {
  const posts = [];
  try {
    const size = statSync(path).size;
    if (!size) return posts;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString("utf8").split("\n");
    if (start > 0 && lines.length) lines.shift();
    for (const l of lines) {
      const p = parsePost(l);
      if (p) posts.push(p);
    }
  } catch {}
  return posts;
}

// 1ファイル分の索引。offsets/idsは「パース出来た行」だけを文件順で持つ(壊れ行は頁送りでスキップ)
export class BoardFileIndex {
  constructor(path) {
    this.path = path;
    this.scanned = 0;   // ここまで走査済み(必ず行境界)。offsets/idsはこの位置までの全行を収録
    this.trailing = -1; // 改行なしで終わっている未確定行の開始位置(無ければ-1)
    this.offsets = [];
    this.ids = [];
  }

  // 追記を反映(差分スキャン)。戻り値は収録行数
  sync() {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      return this.offsets.length; // ファイルがまだ無い
    }
    if (size === this.scanned && this.trailing < 0) return this.offsets.length;
    if (size < this.scanned || (this.trailing >= 0 && size < this.trailing)) {
      // 切詰め/再生成されたので全張り直し
      this.scanned = 0;
      this.trailing = -1;
      this.offsets = [];
      this.ids = [];
    }
    const from = this.trailing >= 0 ? this.trailing : this.scanned;
    const len = size - from;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      const fd = openSync(this.path, "r");
      try {
        readSync(fd, buf, 0, len, from);
      } finally {
        closeSync(fd);
      }
      // バイト単位で走査する(文字単位だとマルチバイト行でオフセットがずれる)
      let lineStart = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0x0a) continue;
        const line = buf.toString("utf8", lineStart, i);
        const p = parsePost(line);
        if (p) {
          this.offsets.push(from + lineStart);
          this.ids.push(p.id);
        }
        lineStart = i + 1;
      }
      if (lineStart < buf.length) this.trailing = from + lineStart;
      else this.trailing = -1;
    }
    this.scanned = this.trailing >= 0 ? this.trailing : size;
    return this.offsets.length;
  }

  count() {
    return this.sync();
  }

  // beforeIdより前(無ければ末尾)の最大limit件を、ファイル順(古い順)で返す
  page(beforeId, limit = 200) {
    const n = this.sync();
    if (!n) return [];
    let end;
    if (beforeId == null || beforeId <= 0) {
      end = n;
    } else {
      // idsは昇順。beforeId未満の最後の1件の次を二分探索
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.ids[mid] < beforeId) lo = mid + 1;
        else hi = mid;
      }
      end = lo; // 最初の ids[end] >= beforeId
      if (end === 0) return [];
    }
    const start = Math.max(0, end - limit);
    return this.readRange(start, end);
  }

  readRange(start, end) {
    const from = this.offsets[start];
    const to = end < this.offsets.length ? this.offsets[end] : this.scanned;
    const len = to - from;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    const fd = openSync(this.path, "r");
    try {
      readSync(fd, buf, 0, len, from);
    } finally {
      closeSync(fd);
    }
    const posts = [];
    for (const l of buf.toString("utf8").split("\n")) {
      const p = parsePost(l);
      if (p) posts.push(p);
    }
    return posts;
  }
}

// state/配下の全ボードファイルを束ねる窓口。UIの頁送りと起動復元に使う
export class BoardStore {
  constructor(workspace) {
    this.dir = join(workspace, "state");
    this.indexes = new Map();
  }

  files() {
    try {
      return readdirSync(this.dir).filter((f) => f === "board__main__.jsonl" || /^board-.+\.jsonl$/.test(f)).sort();
    } catch {
      return [];
    }
  }

  indexFor(file) {
    let ix = this.indexes.get(file);
    if (!ix) {
      ix = new BoardFileIndex(join(this.dir, file));
      this.indexes.set(file, ix);
    }
    return ix;
  }

  static fileFor(thread) {
    return !thread || thread === "__main__" ? "board__main__.jsonl" : `board-${thread}.jsonl`;
  }

  // 全スレッドの総投稿数(UIの「以前の投稿」計上に使う)
  total() {
    let n = 0;
    for (const f of this.files()) n += this.indexFor(f).count();
    return n;
  }

  // スレッド1本の頁送り。投稿(古い順)とそのスレッドの総数を返す
  pageThread(thread, beforeId, limit = 200) {
    const ix = this.indexFor(BoardStore.fileFor(thread));
    return { posts: ix.page(beforeId, limit), total: ix.count() };
  }

  // thread指定なしの旧クライアント用: 全ファイルから集めて時系列マージ(投稿idはスレッドごとに別採番なのでatで並べる)
  pageMixed(beforeId, limit = 200) {
    const parts = [];
    for (const f of this.files()) parts.push(...this.indexFor(f).page(beforeId, limit));
    return parts.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id - b.id).slice(-limit);
  }

  // 起動時の表示復元。各ファイルの末尾だけ読んで混ぜる(全文は読まない)
  latest(limit = 400) {
    const all = [];
    for (const f of this.files()) {
      const tail = readBoardTail(join(this.dir, f), 256 * 1024);
      all.push(...tail.slice(-limit));
    }
    return all.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id - b.id);
  }

  // スレッドのチャット履歴を空にする(タスク/メモリには触らない)。索引キャッシュは捨てる
  // (BoardFileIndexはfdを保持しないのでdeleteで安全)。戻り値は消えた行数の目安(索引があれば)
  clear(thread) {
    const file = BoardStore.fileFor(thread);
    const ix = this.indexes.get(file);
    const count = ix ? ix.count() : 0;
    this.indexes.delete(file);
    writeFileSync(join(this.dir, file), "");
    return { file, count };
  }
}
