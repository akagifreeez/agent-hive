// 共有ボード(blackboardのメッセージ面)。全エージェントの投稿が流れ、
// 他エージェントのループに「ボード新着」として注入される。
// v6: Boardごとにスレッド名を持ち、投稿にthreadタグを付ける(メインチャット="__main__")。
export class Board {
  constructor(bus = null, name = "__main__") {
    this.posts = [];
    this.seq = 0;
    this.bus = bus;
    this.name = String(name);
    this.waiters = []; // {from, resolve, timer}
  }

  post(from, text) {
    const post = { id: ++this.seq, from, text: String(text), at: Date.now(), thread: this.name };
    this.posts.push(post);
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
