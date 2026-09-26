
/* ================= 状態 ================= */
let selectedThread = "__main__";
let selectedAgent = null;
let ctxTab = "tasks";
let projectFilter = "";
const unread = {}; // thread => 件数
let lastState = null;
const NAMES = { alpha: "アルファ", beta: "ベータ", gamma: "ガンマ", delta: "デルタ", system: "システム", you: "あなた", lead: "リーダー" };
const threadOf = (a) => a?.thread ?? "__main__";
const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ================= 左ナビ ================= */
function renderNav(threads) {
  const el = $("nav-rooms");
  el.innerHTML = "";
  const rooms = [
    { id: "__main__", label: "🤝 メイン", sub: "リーダーと壁打ち・計画" },
    ...(threads ?? []).filter((t) => t.name !== "__main__").map((t) => ({ id: t.name, label: "🧵 " + t.name, sub: t.goal })),
  ];
  for (const t of rooms) {
    const d = document.createElement("div");
    d.className = "room" + (selectedThread === t.id ? " active" : "");
    d.innerHTML = `${escapeHtml(t.label)}<span class="sub">${escapeHtml(t.sub ?? "")}</span>`;
    if (unread[t.id]) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = unread[t.id];
      d.appendChild(b);
    }
    d.onclick = () => {
      selectedThread = t.id;
      unread[t.id] = 0;
      selectedAgent = null;
      projectFilter = t.id === "__main__" ? "" : t.id;
      renderAll();
    };
    el.appendChild(d);
  }
}

/* ================= 中央: 会話 ================= */
function currentMembers(state) {
  return Object.entries(state.live.agents).filter(([id, a]) => threadOf(a) === selectedThread);
}

function renderRoomHead(state) {
  const th = (state.live.threads ?? []).find((t) => t.name === selectedThread);
  if (selectedThread === "__main__") {
    $("room-title").textContent = "🤝 メイン(壁打ち)";
    $("room-goal").textContent = "リーダーと計画を固める。実行はサブスレッドへ";
  } else {
    $("room-title").textContent = "🧵 " + selectedThread;
    $("room-goal").textContent = th?.goal ?? "";
  }
  const mem = $("room-members");
  mem.innerHTML = "";
  let sumTokens = 0;
  let sumCost = 0;
  for (const [id, a] of currentMembers(state)) {
    sumTokens += a.tokens ?? 0;
    sumCost += a.costUsd ?? 0;
    const chip = document.createElement("span");
    chip.className = "member" + (selectedAgent === id ? " sel" : "");
    chip.innerHTML = `<span class="dot ${(a.status ?? "idle").replace(/\s/g, "")}"></span>${escapeHtml(a.displayName ?? NAMES[id] ?? id)}`;
    chip.title = `${a.status ?? "idle"} / turn ${a.turn ?? 0} — クリックで思考と活動`;
    chip.onclick = () => { selectedAgent = selectedAgent === id ? null : id; ctxTab = "agents"; renderAll(); };
    mem.appendChild(chip);
  }
  if (sumTokens > 0) {
    const s = document.createElement("span");
    s.className = "member";
    s.style.cursor = "default";
    s.innerHTML = `Σ ${sumTokens.toLocaleString()}tok / $${sumCost.toFixed(4)}`;
    s.title = "このスレッドのメンバーの合計消費";
    mem.appendChild(s);
  }
  const hint = $("composer-hint");
  hint.textContent = selectedThread === "__main__"
    ? "このメッセージは リーダー に届きます"
    : `このメッセージは ${selectedThread} のメンバー全員に届きます`;
  $("saytext").placeholder = selectedThread === "__main__" ? "リーダーへメッセージ" : `${selectedThread} のメンバーへメッセージ`;
}

function renderStream(state) {
  const stream = $("stream");
  const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
  stream.innerHTML = "";
  for (const p of state.live.board) {
    if ((p.thread ?? "__main__") !== selectedThread) continue;
    if (p.from === "system") {
      const d = document.createElement("div");
      d.className = "sysline";
      d.textContent = "⚙ " + p.text.replace(/^\[[^\]]+\]\s*/, "");
      d.title = p.text;
      stream.appendChild(d);
      continue;
    }
    const mine = p.from === "you";
    const d = document.createElement("div");
    d.className = "msg" + (mine ? " mine" : "");
    const who = document.createElement("div");
    who.className = "who " + p.from;
    who.textContent = (mine ? "あなた" : (NAMES[p.from] ?? p.from)) + (mine ? "" : ` #${p.id}`);
    const body = document.createElement("div");
    body.innerHTML = renderMarkdown(p.text);
    d.append(who, body);
    stream.appendChild(d);
  }
  if (nearBottom) stream.scrollTop = stream.scrollHeight;
}

function renderPerms(requests) {
  const el = $("permzone");
  el.innerHTML = "";
  for (const r of (requests ?? []).filter((x) => x.state === "pending")) {
    const d = document.createElement("div");
    d.className = "permcard";
    d.innerHTML = `<b>🔐 コマンドの承認要求 #${r.id}</b><div class="cmd">${escapeHtml(r.command)}</div>`;
    const ok = document.createElement("button");
    ok.className = "ok";
    ok.textContent = "承認";
    ok.onclick = () => decide(r.id, true);
    const no = document.createElement("button");
    no.textContent = "拒否";
    no.onclick = () => decide(r.id, false);
    d.append(ok, no);
    el.appendChild(d);
  }
}

/* ================= 右: 状況パネル ================= */
function renderCtx(state) {
  for (const b of document.querySelectorAll("#ctx-tabs .ct")) {
    b.classList.toggle("active", b.dataset.tab === ctxTab);
  }
  const body = $("ctx-body");
  body.innerHTML = "";
  if (ctxTab === "tasks") renderTasksTab(body, state);
  if (ctxTab === "agents") renderAgentsTab(body, state);
  if (ctxTab === "files") renderFilesTab(body);
}

function renderTasksTab(body, state) {
  const list = state.taskList ?? { open: [], claimed: [], done: [] };
  const inThread = selectedThread !== "__main__";
  const all = [...list.open, ...list.claimed, ...list.done].filter((t) => !inThread || (t.project || "") === selectedThread);
  const projects = [...new Set(all.map((t) => t.project || ""))].sort();

  if (inThread) {
    const s = document.createElement("div");
    s.className = "sec";
    s.textContent = `このスレッド(${selectedThread})のタスク`;
    body.appendChild(s);
  } else {
    const sel = document.createElement("select");
    sel.className = "filter";
    const opts = ["", ...projects, "__none__"];
    const cur = projectFilter;
    for (const p of opts) {
      const o = document.createElement("option");
      o.value = p;
      o.textContent = p === "" ? "すべてのプロジェクト" : p === "__none__" ? "(未分類)" : p;
      sel.appendChild(o);
    }
    sel.value = cur;
    if (!opts.includes(cur)) { projectFilter = ""; sel.value = ""; }
    sel.onchange = (e) => { projectFilter = e.target.value; renderCtx(lastState); };
    body.appendChild(sel);
  }

  const visible = all.filter((t) => inThread || projectFilter === "" || (projectFilter === "__none__" ? !t.project : (t.project || "") === projectFilter));
  const groups = inThread ? [["", ""]] : [...projects.map((p) => [p, p]), ["", "(未分類)"]];
  const secs = [
    ["open", "未着手", () => ({ label: "中止", action: "cancel" })],
    ["claimed", "作業中", () => ({ label: "解放", action: "release" })],
    ["done", "完了", () => ({ label: "再開", action: "reopen" })],
  ];
  for (const [proj, label] of groups) {
    const inProj = visible.filter((t) => (t.project || "") === proj);
    if (!inProj.length) continue;
    const ph = document.createElement("div");
    ph.className = "proj";
    ph.textContent = "◆ " + label;
    body.appendChild(ph);
    for (const [st, stLabel, btn] of secs) {
      const rows = inProj.filter((t) => t.state === st);
      if (!rows.length) continue;
      const sh = document.createElement("div");
      sh.className = "sec";
      sh.textContent = `${stLabel}(${rows.length})`;
      body.appendChild(sh);
      for (const t of rows) {
        const row = document.createElement("div");
        row.className = "taskrow";
        const id = document.createElement("span");
        id.className = "tid";
        id.textContent = t.id + (t.agent && !["auto", "you"].includes(t.agent) ? ` @${t.agent}` : "");
        id.title = t.summary;
        id.onclick = () => showTaskBody(t);
        const sum = document.createElement("span");
        sum.className = "tsum";
        sum.textContent = t.summary;
        sum.onclick = () => showTaskBody(t);
        const mv = document.createElement("button");
        mv.textContent = "移動";
        mv.title = "プロジェクトを付け替える";
        mv.onclick = async (e) => {
          e.stopPropagation();
          const p = prompt(`プロジェクト名(空欄で未分類):`, t.project || "");
          if (p === null) return;
          await taskAction({ action: "reproject", path: t.path, project: p });
        };
        const b = document.createElement("button");
        const spec = btn(t);
        b.textContent = spec.label;
        b.onclick = (e) => { e.stopPropagation(); taskAction({ action: spec.action, id: t.id, agent: t.agent }); };
        row.append(id, sum, mv, b);
        body.appendChild(row);
      }
    }
  }

  const form = document.createElement("div");
  form.id = "newtask";
  form.innerHTML = `
    <div class="sec">新しいタスクを投入${inThread ? `(project: ${escapeHtml(selectedThread)})` : ""}</div>
    <input id="nt-id" placeholder="task_id(空欄で自動採番)">
    ${inThread ? "" : '<input id="nt-project" placeholder="project(任意、例: cuda-compress)">'}
    <input id="nt-role" placeholder="role(impl/review等、空欄で誰でも)">
    <textarea id="nt-body" placeholder="何を / どう確認するか / 完了条件"></textarea>
    <button id="nt-add">投入(トークン消費なし)</button>`;
  body.appendChild(form);
  form.querySelector("#nt-add").onclick = createTask;
}

function renderAgentsTab(body, state) {
  const members = currentMembers(state);
  const sel = document.createElement("div");
  sel.className = "sec";
  sel.textContent = "このスレッドのエージェント(クリックで思考ログ)";
  body.appendChild(sel);
  for (const [id, a] of members) {
    const card = document.createElement("div");
    card.className = "agentcard" + (selectedAgent === id ? " sel" : "");
    const label = a.displayName ?? NAMES[id] ?? id;
    card.innerHTML = `<span class="nm">${escapeHtml(label)}</span><span class="st ${(a.status ?? "idle").replace(/\s/g, "")}">${escapeHtml(a.status ?? "idle")}</span>` +
      `<div class="meta">turn ${a.turn ?? 0}${a.lastTool ? ` / ${escapeHtml(a.lastTool)}` : ""}${a.tokens ? ` / ${a.tokens.toLocaleString()}tok / $${(a.costUsd ?? 0).toFixed(4)}` : ""}</div>`;
    card.onclick = () => { selectedAgent = selectedAgent === id ? null : id; renderCtx(lastState); };
    body.appendChild(card);
    if (selectedAgent === id) body.appendChild(renderAgentLog(a));
  }
  if (!members.length) {
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = "このスレッドにはまだエージェントがいません。";
    body.appendChild(h);
  }
}

function renderAgentLog(a) {
  const wrap = document.createElement("div");
  wrap.className = "alog";
  const icons = { think: "💭", say: "💬", tool: "🔧", result: "↳", status: "●", compact: "🗜" };
  if (a.live && (a.live.think || a.live.say)) {
    const d = document.createElement("div");
    d.className = "entry think";
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = "⚡";
    const t = document.createElement("span");
    t.className = "txt";
    t.textContent = (a.live.think ? "思考中: " + a.live.think.slice(-400) : "") + (a.live.say ? (a.live.think ? "\n" : "") + "生成中: " + a.live.say.slice(-400) : "");
    d.append(k, t);
    wrap.appendChild(d);
  }
  if (!a.log?.length && !(a.live && (a.live.think || a.live.say))) {
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = "まだ活動がありません。稼働すると思考(💭)・発言(💬)・ツール(🔧)・結果(↳)が流れます。";
    wrap.appendChild(h);
  }
  for (const e of a.log ?? []) {
    const d = document.createElement("div");
    d.className = "entry " + e.kind;
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = icons[e.kind] ?? "•";
    const t = document.createElement("span");
    t.className = "txt";
    t.textContent = e.text;
    d.append(k, t);
    wrap.appendChild(d);
  }
  requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
  return wrap;
}

async function renderFilesTab(body) {
  const files = lastState?.files ?? [];
  const ul = document.createElement("ul");
  ul.className = "files";
  for (const f of files) {
    const li = document.createElement("li");
    li.textContent = f;
    li.onclick = async () => {
      const r = await (await fetch("/api/file?path=" + encodeURIComponent(f))).json();
      let pre = body.querySelector("pre.fileview");
      if (pre) pre.remove();
      pre = document.createElement("pre");
      pre.className = "fileview";
      pre.textContent = r.content ?? "";
      body.appendChild(pre);
    };
    ul.appendChild(li);
  }
  body.appendChild(ul);
  const h = document.createElement("div");
  h.className = "hint";
  h.textContent = "ファイル名をクリックすると内容が下に表示されます。";
  body.appendChild(h);
}

async function showTaskBody(t) {
  const r = await (await fetch("/api/file?path=" + encodeURIComponent(t.path))).json();
  ctxTab = "tasks";
  const body = $("ctx-body");
  let pre = body.querySelector("pre.fileview");
  if (pre) pre.remove();
  pre = document.createElement("pre");
  pre.className = "fileview";
  pre.textContent = `# ${t.id}\n\n` + (r.content ?? "");
  body.appendChild(pre);
}

/* ================= アクション ================= */
async function taskAction(payload) {
  const r = await (await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })).json();
  if (r.error) alert(r.error);
  refresh();
}

async function createTask() {
  const id = $("nt-id")?.value.trim() ?? "";
  const projectInput = $("nt-project");
  const project = projectInput ? projectInput.value.trim() : selectedThread === "__main__" ? "" : selectedThread;
  const role = $("nt-role").value.trim();
  const body = $("nt-body").value.trim();
  if (!body) { alert("本文(何を/完了条件)を書いてください"); return; }
  const r = await (await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create", id, project, role, body }) })).json();
  if (r.error) { alert(r.error); return; }
  $("nt-id").value = "";
  if (projectInput) projectInput.value = "";
  $("nt-role").value = "";
  $("nt-body").value = "";
  refresh();
}

async function decide(id, approve) {
  await fetch("/api/permission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, approve }) });
  refresh();
}

async function sendSay() {
  const el = $("saytext");
  const text = el.value.trim();
  if (!text && !pendingImage) return;
  el.value = "";
  if (text.startsWith("/")) { handleCommand(text); return; }
  const img = pendingImage;
  pendingImage = null;
  if (img) {
    // 画像添付: 保存→メンバーへマルチモーダルで届く。テキストがあれば本文としても送る
    await fetch("/api/attach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread: selectedThread === "__main__" ? null : selectedThread, dataUrl: img.dataUrl, note: text }) });
    if (text) await fetch("/api/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, thread: selectedThread === "__main__" ? null : selectedThread }) });
    refresh();
    return;
  }
  await fetch("/api/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, thread: selectedThread === "__main__" ? null : selectedThread }) });
}

// スラッシュコマンド: 入力欄からローカル操作(エージェントを起こさない)
async function handleCommand(text) {
  const [cmd] = text.slice(1).split(/\s+/);
  const post = (t) => {
    const d = document.createElement("div");
    d.className = "msg";
    d.style.maxWidth = "100%";
    d.innerHTML = `<div class="who">⌘ コマンド</div>`;
    const body = document.createElement("div");
    body.textContent = t;
    d.appendChild(body);
    $("stream").appendChild(d);
    $("stream").scrollTop = $("stream").scrollHeight;
  };
  if (cmd === "help") {
    post("/tasks 現在のタスク一覧\n/usage エージェント別の消費\n/threads スレッド一覧\n/session save <名前> 状態を保存\n/session load <名前> 状態を復元(再起動で反映)\n/sessions 保存済み一覧\n/help この一覧");
  } else if (cmd === "session" || cmd === "sessions") {
    const arg = text.slice(("/" + cmd).length).trim();
    const [op, ...rest] = arg.split(/\s+/);
    const name = rest.join("-");
    if (!op || op === "list") {
      const r = await (await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "list" }) })).json();
      post(r.list?.length ? "保存済みセッション:\n" + r.list.join("\n") : "保存済みセッションはありません(/session save <名前> で保存)");
    } else if (op === "save" || op === "load") {
      if (!name) { post("セッション名を指定してください"); return; }
      const r = await (await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: op, name }) })).json();
      post(r.error ? `エラー: ${r.error}` : `セッション ${name} を${op === "save" ? "保存" : "復元"}しました${op === "load" ? "(反映には再起動が必要です)" : ""}`);
    }
  } else if (cmd === "tasks") {
    if (!lastState) return post("まだ状態を取得していません");
    const l = lastState.taskList;
    const rows = [...l.open, ...l.claimed, ...l.done]
      .filter((t) => selectedThread === "__main__" || (t.project || "") === selectedThread)
      .map((t) => `${t.state}: ${t.id}${t.project ? ` (${t.project})` : ""}`);
    post(rows.length ? rows.join("\n") : "タスクはありません");
  } else if (cmd === "usage") {
    if (!lastState) return post("まだ状態を取得していません");
    const rows = Object.entries(lastState.live.agents).map(([id, a]) =>
      `${a.displayName ?? id}: ${a.status} / ${a.tokens?.toLocaleString() ?? 0}tok / $${(a.costUsd ?? 0).toFixed(4)}`);
    post(rows.length ? rows.join("\n") : "usageはまだありません");
  } else if (cmd === "threads") {
    const ts = lastState?.live.threads ?? [];
    post(ts.map((t) => `${t.name} — ${t.goal}`).join("\n") || "開いているスレッドはありません");
  } else {
    post(`不明なコマンド: ${cmd}(/help で一覧)`);
  }
}

/* ================= 全体描画 ================= */
function renderAll() {
  if (!lastState) return;
  renderNav(lastState.live.threads);
  renderRoomHead(lastState);
  renderStream(lastState);
  renderPerms(lastState.live.requests);
  renderCtx(lastState);
  $("nav-foot").textContent = lastState.live.scenario ? `${lastState.live.scenario.name} [${lastState.live.scenario.phase}]` : "";
}

async function refresh() {
  lastState = await (await fetch("/api/state")).json();
  renderAll();
}

let refreshQueued = false;
function refreshSoon() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => { refreshQueued = false; refresh(); }, 600);
}

/* ================= イベント配線 ================= */
const es = new EventSource("/events");
es.onmessage = (e) => {
  const { type, payload } = JSON.parse(e.data);
  if (type === "board") {
    const th = payload.thread ?? "__main__";
    if (th === selectedThread) {
      refreshSoon(); // デバウンス付きで全再描画(ストリームは毎回全件から組み直す)
    } else {
      unread[th] = (unread[th] ?? 0) + 1;
      if (lastState) renderNav(lastState.live.threads);
    }
    return;
  }
  if (["agent.turn", "agent.delta", "tool.call", "tool.result", "agent.status", "agent.spawned", "thread.opened",
       "task.claimed", "task.finished", "task.created", "task.released", "task.cancelled", "task.autoResolved",
       "scenario.started", "scenario.finished"].includes(type)) {
    refreshSoon();
  }
};
$("saybtn").onclick = sendSay;
$("saytext").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) sendSay(); });
// 画像添付: 📎ボタン or 入力欄へのペースト。dataURL化してからサーバーへ保存させる
let pendingImage = null;
const attachFile = document.getElementById("attachfile");
$("attachbtn").onclick = () => attachFile.click();
attachFile.onchange = () => {
  const f = attachFile.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { pendingImage = { dataUrl: reader.result, name: f.name }; $("composer-hint").textContent = `添付: ${f.name} — 送信で画像ごと届きます`; };
  reader.readAsDataURL(f);
};
$("saytext").addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
  if (!item) return;
  const f = item.getAsFile();
  if (!f) return;
  e.preventDefault();
  const reader = new FileReader();
  reader.onload = () => { pendingImage = { dataUrl: reader.result, name: "paste.png" }; $("composer-hint").textContent = `添付: 画像(ペースト) — 送信で画像ごと届きます`; };
  reader.readAsDataURL(f);
});
for (const b of document.querySelectorAll("#ctx-tabs .ct")) {
  b.onclick = () => { ctxTab = b.dataset.tab; renderCtx(lastState); };
}
refresh();
setInterval(refresh, 5000);
