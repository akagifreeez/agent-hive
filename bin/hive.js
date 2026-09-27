#!/usr/bin/env node
// hive CLI: 稼働中のagent-hive(UIサーバー)をターミナルから操作する依存ゼロのクライアント。
// デスクトップ本体がトレイに常駐している前提で、SSHや別ターミナルから
// 見る/話す/タスクを見る/停止する をできるようにするもの。
// 使い方: node bin/hive.js <コマンド> [--port 7789] [--thread 名前]
import { stdin, stdout, argv, env, exit } from "node:process";
import { createInterface } from "node:readline";

const ACCENT = env.NO_COLOR ? "" : "\x1b[38;5;209m";
const DIM = env.NO_COLOR ? "" : "\x1b[2m";
const BOLD = env.NO_COLOR ? "" : "\x1b[1m";
const RESET = env.NO_COLOR ? "" : "\x1b[0m";

const HELP = `agent-hive CLI — 稼働中のhiveを端末から操作する

使い方: node bin/hive.js <コマンド> [引数] [--port N] [--thread 名前]

  status                    稼働状態(モデル/タスク/スレッド/エージェント)を一覧
  threads                   スレッド一覧(フォルダ・停止中表示つき)
  tasks [open|claimed|done] タスク一覧(省略時は未着手+作業中)
  say <テキスト>            メインチャットへ発言(--thread でスレッド指定)
  board [-n 件数]           最近のボード投稿を見る(既定30件)
  watch                     ボードの新着をリアルタイムで流し見(Ctrl+Cで終了)
  chat [--thread 名前]      対話モード。入力した行がそのまま発言になる
  feedback <taskId> <コメント>  マージ済み差分への修正依頼を送る
  pause <スレッド> / resume <スレッド>  スレッドの一時停止/再開
  usage                     トークン消費の直近サマリ

  --port N                  UIサーバーのポート(既定: HIVE_UI_PORT または 7789)
`;

function parseGlobalArgs(argv) {
  const opts = { port: Number(env.HIVE_UI_PORT) || 7789, thread: null, limit: 30 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--thread" || a === "-t") opts.thread = argv[++i];
    else if (a === "-n") opts.limit = Math.max(1, Number(argv[++i]) || 30);
    else rest.push(a);
  }
  return { opts, rest };
}

function base(port) {
  return `http://127.0.0.1:${port}`;
}

async function api(port, path, body = null) {
  let res;
  try {
    res = await fetch(base(port) + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  } catch {
    console.error(`hive本体に接続できません(${base(port)})。先に desktop(npm run desktop)か node src/index.js --chat で起動してください。`);
    exit(1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`エラー: ${data.error ?? `HTTP ${res.status}`}`);
    exit(1);
  }
  return data;
}

function hue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// UI本体と同じ発想(IDハッシュ→色)で、256色パレットから投稿者色を選ぶ
const PALETTE = [209, 39, 75, 111, 147, 183, 219, 214, 178, 142, 106, 152];
function nameColor(id) {
  if (env.NO_COLOR) return "";
  return `\x1b[38;5;${PALETTE[hue(id) % PALETTE.length]}m`;
}

function printPost(p, withThread = false) {
  const from = p.from === "you" ? "あなた" : p.from;
  const who = p.from === "you" ? `${BOLD}あなた${RESET}` : `${nameColor(p.from)}${from}${RESET}`;
  const tag = withThread ? ` ${DIM}@${p.thread ?? "__main__"}${RESET}` : "";
  const time = p.at ? new Date(p.at).toTimeString().slice(0, 5) : "";
  console.log(`${DIM}${time}${RESET} ${who}${tag} ${String(p.text).replace(/\s+$/, "")}`);
}

function fmtThreads(threads) {
  for (const t of threads) {
    const paused = t.paused ? ` ${ACCENT}[停止中]${RESET}` : "";
    const goal = t.goal ? ` ${DIM}${t.goal}${RESET}` : "";
    console.log(`  ${BOLD}#${t.name}${RESET}${t.folder ? ` (${t.folder})` : ""}${paused}${goal}`);
  }
}

function fmtTasks(list, only) {
  const secs = only
    ? [[only, { open: "未着手", claimed: "作業中", done: "完了" }[only] ?? only]]
    : [["claimed", "作業中"], ["open", "未着手"]];
  for (const [key, label] of secs) {
    const rows = list[key] ?? [];
    console.log(`${ACCENT}${label} (${rows.length})${RESET}`);
    for (const t of rows) {
      const acc = t.acceptance ? ` ${DIM}[基準: ${t.acceptance}]${RESET}` : "";
      console.log(`  ${DIM}${t.id}${t.agent ? ` @${t.agent}` : ""}${RESET} ${t.summary}${acc}`);
    }
  }
}

async function cmdStatus(o) {
  const s = await api(o.port, "/api/state");
  const tl = s.taskList ?? { open: [], claimed: [], done: [] };
  const agents = Object.entries(s.live?.agents ?? {});
  const working = agents.filter(([, a]) => a.status === "working").length;
  console.log(`${BOLD}hive${RESET} port=${o.port} model=${s.model?.name ?? "?"} perm=${s.live?.permMode ?? "-"}`);
  console.log(`タスク: 未着手${tl.open.length} / 作業中${tl.claimed.length} / 完了${tl.done.length}  エージェント: 稼働${working}/${agents.length}`);
  console.log(`${ACCENT}スレッド (${(s.live?.threads ?? []).length})${RESET}`);
  fmtThreads(s.live?.threads ?? []);
  const merges = s.live?.merges ?? [];
  if (merges.length) {
    console.log(`${ACCENT}直近のマージ${RESET}`);
    for (const m of merges.slice(0, 5)) console.log(`  ${DIM}${m.taskId}${RESET} ${m.summary ?? ""} ${DIM}by ${m.agent}${RESET}`);
  }
}

async function cmdTasks(o, only) {
  const s = await api(o.port, "/api/state");
  fmtTasks(s.taskList, only);
}

async function cmdBoard(o) {
  const s = await api(o.port, "/api/state");
  let posts = [...(s.live?.board ?? [])].sort((a, b) => a.id - b.id);
  if (o.thread) posts = posts.filter((p) => (p.thread ?? "__main__") === o.thread);
  const shown = posts.slice(-o.limit);
  for (const p of shown) printPost(p, !o.thread);
  if (!shown.length) console.log("(投稿なし)");
}

async function cmdSay(o, text) {
  const body = { text: text.join(" ") };
  if (o.thread) body.thread = o.thread;
  if (!body.text.trim()) {
    console.error("言うことがありません。hive say \"テキスト\" の形で指定してください。");
    exit(1);
  }
  await api(o.port, "/api/say", body);
  console.log(`送信しました${o.thread ? ` (${o.thread})` : ""}。`);
}

async function cmdFeedback(o, args) {
  const taskId = args[0];
  const comment = args.slice(1).join(" ");
  if (!taskId || !comment.trim()) {
    console.error("使い方: hive feedback <taskId> <コメント>");
    exit(1);
  }
  const r = await api(o.port, "/api/merge-feedback", { taskId, comment });
  console.log(`起票: ${r.id} (${r.thread})`);
}

async function cmdPause(o, args, paused) {
  const project = args[0] ?? o.thread;
  if (!project) {
    console.error("使い方: hive pause <スレッド名>(省略時は --thread)");
    exit(1);
  }
  const r = await api(o.port, "/api/pause", { project, paused });
  console.log(`${r.name} を${r.paused ? "停止" : "再開"}しました。`);
}

function openEvents(port, onEvent) {
  const controller = new AbortController();
  const run = async () => {
    let res;
    try {
      res = await fetch(`${base(port)}/events`, { signal: controller.signal });
    } catch {
      console.error(`hive本体に接続できません(${base(port)})。先に起動してください。`);
      exit(1);
    }
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {}
      }
    }
  };
  void run();
  return controller;
}

function eventLabel(type, p) {
  if (type === "board") return null; // printPostで出す
  if (type === "task.claimed") return `${DIM}[claim]${RESET} ${p.agent} → ${p.taskId}`;
  if (type === "task.finished") return `${DIM}[完了]${RESET} ${p.agent} の ${p.taskId}`;
  if (type === "task.created") return `${DIM}[起票]${RESET} ${p.taskId}`;
  if (type === "merge.completed") return `${ACCENT}[マージ]${RESET} ${p.taskId} by ${p.agent} ${p.summary ?? ""}`;
  if (type === "thread.paused") return `${ACCENT}[${p.paused ? "停止" : "再開"}]${RESET} ${p.name}`;
  if (type === "agent.status") return `${DIM}[${p.agent}]${RESET} ${p.status}`;
  return null;
}

async function watch(o, interactive) {
  if (interactive) {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.setPrompt(`${ACCENT}>${RESET} `);
    rl.prompt();
    rl.on("line", async (line) => {
      const text = line.trim();
      if (!text) return rl.prompt();
      if (text === "exit" || text === ":q") { rl.close(); return; }
      await api(o.port, "/api/say", { text, thread: o.thread });
      rl.prompt();
    });
    rl.on("close", () => {
      console.log(`${DIM}終了します。hive本体は動き続けています。${RESET}`);
      exit(0);
    });
  }
  const thread = o.thread;
  openEvents(o.port, (ev) => {
    const { type, payload: p } = ev;
    if (type === "board") {
      if (p.from === "you" && interactive) return; // 入力エコーを二重表示しない
      if (thread && (p.thread ?? "__main__") !== thread) return;
      printPost(p, !thread);
      if (interactive) stdout.write(`${ACCENT}>${RESET}`);
      return;
    }
    const label = eventLabel(type, p);
    if (label && (!thread || !type.startsWith("task.") || thread === "__main__")) {
      console.log(label);
      if (interactive) stdout.write(`${ACCENT}>${RESET}`);
    }
  });
}

async function cmdUsage(o) {
  const r = await api(o.port, "/api/usage");
  const hist = r.usage ?? [];
  const last = hist.at(-1);
  if (!last) return console.log("消費記録はまだありません。");
  const fmt = (u) => u ? `${(u.promptTokens ?? 0).toLocaleString()}+${(u.completionTokens ?? 0).toLocaleString()}tok${u.costUsd ? `($${u.costUsd.toFixed(3)})` : ""}` : "-";
  console.log(`直近: ${last.agent ?? "-"} (${last.endedBy ?? "-"}) ${fmt(last.totals)}`);
  console.log(`${DIM}履歴${hist.length}件。詳細は GET /api/usage${RESET}`);
}

async function cmdTaskAction(o, args, action) {
  const id = args[0];
  if (!id) {
    console.error(`使い方: hive tasks ${action} <taskId>`);
    exit(1);
  }
  const r = await api(o.port, "/api/tasks", { action, id });
  if (r && r.error) {
    console.error(r.error);
    exit(1);
  }
  console.log(`${id} を${{ cancel: "中止", release: "解放", reopen: "再open" }[action]}しました。`);
  return r;
}

async function cmdAudit(o) {
  const r = await api(o.port, `/api/audit?limit=${o.limit}`);
  const audit = r.audit ?? [];
  console.log(`${ACCENT}監査台帳 ${audit.length}件${RESET}`);
  for (const e of audit) {
    const at = e.at ? String(e.at).replace("T", " ").slice(0, 19) : "-";
    console.log(`  ${DIM}${at}${RESET} ${BOLD}${e.tool ?? e.name ?? "?"}${RESET} ${DIM}${e.agent ?? ""}${RESET} ${JSON.stringify(e.args ?? e.input ?? {})}`.slice(0, 200));
  }
  if (!audit.length) console.log("(記録なし)");
}

async function main() {
  const { opts, rest } = parseGlobalArgs(argv.slice(2));
  const [cmd, ...args] = rest;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    return;
  }
  if (cmd === "status") return cmdStatus(opts);
  if (cmd === "threads") {
    const s = await api(opts.port, "/api/state");
    return fmtThreads(s.live?.threads ?? []);
  }
  if (cmd === "tasks" && args[0] === "cancel") return cmdTaskAction(opts, args.slice(1), "cancel");
  if (cmd === "tasks" && args[0] === "release") return cmdTaskAction(opts, args.slice(1), "release");
  if (cmd === "tasks" && args[0] === "reopen") return cmdTaskAction(opts, args.slice(1), "reopen");
  if (cmd === "tasks") return cmdTasks(opts, args[0]);
  if (cmd === "board") return cmdBoard(opts);
  if (cmd === "say") return cmdSay(opts, args);
  if (cmd === "feedback") return cmdFeedback(opts, args);
  if (cmd === "pause") return cmdPause(opts, args, true);
  if (cmd === "resume") return cmdPause(opts, args, false);
  if (cmd === "watch") return watch(opts, false);
  if (cmd === "chat") return watch(opts, true);
  if (cmd === "usage") return cmdUsage(opts);
  if (cmd === "audit") return cmdAudit(opts);
  console.error(`不明なコマンド: ${cmd}\n${HELP}`);
  exit(1);
}

// 直接実行時のみ動く(テストからはimportして使う)
const invoked = process.argv[1] && (process.argv[1].endsWith("hive.js") || process.argv[1].endsWith("hive"));
if (invoked) main().catch((err) => { console.error(err.message); exit(1); });

export { parseGlobalArgs, main };
