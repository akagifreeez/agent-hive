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

export async function startUi({ config, modelFactory, bus }) {
  const live = {
    agents: Object.fromEntries(config.agents.map((a) => [a.id, { status: "idle", turn: 0, lastTool: null }])),
    board: [],
    requests: [],
    scenario: null,
  };
  const tasks = new TaskBlackboard(config.workspace, bus);
  const clients = new Set();

  const record = {
    "agent.status": (p) => { live.agents[p.agent] = { ...live.agents[p.agent], status: p.status }; },
    "agent.turn": (p) => { live.agents[p.agent] = { ...live.agents[p.agent], turn: p.turn }; },
    "tool.call": (p) => { live.agents[p.agent] = { ...live.agents[p.agent], lastTool: `${p.tool}` }; },
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
      if (url.pathname === "/api/state") return json(res, { live, tasks: tasks.snapshot(), files: listWorkspaceFiles(config.workspace) });
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
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(readFileSync(join(PUBLIC, "index.html")));
      }
      res.writeHead(404).end();
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  await new Promise((r) => server.listen(config.ui.port, "127.0.0.1", r));
  console.log(`UI: http://localhost:${config.ui.port} (シナリオを自動開始します)`);
  // 待ち受けを邪魔しない走行
  runScenario({ config, modelFactory, bus }).catch((err) => console.error("scenario error:", err.message));
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
