// 共有ボード(blackboardのメッセージ面)。全エージェントの投稿が流れ、
// 他エージェントのループに「ボード新着」として注入される。
// v6: Boardごとにスレッド名を持ち、投稿にthreadタグを付ける(メインチャット="__main__")。
// v6.1: persistPathを指定すると投稿をJSONL追記し、起動時にリプレイする(チャットの復帰)。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export class Board {
  constructor(bus = null, name = "__main__", persistPath = null) {
    this.posts = [];
    this.seq = 0;
    this.bus = bus;
    this.name = String(name);
    this.persistPath = persistPath;
    this.waiters = []; // {from, resolve, timer}
    if (persistPath) this.replay();
  }

  // 保存済み投稿の復元(壊れた行は飛ばす)
  replay() {
    try {
      for (const line of readFileSync(this.persistPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line);
          if (p && typeof p.id === "number") this.posts.push(p);
        } catch {}
      }
      this.seq = this.posts.length ? this.posts[this.posts.length - 1].id : 0;
    } catch {
      // ファイルが無ければ初回
    }
  }

  post(from, text) {
    const post = { id: ++this.seq, from, text: String(text), at: Date.now(), thread: this.name };
    this.posts.push(post);
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

  since(id) {
    return this.posts.filter((p) => p.id > (id ?? 0));
  }

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
