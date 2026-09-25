// ローカルWebUI。依存ゼロ(node:http + SSE)。後からElectron殻で包む前提なので
// 描画はブラウザ側に寄せ、サーバーは状態API+SSEストリームだけを持つ。
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "../runner.js";
import { TaskBlackboard } from "../engine/tasks.js";
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

export async function startUi({ config, modelFactory, bus, autoStart = true, onSay = null }) {
  const live = {
    // v6: エージェントは thread.opened/agent.spawned 登録時に出現する(事前登録しない。
    // しないと未所属のconfigエージェントがメイン部屋のメンバーとして見えてしまう)
    agents: {},
    board: [],
    requests: [],
    threads: [],
    scenario: null,
  };
  const tasks = new TaskBlackboard(config.workspace, bus);
  const clients = new Set();

  const record = {
    "agent.status": (p) => {
      live.agents[p.agent] = { ...live.agents[p.agent], status: p.status };
      pushAgentLog(live.agents[p.agent], "status", p.status);
    },
    "agent.turn": (p) => {
      live.agents[p.agent] = { ...live.agents[p.agent], turn: p.turn };
      if (p.reasoning) pushAgentLog(live.agents[p.agent], "think", p.reasoning);
      if (p.content) pushAgentLog(live.agents[p.agent], "say", p.content);
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
      live.agents[p.agent.id] = { status: "working", turn: 0, displayName: p.agent.displayName, depth: p.agent.depth, parent: p.agent.parent, thread: live.agents[p.agent.parent]?.thread ?? "__main__" };
    },
    "thread.opened": (p) => {
      live.threads.push({ name: p.name, goal: p.goal });
      for (const a of p.agents) {
        live.agents[a.id] = { status: "idle", turn: 0, displayName: a.displayName, thread: p.name };
      }
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
    "board": (p) => { live.board.push(p); },
    "permission.request": (p) => { live.requests.push({ ...p, state: "pending" }); },
    "permission.resolved": (p) => {
      const r = live.requests.find((x) => x.id === p.id);
      if (r) r.state = p.verdict === "approve" ? "approved" : "denied";
    },
    "scenario.started": (p) => { live.scenario = { name: p.name, phase: "running" }; },
    "scenario.finished": () => { if (live.scenario) live.scenario.phase = "done"; },
  };
  for (const [type, fn] of Object.entries(record)) bus.on(type, fn);

  // タスクの直接操作(チャットを介さずblackboardのファイルを触る。トークン消費ゼロ)
  function handleTaskAction({ action, id, agent, role, body, project, path }) {
    if (action === "create") {
      const taskBody = String(body ?? "").trim();
      if (!taskBody) return { ok: false, error: "bodyが空です" };
      let taskId = String(id ?? "").trim();
      if (!taskId) taskId = `task-${Date.now().toString(36)}`;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(taskId)) return { ok: false, error: "task_idは英小文字数字とハイフン" };
      if (!tasks.create({ id: taskId, role: role ? String(role) : null, project: String(project ?? "").trim(), body: taskBody })) return { ok: false, error: `task_id ${taskId} は既に存在します` };
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
      if (url.pathname === "/api/state") return json(res, { live, tasks: tasks.snapshot(), taskList: tasks.list(), files: listWorkspaceFiles(config.workspace) });
      if (url.pathname === "/api/tasks" && req.method === "POST") {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
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
      if (url.pathname === "/api/say" && req.method === "POST" && onSay) {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
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
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
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
    server.listen(config.ui.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  }).catch((err) => {
    if (err.code === "EADDRINUSE") {
      throw new Error(`ポート${config.ui.port}は既に使用中です。別のagent-hive(または以前のプロセス残骸)が動いていませんか?`);
    }
    throw err;
  });
  console.log(`UI: http://localhost:${config.ui.port}${autoStart ? " (シナリオを自動開始します)" : ""}`);
  if (autoStart) {
    // 待ち受けを邪魔しない走行
    runScenario({ config, modelFactory, bus }).catch((err) => console.error("scenario error:", err.message));
  }
}

function json(res, obj, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
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
