
// ============ モックデータ ============
const S = {
  rooms: [
    { id: "__main__", name: "🤝 メイン", goal: "リーダーと壁打ち・計画", pinned: true },
    { id: "cuda", name: "🧵 cuda-compress", goal: "CUDA圧縮ツールの実装と検証", prog: "3/9", unread: 0 },
    { id: "cal", name: "🧵 calendar-app", goal: "カレンダーMVPの実装", prog: "2/4", unread: 2 },
  ],
  sel: "__main__",
  agents: {
    lead: { name: "リーダー", status: "idle", turn: 0, thread: "__main__" },
    "cuda-alpha": { name: "アルファ", status: "working", turn: 4, thread: "cuda" },
    "cuda-beta": { name: "ベータ", status: "idle", turn: 6, thread: "cuda" },
    "cuda-gamma": { name: "ガンマ", status: "done", turn: 8, thread: "cuda" },
    "cal-alpha": { name: "アルファ", status: "working", turn: 2, thread: "cal" },
  },
  board: {
    "__main__": [
      { from: "you", text: "cuda-compressの続き、どうなってる?" },
      { from: "lead", text: "実装は9割完了です。残るはレビューとベンチだけなので、スレッドを開いて仕上げます。" },
    ],
    "cuda": [
      { from: "system", text: "[マージ] アルファ がタスク impl-compress の成果を main へ取り込みました" },
      { from: "cuda-alpha", text: "圧縮カーネルを実装しました。LZ77風トークンで 2.1x 出ています。\n\n- 探索は共有メモリのハッシュテーブル\n- ブロック内逐次(ワープリーダー)" },
      { from: "cuda-beta", text: "検証します。ラウンドトリップとスループットを見ます。" },
    ],
    "cal": [
      { from: "cal-alpha", text: "カレンダーMVPの骨組みができました。月表示とイベント追加が動きます。" },
      { from: "cal-beta", text: "レビュー指摘: 月跨ぎの表示で境界バグの疑い。修正タスクを起票しました。" },
    ],
  },
  tasks: {
    cuda: [
      { id: "impl-decompress", st: "done", sum: "解凍カーネル実装" },
      { id: "impl-tests", st: "open", sum: "ベンチマーク追加" },
    ],
    cal: [
      { id: "cal-mvp", st: "done", sum: "月表示とイベント追加" },
      { id: "cal-review", st: "claimed", agent: "cal-beta", sum: "月跨ぎ表示の修正確認" },
    ],
  },
  logs: {
    "cuda-alpha": [
      { k: "think", t: "ハッシュテーブルの衝突処理を線形探索からバケットに変えよう…" },
      { k: "tool", t: "write_file src/compress.cu (148行)" },
      { k: "res", t: "書き込み完了" },
      { k: "tool", t: "bash nvcc -O2 -arch=sm_89 compress.cu" },
      { k: "res", t: "exit=0" },
      { k: "say", t: "圧縮率2.1xを確認。ベンチに回します" },
    ],
    "cuda-beta": [
      { k: "think", t: "ラウンドトリップ検証の境界条件を列挙…" },
      { k: "tool", t: "bash node --test" },
      { k: "res", t: "pass 6" },
    ],
    lead: [],
  },
};
let sel = "__main__";
let selAgent = null;
let ctxTab = "tasks";

const $ = (id) => document.getElementById(id);
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ============ 描画 ============
function renderRooms() {
  const el = $("rooms");
  el.innerHTML = "";
  for (const r of S.rooms) {
    const t = S.tasks[r.id];
    const prog = t ? `${t.filter((x) => x.st === "done").length}/${t.length} 完了` : "";
    const unread = r.unread ?? 0;
    const d = document.createElement("div");
    d.className = "room" + (sel === r.id ? " active" : "");
    d.innerHTML = `<span class="rname">${esc(r.name)}</span><span class="rsub">${esc(r.goal || "")}${prog ? " · " + prog : ""}</span>`;
    if (unread) { const b = document.createElement("span"); b.className = "badge"; b.textContent = unread; d.appendChild(b); }
    d.onclick = () => { sel = r.id; r.unread = 0; render(); };
    el.appendChild(d);
  }
}

function members(roomId) {
  return Object.entries(S.agents).filter(([id, a]) => a.thread === roomId);
}

function renderRoom() {
  const r = S.rooms.find((x) => x.id === sel);
  $("rt-name").textContent = r ? r.name : "";
  $("rt-goal").textContent = r ? (r.goal || "") : "";
  const mem = $("members");
  mem.innerHTML = "";
  for (const [id, a] of Object.entries(S.agents).filter(([id, a]) => a.thread === sel)) {
    const c = document.createElement("span");
    c.className = "chip" + (selAgent === id ? " sel" : "");
    c.innerHTML = `<span class="dot ${a.status}"></span>${esc(a.name)}`;
    c.title = `${a.status} / turn ${a.turn}`;
    c.onclick = () => { selAgent = id; render(); };
    mem.appendChild(c);
  }
  const h = $("hint");
  h.textContent = sel === "__main__" ? "このメッセージは リーダー に届きます" : `このメッセージは ${sel} のメンバー全員に届きます`;
  $("rt-close").style.display = sel === "__main__" ? "none" : "";
}

function renderStream() {
  const st = $("stream");
  const posts = S.board[sel] ?? [];
  st.innerHTML = "";
  for (const p of posts) {
    if (p.from === "system") {
      const d = document.createElement("div");
      d.className = "sysline";
      d.textContent = "⚙ " + p.text.replace(/^\[[^\]]+\]\s*/, "");
      d.title = p.text;
      st.appendChild(d);
      continue;
    }
    const mine = p.from === "you";
    const d = document.createElement("div");
    d.className = "msg" + (mine ? " mine" : "");
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = mine ? "あなた" : p.name;
    const body = document.createElement("div");
    body.textContent = p.text;
    d.append(who, body);
    st.appendChild(d);
  }
  st.scrollTop = st.scrollHeight;
}

function renderTasks() {
  const body = $("ctx-body");
  if (ctxTab !== "tasks") return;
  body.innerHTML = "";
  const list = S.tasks[sel];
  if (!list) { const h = document.createElement("div"); h.className = "hintbox"; h.textContent = "この部屋にはタスクがありません(メインは壁打ち専用)"; body.appendChild(h); return; }
  const secs = [["done", "完了"], ["claimed", "作業中"], ["open", "未着手"]];
  for (const [st, label] of secs) {
    const rows = list.filter((t) => t.st === st);
    if (!rows.length) continue;
    const sh = document.createElement("div");
    sh.className = "sec";
    sh.textContent = `${label}(${rows.length})`;
    body.appendChild(sh);
    for (const t of rows) {
      const row = document.createElement("div");
      row.className = "taskrow";
      const id = document.createElement("span");
      id.className = "tid";
      id.textContent = t.id;
      const sum = document.createElement("span");
      sum.className = "tsum";
      sum.textContent = t.sum;
      sum.title = t.sum;
      const b = document.createElement("button");
      if (st === "open") { b.textContent = "中止"; b.onclick = () => { t.st = "done"; render(); }; }
      else if (st === "claimed") { b.textContent = "解放"; b.onclick = () => { t.st = "open"; render(); }; }
      else { b.textContent = "再開"; b.onclick = () => { t.st = "open"; render(); }; }
      row.append(id, sum, b);
      body.appendChild(row);
    }
  }
  const form = document.createElement("div");
  form.id = "newtask";
  form.innerHTML = `<div class="sec">新しいタスクを投入</div>
    <input placeholder="task_id(空欄で自動)">
    <textarea placeholder="何を / 完了条件"></textarea>
    <button>投入(トークン消費なし)</button>`;
  form.querySelector("button").onclick = () => {
    const ta = form.querySelector("textarea");
    if (!ta.value.trim()) { alert("本文を入力してください"); return; }
    const id = "user-" + Math.random().toString(36).slice(2, 6);
    S.tasks[sel].push({ id, st: "open", sum: ta.value.trim().slice(0, 40) });
    ta.value = "";
    render();
  };
  body.appendChild(form);
}

function renderAgents() {
  const body = $("ctx-body");
  body.innerHTML = "";
  const mem = members(sel);
  const sh = document.createElement("div");
  sh.className = "sec";
  sh.textContent = "この部屋のエージェント(クリックで思考ログ)";
  body.appendChild(sh);
  for (const [id, a] of mem) {
    const card = document.createElement("div");
    card.className = "agentcard" + (selAgent === id ? " sel" : "");
    card.innerHTML = `<span class="nm">${esc(a.name)}</span><span class="st ${a.status}">${a.status}</span><div class="meta">turn ${a.turn} / ${a.tokens ?? "1,234"}tok</div>`;
    card.onclick = () => { selAgent = id; render(); };
    body.appendChild(card);
    if (selAgent === id) {
      const log = document.createElement("div");
      log.className = "alog";
      const lines = S.logs[id] ?? [
        { k: "think", t: "設計に沿って実装を進める。まず境界条件を確認…" },
        { k: "tool", t: "bash node --test" },
        { k: "res", t: "pass 6" },
      ];
      for (const l of lines) {
        const d = document.createElement("div");
        d.className = "l " + l.k;
        d.textContent = ({ think: "💭 ", say: "💬 ", tool: "🔧 ", res: "  ⎿ " }[l.k] ?? "") + l.t;
        log.appendChild(d);
      }
      body.appendChild(log);
    }
  }
}

function renderFiles() {
  const body = $("ctx-body");
  body.innerHTML = "";
  const sh = document.createElement("div");
  sh.className = "sec";
  sh.textContent = "ワークスペースのファイル";
  body.appendChild(sh);
  for (const f of ["docs/design.md", "src/compress.cu", "tests/rt.test.mjs", "todo.js"]) {
    const li = document.createElement("div");
    li.className = "taskrow";
    li.textContent = "📄 " + f;
    li.style.cursor = "pointer";
    li.onclick = () => {
      const pre = document.createElement("pre");
      pre.className = "fv";
      pre.textContent = "// " + f + " の内容(モック)\n…";
      body.appendChild(pre);
    };
    body.appendChild(li);
  }
}

function renderTerm() {
  const body = $("ctx-body");
  body.innerHTML = "";
  const h = document.createElement("div");
  h.className = "hintbox";
  h.textContent = "ワークスペース直下でコマンド実行(モック: ダミー応答)";
  body.appendChild(h);
  const out = document.createElement("pre");
  out.className = "fv";
  out.textContent = "$ node --test\npass 6\n";
  const input = document.createElement("input");
  input.className = "filter";
  input.placeholder = "コマンド…";
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !input.value.trim()) return;
    out.textContent += "\n$ " + input.value + "\n(モック: 実行はシミュレーション)\n";
    input.value = "";
    out.scrollTop = out.scrollHeight;
  });
  body.appendChild(input);
  body.appendChild(out);
}

function renderCtx() {
  for (const b of document.querySelectorAll(".ct")) b.classList.toggle("active", b.dataset.tab === ctxTab);
  const body = $("ctx-body");
  body.innerHTML = "";
  if (ctxTab === "tasks") renderTasks();
  else if (ctxTab === "agents") renderAgents();
  else if (ctxTab === "files") renderFiles();
  else renderTerm();
}

function render() {
  renderRooms();
  renderRoom();
  renderStream();
  renderCtx();
}

// タブ・部屋切替
for (const b of document.querySelectorAll(".ct")) {
  b.onclick = () => { ctxTab = b.dataset.tab; renderCtx(); };
}
$("send").onclick = () => {
  const v = $("say").value.trim();
  if (!v) return;
  $("say").value = "";
  (S.board[sel] ??= []).push({ from: "you", name: "あなた", text: v });
  // モック: 相手が2秒後に応答する演出
  setTimeout(() => {
    const responder = sel === "__main__" ? "lead" : members(sel)[0]?.id;
    const name = S.agents[responder]?.name ?? "リーダー";
    (S.board[sel] ??= []).push({ from: responder, name, text: "了解しました。進めてきます。" });
    renderStream();
  }, 800);
  renderStream();
};
$("say").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("send").click(); } });
$("rt-close").onclick = () => {
  if (sel === "__main__") return;
  const r = S.rooms.find((x) => x.id === sel);
  if (confirm(`スレッド ${r.name} を閉じますか?(ログは残ります)`)) {
    S.rooms = S.rooms.filter((x) => x.id !== sel);
    sel = "__main__";
    render();
  }
};
$("newthread").onclick = () => {
  const name = prompt("スレッド名(英数字):");
  if (!name) return;
  const goal = prompt("目標:") ?? "";
  S.rooms.push({ id: name, name: "🧵 " + name, goal });
  sel = name;
  S.agents[name + "-alpha"] = { name: "アルファ", status: "idle", thread: name };
  render();
};

render();
