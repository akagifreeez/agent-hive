// シナリオ実行器: ワークスペース初期化→タスク投入→全エージェント同時走行→回収。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Board, Bus } from "./engine/board.js";
import { TaskBlackboard } from "./engine/tasks.js";
import { createTools } from "./engine/tools.js";
import { runAgentLoop } from "./engine/loop.js";

export async function runScenario({ config, modelFactory, bus = new Bus() }) {
  mkdirSync(config.workspace, { recursive: true });
  const board = new Board(bus);
  const tasks = new TaskBlackboard(config.workspace);
  tasks.seed(config.scenario.tasks);
  bus.emit("scenario.started", { name: config.scenario.name, tasks: config.scenario.tasks.map((t) => t.id) });

  const runs = config.agents.map((agent) => (async () => {
    const model = modelFactory();
    const tools = createTools({ agent, workspace: config.workspace, board, tasks, bus });
    const shellKind = await tools.detectShell();
    const agentWithCtx = { ...agent, scenarioName: config.scenario.name };
    return runAgentLoop({ agent: agentWithCtx, model, tools, board, tasks, bus, maxTurns: config.loop.maxTurns, shellKind });
  })());

  const timeoutMs = config.runner.timeoutSec * 1000;
  const results = await withOverallTimeout(runs, timeoutMs);

  const unfinished = tasks.snapshot().claimed;
  if (unfinished.length) {
    bus.emit("scenario.warn", { message: `完了せず残った請求タスク: ${unfinished.join(", ")}` });
  }
  const snapshot = { board: board.posts, tasks: tasks.snapshot(), results };
  bus.emit("scenario.finished", snapshot);
  return snapshot;
}

// 全体タイムアウト: 打ち切るが終わった分の結果は返す
function withOverallTimeout(runs, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(runs.map(() => ({ ok: false, error: "全体タイムアウト" })));
    }, timeoutMs);
    guard.unref?.();
    Promise.all(runs.map((p) => p.catch((e) => ({ ok: false, error: e.message })))).then((r) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(r);
    });
  });
}
