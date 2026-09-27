// ローカルWebUI。依存ゼロ(node:http + SSE)。後からElectron殻で包む前提なので
// 描画はブラウザ側に寄せ、サーバーは状態API+SSEストリームだけを持つ。
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { runScenario } from "../runner.js";
import { TaskBlackboard } from "../engine/tasks.js";
import { BoardStore } from "../engine/boardstore.js";
import { listSessions, saveSession, loadSession } from "../engine/sessions.js";
import { runCommand } from "../engine/exec.js";
import { listMemoryFiles, isMemoryExpired } from "../engine/memory.js";
import { listWorkspaceFiles } from "../engine/tools.js";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");

// エージェントごとの活動ログ(思考/発言/ツール/状態)。UIの詳細パネル用。
// 1エージェントあたり直近LOG_LIMIT件だけ保持(長時間ランでの肥大止め)。
export const AGENT_LOG_LIMIT = 120;
export function pushAgentLog(agentState, kind, text, ts = Date.now()) {
  if (!agentState) return;
  if (!agentState.log) agentState.log = [];
  agentState.log.push({ ts, kind, text: String(text ?? "").slice(0, 2000) });
  if (agentState.log.length > AGENT_LOG_LIMIT) agentState.log.splice(0, agentState.log.length - AGENT_LOG_LIMIT);
}

export async function startUi({ config, modelFactory, bus, autoStart = true, onSay = null, onAttach = null, onThread = null, onCloseThread = null, onFolder = null, onModel = null, onPermMode = null, onWorkflow = null, onListWorkflows = null, onFeedback = null, onThreadPause = null }) {
  const startedAt = Date.now();
  // ボード履歴はディスクから直接頁送りする(BoardStore)。RAMには末尾だけ持つ(肥大化対策)
  const boardStore = new BoardStore(config.workspace);
  const live = {
    // v6.10: エージェントはthread.opened/agent.spawned登録時に出現する(事前登録しない。
    // しないと未所属のconfigエージェントがメイン部屋のメンバーとして見えてしまう)
    agents: {},
    // 起動時は各ボードファイルの末尾だけ復元。全文はstate/のJSONLに残り、/api/boardで頁送り
    board: boardStore.latest(400),
    requests: [],
    threads: [],
    // マージの差分(新着順・最大20件)。UIのマージ行クリックでdiffを見せる
    merges: [],
    scenario: null,
    permMode: "normal",
    // runtimeでのモデル/思考レベル切替(/model・/effort・設定ウィンドウ)。nullはconfig値
    modelName: null,
    modelEffort: null,
  };
  const tasks = new TaskBlackboard(config.workspace, bus);
  const clients = new Set();

  const record = {
    "agent.status": (p) => {
      live.agents[p.agent] = { ...live.agents[p.agent], status: p.status };
      pushAgentLog(live.agents[p.agent], "status", p.status);
    },
    "agent.turn": (p) => {
      live.agents[p.agent] = { ...live.agents[p.agent], turn: p.turn, live: null };
      if (p.reasoning) pushAgentLog(live.agents[p.agent], "think", p.reasoning);
      if (p.content) pushAgentLog(live.agents[p.agent], "say", p.content);
    },
    "agent.delta": (p) => {
      // ストリーミング断片(ライブ表示用)。ログには残さず現在有効なバッファのみ保持
      const a = live.agents[p.agent];
      if (!a) return;
      a.live = a.live ?? {};
      const buf = (a.live[p.kind] ?? "") + p.text;
      a.live[p.kind] = buf.length > 4000 ? buf.slice(-4000) : buf;
    },
    "tool.call": (p) => {
      live.agents[p.agent] = { ...live.agents[p.agent], lastTool: `${p.tool}` };
      pushAgentLog(live.agents[p.agent], "tool", `${p.tool} ${JSON.stringify(p.args ?? {}).slice(0, 300)}`);
    },
    "tool.result": (p) => {
      pushAgentLog(live.agents[p.agent], "result", `${p.tool} → ${p.brief ?? ""}`);
    },
    "compact.auto": (p) => pushAgentLog(live.agents[p.agent], "compact", `自動圧縮(tokens=${p.tokensBefore}/閾値=${p.threshold})`),
    "compact.micro": (p) => pushAgentLog(live.agents[p.agent], "compact", `microcompact(-${p.savingsTokens}tok)`),
    "compact.failed": (p) => pushAgentLog(live.agents[p.agent], "compact", `圧縮失敗(${p.failures}回目): ${p.error}`),
    "agent.spawned": (p) => {
      live.agents[p.agent.id] = { status: "working", turn: 0, displayName: p.agent.displayName, depth: p.agent.depth, parent: p.agent.parent, thread: p.agent.thread ?? live.agents[p.agent.parent]?.thread ?? "__main__" };
    },
    "thread.closed": (p) => {
      live.threads = live.threads.filter((t) => t.name !== p.name);
      for (const [id, a] of Object.entries(live.agents)) {
        if (id.startsWith(p.name + "-") || id === p.name) delete live.agents[id];
      }
    },
    "thread.folder": (p) => {
      const t = live.threads.find((x) => x.name === p.name);
      if (t) t.folder = p.folder ?? null;
    },
    "thread.paused": (p) => {
      const t = live.threads.find((x) => x.name === p.name);
      if (t) t.paused = Boolean(p.paused);
    },
    "perm.mode": (p) => { live.permMode = p.mode; },
    "model.changed": (p) => {
      // /model・/effort・設定ウィンドウからの切替。nullはconfig値に戻す操作なので反映しない
      if (p.model) live.modelName = p.model;
      if (p.effort) live.modelEffort = p.effort;
    },
    "thread.opened": (p) => {
      live.threads.push({ name: p.name, goal: p.goal, folder: p.folder ?? null });
      for (const a of p.agents) {
        live.agents[a.id] = { status: "idle", turn: 0, displayName: a.displayName, thread: p.name };
      }
    },
    "merge.completed": (p) => {
      // threadをここで確定させておく(差分レビューからの修正依頼の宛先に使う)
      live.merges.unshift({ taskId: p.taskId, agent: p.agent, thread: live.agents[p.agent]?.thread ?? "__main__", stat: p.stat ?? "", patch: p.patch ?? "", summary: p.summary ?? "", at: Date.now() });
      if (live.merges.length > 20) live.merges.pop();
    },
    "agent.exited": (p) => {
      if (live.agents[p.agent]) live.agents[p.agent] = { ...live.agents[p.agent], status: p.ok ? "done" : "error" };
    },
    "usage": (p) => {
      const a = live.agents[p.usage ? p.agent : p.agent];
      const u = p.usage;
      if (a && u) {
        a.tokens = (a.tokens ?? 0) + (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
        a.costUsd = (a.costUsd ?? 0) + (u.costUsd ?? 0);
      }
    },
    "board": (p) => {
      live.board.push(p);
      // RAMに置くのは末尾だけ。全文はJSONLが真実で、古い分は/api/boardがディスクから読む
      if (live.board.length > 800) live.board.splice(0, live.board.length - 800);
    },
    "permission.request": (p) => { live.requests.push({ ...p, state: "pending" }); },
    "permission.resolved": (p) => {
      const r = live.requests.find((x) => x.id === p.id);
      if (r) r.state = p.verdict === "approve" ? "approved" : "denied";
    },
    "scenario.started": (p) => { live.scenario = { name: p.name, phase: "running" }; },
    "usage.summary": (p) => persistUsage(config.workspace, { at: new Date().toISOString(), totals: p.usage ?? null }),
    "usage.round": (p) => persistUsage(config.workspace, { at: new Date().toISOString(), agent: p.agent, endedBy: p.endedBy ?? "ok", totals: p.totals ?? null }),
    "scenario.finished": () => { if (live.scenario) live.scenario.phase = "done"; },
  };
  for (const [type, fn] of Object.entries(record)) bus.on(type, fn);

  // タスクの直接操作(チャットを介さずblackboardのファイルを触る。トークン消費ゼロ)
  function handleTaskAction({ action, id, agent, role, body, project, path, acceptance }) {
    if (action === "create") {
      const taskBody = String(body ?? "").trim();
      if (!taskBody) return { ok: false, error: "bodyが空です" };
      let taskId = String(id ?? "").trim();
      if (!taskId) taskId = `task-${Date.now().toString(36)}`;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(taskId)) return { ok: false, error: "task_idは英小文字数字とハイフン" };
      if (!tasks.create({ id: taskId, role: role ? String(role) : null, project: String(project ?? "").trim(), body: taskBody, acceptance: acceptance ? String(acceptance) : "" })) return { ok: false, error: `task_id ${taskId} は既に存在します` };
      return { ok: true, id: taskId };
    }
    if (action === "release") {
      if (!tasks.releaseOne(String(agent ?? ""), String(id ?? ""), "[解放] ユーザーがUIから解放")) return { ok: false, error: "解放できません(指定を確認)" };
      return { ok: true };
    }
    if (action === "cancel") {
      if (!tasks.cancel(String(id ?? ""))) return { ok: false, error: "中止できません(openのタスクを指定)" };
      return { ok: true };
    }
    if (action === "reopen") {
      if (!tasks.reopen(String(id ?? ""))) return { ok: false, error: "再開できません(doneに同名タスクがあるか、openに既に存在)" };
      return { ok: true };
    }
    if (action === "reproject") {
      if (!tasks.setProject(String(path ?? ""), String(project ?? ""))) return { ok: false, error: "移動できません(タスク指定を確認)" };
      return { ok: true };
    }
    return { ok: false, error: `不明なaction: ${action}` };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
        clients.add(res);
        const offs = Object.keys(record).map((type) => bus.on(type, (payload) => res.write(`data: ${JSON.stringify({ type, payload })}\n\n`)));
        req.on("close", () => {
          clients.delete(res);
          for (const off of offs) off();
        });
        return;
      }
      if (url.pathname === "/api/workflow" && req.method === "POST" && onWorkflow) {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          try {
            const { name } = JSON.parse(body);
            const r = onWorkflow(String(name ?? ""));
            if (r.error) throw new Error(r.error);
            json(res, r);
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      // 総件数: チャットモードではディスクが真実。RAMのみのボード(未永続化)はRAM件数で代用
      if (url.pathname === "/api/state") return json(res, { live: { ...live, board: [...live.board].sort((a,b)=>a.id-b.id).slice(-200), boardTotal: Math.max(boardStore.total(), live.board.length) }, model: { name: config.model.model, fallbacks: config.model.fallbackModels ?? [] }, commands: config.commands ?? {}, workflows: onListWorkflows ? onListWorkflows() : [], tasks: tasks.snapshot(), taskList: tasks.list(), files: listWorkspaceFiles(config.workspace), monitorPort: config.ui.monitorPort ?? null, mcp: config.mcp?.servers ?? {} });
      // ボード履歴の頁送り。before=<id> でそのIDより前を返す(未指定は末尾200件)。
      // thread を指定するとそのスレッドのJSONLから直接読む(RAMに無い過去分も。肥大化しても遅くならない)
      if (url.pathname === "/api/board") {
        const before = Number(url.searchParams.get("before"));
        const thread = url.searchParams.get("thread");
        if (Number.isFinite(before) && before > 0) {
          if (thread) return json(res, boardStore.pageThread(thread, before, 200));
          // 互換経路(thread指定なし): まずRAMの末尾から旧ロジック。RAMに無い深い過去はディスクから
          const all = [...live.board].sort((a, b) => a.id - b.id);
          const idx = all.findIndex((p) => p.id === before);
          if (idx > 0) return json(res, { posts: all.slice(0, idx).slice(-200), total: boardStore.total() });
          return json(res, { posts: boardStore.pageMixed(before, 200), total: boardStore.total() });
        }
        const all = [...live.board].sort((a, b) => a.id - b.id);
        return json(res, { posts: all.slice(-200), total: boardStore.total() });
      }
      if (url.pathname === "/api/thread" && req.method === "POST" && onThread) {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          try {
            const { project, goal, folder } = JSON.parse(body);
            const r = onThread({ project: String(project ?? ""), goal: String(goal ?? ""), folder: folder ? String(folder) : null });
            if (r.error) throw new Error(r.error);
            json(res, { ok: true, id: r.id });
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname === "/api/folder" && req.method === "POST" && onFolder) {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          try {
            const { project, folder } = JSON.parse(body);
            const r = onFolder({ project: String(project ?? ""), folder: folder ? String(folder) : null });
            if (r.error) throw new Error(r.error);
            json(res, r);
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname === "/api/close" && req.method === "POST" && onCloseThread) {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          try {
            const { project } = JSON.parse(body);
            const r = onCloseThread({ project: String(project ?? "") });
            if (r.error) throw new Error(r.error);
            json(res, { ok: true });
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname === "/api/tasks" && req.method === "POST") {
        const chunks = [];
        req.on("data", (d) => chunks.push(d));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            const r = handleTaskAction(JSON.parse(body));
            if (!r.ok) throw new Error(r.error);
            json(res, r);
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname === "/api/pause" && req.method === "POST") {
        const chunks = [];
        req.on("data", (d) => chunks.push(d));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            if (!onThreadPause) throw new Error("このモードでは使えません(チャットモード限定)");
            const { project, paused } = JSON.parse(body);
            const r = onThreadPause({ project: String(project ?? ""), paused: Boolean(paused) });
            if (r.error) throw new Error(r.error);
            json(res, r);
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname === "/api/merge-feedback" && req.method === "POST") {
        const chunks = [];
        req.on("data", (d) => chunks.push(d));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            if (!onFeedback) throw new Error("このモードでは使えません(チャットモード限定)");
            const { taskId, comment } = JSON.parse(body);
            if (!taskId || !String(taskId).trim()) throw new Error("taskIdが空です");
            if (!comment || !String(comment).trim()) throw new Error("コメントが空です");
            // マージ記録からスレッドを復元(不明ならメイン宛て)
            const rec = (live.merges ?? []).find((m) => m.taskId === String(taskId));
            const r = onFeedback({ taskId: String(taskId), comment: String(comment).trim(), thread: rec?.thread ?? "__main__" });
            if (r.error) throw new Error(r.error);
            json(res, r);
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname === "/api/say" && req.method === "POST" && onSay) {
        const chunks = [];
        req.on("data", (d) => chunks.push(d));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            const { text, thread } = JSON.parse(body);
            if (!text || !String(text).trim()) throw new Error("空の入力です");
            onSay(String(text).trim(), thread ? String(thread) : null);
            json(res, { ok: true });
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname === "/api/permission" && req.method === "POST") {
        const chunks = [];
        req.on("data", (d) => chunks.push(d));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            const { id, approve } = JSON.parse(body);
            bus.emit("permission.resolved", { id, verdict: approve ? "approve" : "deny" });
            bus.emit("permission.verdict", { id: Number(id), approve: Boolean(approve) });
            json(res, { ok: true });
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname === "/api/attach" && req.method === "POST" && onAttach) {
        const chunks = [];
        req.on("data", (d) => chunks.push(d));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            const { thread, dataUrl, note } = JSON.parse(body);
            const m = String(dataUrl ?? "").match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/);
            if (!m) throw new Error("画像(dataUrl)が不正です");
            const ext = m[1] === "jpeg" ? "jpg" : m[1];
            const buf = Buffer.from(m[2], "base64");
            if (buf.length > 8 * 1024 * 1024) throw new Error("画像が大きすぎます(8MB上限)");
            const dir = join(config.workspace, "uploads");
            mkdirSync(dir, { recursive: true });
            const file = `img-${Date.now().toString(36)}.${ext}`;
            writeFileSync(join(dir, file), buf);
            onAttach(`uploads/${file}`, String(dataUrl), String(note ?? ""), String(thread ?? "") || null);
            json(res, { ok: true, path: `uploads/${file}` });
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname?.startsWith("/uploads/")) {
        const name = url.pathname.slice("/uploads/".length);
        if (!/^[A-Za-z0-9._-]+$/.test(name)) { res.writeHead(400).end(); return; }
        const p = join(config.workspace, "uploads", name);
        try {
          statSync(p);
          const ext = (name.split(".").pop() ?? "").toLowerCase();
          const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext] ?? "application/octet-stream";
          res.writeHead(200, { "content-type": mime });
          return res.end(readFileSync(p));
        } catch {
          res.writeHead(404).end();
          return;
        }
      }
      if (url.pathname === "/api/git") {
        const r = await runCommand({ command: "git branch --show-current; echo ---; git status --porcelain; echo ---; git log --oneline -5", cwd: config.workspace, timeoutMs: 15000, outputLimit: 4000 });
        return json(res, r);
      }
      if (url.pathname === "/api/exec" && req.method === "POST") {
        const chunks = [];
        req.on("data", (d) => chunks.push(d));
        req.on("end", async () => {
          try {
            const { command } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!command || typeof command !== "string") throw new Error("commandが空です");
            const r = await runCommand({ command, cwd: config.workspace, timeoutMs: 120000, outputLimit: 16 * 1024 });
            json(res, r);
          } catch (err) {
            json(res, { ok: false, text: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname === "/api/model" && req.method === "POST" && onModel) {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          try {
            const r = onModel(JSON.parse(body));
            if (!r.ok) throw new Error(r.error ?? "失敗しました");
            json(res, r);
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname === "/api/perm" && req.method === "POST" && onPermMode) {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          try {
            const { mode } = JSON.parse(body);
            const r = onPermMode(String(mode ?? ""));
            if (!r.ok) throw new Error(r.error ?? "失敗しました");
            json(res, r);
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname === "/api/usage") return json(res, { usage: readFileSyncSafe(join(config.workspace, "state", "usage.json")) });
      if (url.pathname === "/api/memory") return json(res, { files: listMemoryWithExpiry(config.workspace) });
      if (url.pathname === "/api/audit") return json(res, { audit: readAuditTail(config.workspace, Number(url.searchParams.get("limit")) || 200) });
      if (url.pathname === "/api/wtdiff") {
        const r = await handleWtdiff({ mainWorkspace: config.workspace, worktreeRoot: config.worktrees.dir, agentId: url.searchParams.get("agent"), limit: Number(url.searchParams.get("limit")) || undefined });
        return json(res, r.body, r.status);
      }
      if (url.pathname === "/api/session" && req.method === "POST") {
        const chunks = [];
        req.on("data", (d) => chunks.push(d));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            const { action, name } = JSON.parse(body);
            let r;
            if (action === "save") r = saveSession(config.workspace, String(name ?? ""));
            else if (action === "load") r = loadSession(config.workspace, String(name ?? ""));
            else if (action === "list") r = { ok: true, list: listSessions(config.workspace) };
            else throw new Error(`不明なaction: ${action}`);
            if (!r.ok) throw new Error(r.error ?? "失敗しました");
            json(res, r);
          } catch (err) {
            json(res, { error: err.message }, 400);
          }
        });
        return;
      }
      if (url.pathname === "/api/file") return json(res, { content: readFileSafe(config.workspace, url.searchParams.get("path") ?? "") });
      if (url.pathname === "/markdown.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        return res.end(readFileSync(join(PUBLIC, "markdown.js")));
      }
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(readFileSync(join(PUBLIC, "index.html")));
      }
      res.writeHead(404).end();
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.ui.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      // port 0(自動割当)時に実際のポートを反映(テスト等でURLを組み立てられるように)
      config.ui.port = server.address().port;
      resolve();
    });
  }).catch((err) => {
    if (err.code === "EADDRINUSE") {
      throw new Error(`ポート${config.ui.port}は既に使用中です。別のagent-hive(または以前のプロセス残骸)が動いていませんか?`);
    }
    throw err;
  });
  console.log(`UI: http://localhost:${config.ui.port}${autoStart ? " (シナリオを自動開始します)" : ""}`);
  if (config.ui.monitorPort) {
    await startMonitor({ config, live, tasks, startedAt });
  }
  return { close: () => server.close() };
  if (autoStart) {
    // 待ち受けを邪魔しない走行
    runScenario({ config, modelFactory, bus }).catch((err) => console.error("scenario error:", err.message));
  }
}

function json(res, obj, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// /api/memory用: メモリ一覧に期限切れフラグを付ける(isMemoryExpiredに委譲)
export function listMemoryWithExpiry(workspace, now = Date.now()) {
  return listMemoryFiles(workspace).map((f) => ({ name: f, path: `memory/${f}`, expired: isMemoryExpired(workspace, f, now) }));
}

// モニタ用: state/audit.jsonl の行数(無ければ0)
export function countAuditLines(workspace) {
  try {
    const raw = readFileSync(join(workspace, "state", "audit.jsonl"), "utf8");
    return raw.split("
").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}


/* ============ /api/wtdiff: worktreeとmainの差分 ============ */
// agent/<id>ブランチのworktreeに対する main...agent/<id> の差分を返す。
// 出力は上限(既定20KB)で打ち切る。agent指定が無い/不正/該当worktree無しは400。
const WTDIFF_LIMIT_DEFAULT = 20 * 1024;

export async function handleWtdiff({ mainWorkspace, worktreeRoot, agentId, limit = WTDIFF_LIMIT_DEFAULT }) {
  const id = String(agentId ?? "").trim();
  if (!id || !/^[a-z0-9][a-z0-9-]*$/i.test(id)) return { status: 400, body: { ok: false, error: "agent指定が無いか不正です" } };
  const wtDir = join(resolve(worktreeRoot), id);
  if (!existsSync(wtDir)) return { status: 400, body: { ok: false, error: `worktreeが存在しません: ${id}` } };
  const cap = Math.max(1, Math.min(limit, 100 * 1024));
  const run = (cmd) => runCommand({ command: cmd, cwd: wtDir, timeoutMs: 15000, outputLimit: cap });
  const stat = await run(`git diff main...agent/${id} --stat`);
  if (!stat.ok) return { status: 400, body: { ok: false, error: `git diff失敗: ${stat.text.slice(0, 500)}` } };
  const patch = await run(`git diff main...agent/${id}`);
  const truncated = patch.text.length >= cap;
  return {
    status: 200,
    body: {
      ok: true,
      stat: stat.text.slice(0, cap),
      patch: patch.text.slice(0, cap),
      truncated,
    },
  };
}

/* ============ 外部監視サーバ(読み取り専用) ============ */
// LAN/Tailscale越しに進捗を見るための最小ページ。POST系APIは一切持たない
// (exec/say等を公開しない)。unref付きなのでプロセス寿命には関与しない。
export function buildMonitorSnapshot({ config, live, tasks, startedAt }) {
  const list = tasks.list();
  const all = [...list.open, ...list.claimed, ...list.done];
  const prog = (project) => {
    const inP = all.filter((t) => (t.project || "") === project);
    return { total: inP.length, done: inP.filter((t) => t.state === "done").length };
  };
  const claimedIn = {};
  for (const t of list.claimed) {
    const k = t.project || "";
    claimedIn[k] = (claimedIn[k] ?? 0) + 1;
  }
  const agents = Object.entries(live.agents).map(([id, a]) => ({
    id,
    displayName: a.displayName ?? id,
    thread: a.thread ?? "__main__",
    status: a.status ?? "idle",
    turn: a.turn ?? 0,
    lastTool: a.lastTool ?? "",
    tokens: a.tokens ?? 0,
    costUsd: a.costUsd ?? 0,
  }));
  const agentsWorking = agents.filter((a) => a.status === "working").length;
  const lastAt = live.board.reduce((m, p) => Math.max(m, p.at ?? 0), 0);
  const phase = (list.open.length + list.claimed.length > 0 || agentsWorking > 0) ? "working" : (list.done.length > 0 ? "done" : "idle");
  return {
    at: new Date().toISOString(),
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    model: config.model.model,
    permMode: live.permMode,
    posts: live.board.length,
    auditCount: countAuditLines(config.workspace),
    phase,
    lastActivitySec: lastAt ? Math.floor((Date.now() - lastAt) / 1000) : null,
    totalTasks: all.length,
    threads: (live.threads ?? []).map((t) => {
      const pr = prog(t.name);
      const claimed = claimedIn[t.name] ?? 0;
      const state = pr.total > 0 && pr.done === pr.total ? "done" : (pr.done + claimed > 0 ? "working" : (pr.total > 0 ? "waiting" : "idle"));
      const members = Object.entries(live.agents)
        .filter(([, a]) => (a.thread ?? "__main__") === t.name)
        .map(([id, a]) => ({ id, displayName: a.displayName ?? id, status: a.status ?? "idle" }));
      return { name: t.name, folder: t.folder ?? null, goal: t.goal ?? "", paused: Boolean(t.paused), claimed, state, percent: pr.total ? Math.round((pr.done / pr.total) * 100) : 0, members, ...pr };
    }),
    tasks: {
      open: list.open.map((t) => ({ id: t.id, project: t.project ?? "", summary: t.summary })),
      claimed: list.claimed.map((t) => ({ id: t.id, project: t.project ?? "", agent: t.agent ?? "", summary: t.summary })),
      doneCount: list.done.length,
    },
    agents,
    merges: (live.merges ?? []).slice(0, 10).map((m) => ({ taskId: m.taskId, agent: m.agent, summary: m.summary ?? "" })),
    recent: live.board.slice(-30).map((p) => ({ from: p.from, thread: p.thread ?? "__main__", text: String(p.text).slice(0, 200), at: p.at ?? null })),
  };
}

async function startMonitor({ config, live, tasks, startedAt }) {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>agent-hive monitor</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{margin:0;background:#161617;color:#eaeaea;font-family:system-ui,"Segoe UI","Meiryo","Noto Sans JP",sans-serif;font-size:13px;line-height:1.45}
  header{padding:10px 16px;border-bottom:1px solid #2c2c31;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;background:#1d1d1f}
  h1{font-size:15px;margin:0}.accent{color:#f5a35b}.mem1{white-space:nowrap;margin-right:8px}.mdot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px}.ph{font-size:16px;font-weight:700}.bar{height:6px;background:#26262a;border-radius:3px;width:90px;display:inline-block;vertical-align:middle;margin-right:6px}.bar i{display:block;height:100%;background:#f5a35b;border-radius:3px}.sub{color:#a3a3a8;font-size:12px}
  main{padding:12px 16px;max-width:1100px;margin:0 auto}
  h2{font-size:11px;color:#6e6e73;margin:16px 0 6px;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:12px}
  td,th{text-align:left;padding:3px 8px;border-bottom:1px solid #232327}
  th{color:#6e6e73;font-weight:600}
  .mono{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11px}
  .ok{color:#86efac}.warn{color:#fbbf24}.err{color:#fca5a5}.dim{color:#a3a3a8}
  .board div{padding:3px 0;border-bottom:1px solid #1d1d1f;color:#a3a3a8;white-space:pre-wrap;word-break:break-word}
  .board b{color:#eaeaea;font-weight:600}
</style></head><body>
<header><h1>agent-hive <span class="accent">monitor</span></h1><span id="phase" class="ph"></span><span class="sub" id="meta">読み込み中...</span><span class="sub">読み取り専用・3秒ごとに更新</span></header>
<main id="body"></main>
<script>
const esc=(s)=>String(s??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const rows=(a,f)=>a.map(f).join("");
const hue=(s)=>{let h=0;for(const c of String(s))h=(h*31+c.charCodeAt(0))%360;return h;};
async function tick(){
  try{
    const d=await (await fetch("/api/monitor")).json();
    const ph={working:["作業中","#fbbf24"],done:["完了","#86efac"],idle:["待機","#6e6e73"]}[d.phase]||["?","#6e6e73"];
    const remain=d.tasks.open.length+d.tasks.claimed.length;
    const pe=document.getElementById("phase");
    pe.textContent=ph[0]+(d.phase==="working"?"(残り"+remain+"件)":"");
    pe.style.color=ph[1];
    document.getElementById("meta").textContent="model: "+d.model+" / perm:"+esc(d.permMode)+" / 稼働 "+Math.floor(d.uptimeSec/60)+"分"+(d.uptimeSec%60)+"秒 / 投稿 "+d.posts+"件"+(d.lastActivitySec!=null?" / 最終活動 "+(d.lastActivitySec<60?d.lastActivitySec+"秒前":Math.floor(d.lastActivitySec/60)+"分前"):"");
    document.getElementById("body").innerHTML=
      "<h2>スレッド</h2><table><tr><th>状態</th><th>名前</th><th>フォルダ</th><th>進捗</th><th>メンバー</th><th>目標</th></tr>"+
      (rows(d.threads,(t)=>{const st={done:["完了","#86efac"],working:["作業中","#fbbf24"],waiting:["未着手","#a3a3a8"],idle:["—","#6e6e73"]}[t.state]||["—","#6e6e73"];const ps=t.paused?"<span class='warn'>[停止中]</span> ":"";return "<tr><td>"+ps+"<span style='color:"+st[1]+"'>"+st[0]+"</span></td><td class='mono'># "+esc(t.name)+"</td><td>"+esc(t.folder??"")+"</td><td><div class='bar'><i style='width:"+t.percent+"%'></i></div><span class='dim mono'>"+t.done+"/"+t.total+"</span></td><td>"+rows(t.members??[],(m)=>{const sc={idle:"#a3a3a8",working:"#fbbf24",done:"#86efac",error:"#fca5a5","budget-stop":"#fca5a5"}[m.status]||"#a3a3a8";return "<span class='mem1' title='"+esc(m.status)+"'><i class='mdot' style='background:"+sc+"'></i><span style='color:hsl("+hue(m.id)+" 45% 72%)'>"+esc(m.displayName)+"</span></span>";})+"</td><td class='dim'>"+esc(t.goal)+"</td></tr>";})||"<tr><td colspan='6' class='dim'>開いているスレッドはありません</td></tr>")+"</table>"+
      "<h2>タスク(未着手 "+d.tasks.open.length+" / 作業中 "+d.tasks.claimed.length+" / 完了 "+d.tasks.doneCount+")</h2><table><tr><th>状態</th><th>タスク</th><th>担当</th><th>内容</th></tr>"+
      rows(d.tasks.claimed,(t)=>"<tr><td class='warn'>作業中</td><td class='mono'>"+esc(t.id)+"</td><td class='mono'>"+esc(t.agent)+"</td><td class='dim'>"+esc(t.summary)+"</td></tr>")+
      rows(d.tasks.open,(t)=>"<tr><td class='dim'>未着手</td><td class='mono'>"+esc(t.id)+"</td><td></td><td class='dim'>"+esc(t.summary)+"</td></tr>")+"</table>"+
      "<h2>エージェント</h2><table><tr><th>名前</th><th>状態</th><th>turn</th><th>直近ツール</th><th>消費</th><th>スレッド</th></tr>"+
      (rows(d.agents,(a)=>{const st={idle:["待機","#a3a3a8"],working:["作業中","#fbbf24"],done:["完了","#86efac"],error:["エラー","#fca5a5"],"budget-stop":["停止","#fca5a5"]}[a.status]||[esc(a.status),"#a3a3a8"];return "<tr><td style='color:hsl("+hue(a.id)+" 45% 72%)'>"+esc(a.displayName)+"</td><td style='color:"+st[1]+"'>"+st[0]+"</td><td class='mono'>"+a.turn+"</td><td class='mono'>"+esc(a.lastTool)+"</td><td class='mono'>"+a.tokens.toLocaleString()+"tok</td><td class='mono'>"+esc(a.thread)+"</td></tr>";})||"<tr><td colspan='6' class='dim'>稼働中のエージェントはいません</td></tr>")+"</table>"+
      "<h2>直近のマージ</h2><div class='board'>"+(rows(d.merges,(m)=>"<div><b class='mono'>"+esc(m.taskId)+"</b> <span class='accent'>"+esc(m.summary)+"</span> <span class='dim'>by "+esc(m.agent)+"</span></div>")||"<div class='dim'>まだありません</div>")+"</div>"+
      "<h2>ボードの新着(全スレッド・直近30件)</h2><div class='board'>"+rows(d.recent.slice().reverse(),(p)=>"<div><b style='color:hsl("+hue(p.from)+" 45% 72%)'>"+esc(p.from)+"</b> <span class='mono dim'>@"+esc(p.thread)+"</span> "+esc(p.text)+"</div>")+"</div>";
  }catch(e){ document.getElementById("body").textContent="取得に失敗: "+e.message; }
}
tick();setInterval(tick,3000);
</script></body></html>`;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://monitor");
      if (url.pathname === "/api/monitor") return json(res, buildMonitorSnapshot({ config, live, tasks, startedAt }));
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      res.writeHead(405).end();
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });
  const host = config.ui.monitorHost ?? "0.0.0.0";
  const port = config.ui.monitorPort ?? 0;
  await new Promise((resolve) => server.listen(port, host, resolve));
  server.unref();
  console.log(`Monitor: http://localhost:${server.address().port} (読み取り専用・${host}で公開)`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === "IPv4" && !n.internal) console.log(`Monitor(LAN): http://${n.address}:${server.address().port}`);
    }
  }
  return server;
}

function readFileSafe(workspace, p) {
  const root = resolve(workspace);
  const full = resolve(root, p);
  if (full !== root && !full.startsWith(root + sep)) return "(ワークスペース外のパスです)";
  try {
    statSync(full);
    return readFileSync(full, "utf8").slice(0, 200 * 1024);
  } catch {
    return "(ファイルがありません)";
  }
}

// state/配下のボードログ(board__main__.jsonl / board-<スレッド>.jsonl)を全件復元する
export function loadPersistedBoardPosts(workspace) {
  const dir = join(workspace, "state");
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!(f === "board__main__.jsonl" || /^board-.+\.jsonl$/.test(f))) continue;
    try {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line);
          if (p && typeof p.id === "number") out.push(p);
        } catch {}
      }
    } catch {}
  }
  return out;
}

// state/usage.jsonへの蓄積(運用データ。直近200件)
function persistUsage(workspace, entry) {
  try {
    const dir = join(workspace, "state");
    mkdirSync(dir, { recursive: true });
      const file = join(dir, "usage.json");
      const history = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
      history.push(entry);
      writeFileSync(file, JSON.stringify(history.slice(-200), null, 1));
  } catch {}
}

// /api/audit: state/audit.jsonl(+1世代前 audit-1.jsonl)の末尾limit件を新着順で返す。
// 台帳はtools.jsが書く真実で、ここは読み取り専用。壊れた行は無視する(簿記の失敗で止めない)
function readAuditTail(workspace, limit) {
  const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const dir = join(workspace, "state");
  const lines = [];
  for (const name of ["audit-1.jsonl", "audit.jsonl"]) {
    try {
      const text = readFileSync(join(dir, name), "utf8");
      for (const l of text.split("\n")) {
        const s = l.trim();
        if (!s) continue;
        try { lines.push(JSON.parse(s)); } catch { /* 壊れた行は無視 */ }
      }
    } catch { /* ファイルが無い世代は無視 */ }
  }
  return lines.slice(-n).reverse();
}
