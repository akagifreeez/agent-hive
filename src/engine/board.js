// 共有ボード(blackboardのメッセージ面)。全エージェントの投稿が流れ、
// 他エージェントのループに「ボード新着」として注入される。
// v6: Boardごとにスレッド名を持ち、投稿にthreadタグを付ける(メインチャット="__main__")。
// v6.1: persistPathを指定すると投稿をJSONL追記し、起動時にリプレイする(チャットの復帰)。
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readBoardTail } from "./boardstore.js";

/**
 * ボード投稿1件の契約。JSONL永続化・UI配信・LLM注入の全経路でこの形を保つ。
 * @typedef {Object} Post
 * @property {number} id ボード内の連番(既読管理・頁送りの基準)
 * @property {string} from 投稿者(エージェントid / "system" / "you")
 * @property {string} text 本文
 * @property {number} at 投稿時刻(エポックms)
 * @property {string} thread スレッド名(メイン="__main__")
 */

// メモリに保持する投稿の上限(長時間ランでの肥大止め)。全文はJSONLに残り、
// UIの頁送り(BoardStore)がディスクから拾う。gather_contextの上限100に十分な量
const POSTS_KEEP = 1000;

export class Board {
  constructor(bus = null, name = "__main__", persistPath = null) {
    /** @type {Post[]} */
    this.posts = [];
    this.seq = 0;
    this.bus = bus;
    this.name = String(name);
    this.persistPath = persistPath;
    this.waiters = []; // {from, resolve, timer}
    if (persistPath) this.replay();
  }

  // 保存済み投稿の復元。起動を速く保つため末尾だけ読む(全文はディスクに残り、UIの頁送りが拾う)
  replay() {
    try {
      this.posts = readBoardTail(this.persistPath);
      this.seq = this.posts.length ? this.posts[this.posts.length - 1].id : 0;
    } catch {
      // ファイルが無ければ初回
    }
  }

  // メモリ内の投稿を空にする(UIからの履歴クリア用。ディスク/索引はBoardStore.clearが担当)。
  // seqも0へ戻す(ファイルが空になったため、次の投稿からidを採番し直す)
  clearMemory() {
    this.posts = [];
    this.seq = 0;
  }

  /**
   * 投稿を1件追加して全経路(メモリ/JSONL/bus/waiters)へ流す
   * @param {string} from
   * @param {string} text
   * @returns {Post}
   */
  post(from, text) {
    const post = { id: ++this.seq, from, text: String(text), at: Date.now(), thread: this.name };
    this.posts.push(post);
    if (this.posts.length > POSTS_KEEP) this.posts.splice(0, this.posts.length - POSTS_KEEP);
    if (this.persistPath) {
      try {
        mkdirSync(dirname(this.persistPath), { recursive: true });
        appendFileSync(this.persistPath, JSON.stringify(post) + "\n");
      } catch {
        // 永続化の失敗で会話を止めない
      }
    }
    this.bus?.emit("board", post);
    for (const w of this.waiters.splice(0)) {
      if (w.from === from) { this.waiters.push(w); continue; } // 自分の投稿は起こさない
      clearTimeout(w.timer);
      w.resolve(post);
    }
    return post;
  }

  /**
   * 既読位置以降の投稿を返す(ボード新着注入の正。二重配信は呼び出し側のseen管理で防ぐ)
   * @param {number|null} id
   * @returns {Post[]}
   */
  since(id) {
    return this.posts.filter((p) => p.id > (id ?? 0));
  }

  /** @returns {number} */
  lastId() {
    return this.posts.length ? this.posts[this.posts.length - 1].id : 0;
  }

  // 自分以外の新着投稿を待つ。タイムアウトで null。
  wait(from, timeoutMs) {
    return new Promise((resolve) => {
      const entry = { from, resolve, timer: null };
      entry.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== entry);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }
}

// UIやログへの全面通知に使う最小のイベントバス
export class Bus {
  constructor() {
    this.listeners = new Map();
  }
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  emit(type, payload) {
    for (const fn of this.listeners.get(type) ?? []) {
      try { fn(payload); } catch (e) { console.error("[bus] listener error", e); }
    }
  }
}
