// シナリオ実行器: ワークスペース初期化(git blackboard化)→タスク/シード投入→
// 発見器起動→全エージェント同時走行→最終プローブ→回収。
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { Board, Bus } from "./engine/board.js";
import { TaskBlackboard } from "./engine/tasks.js";
import { createTools } from "./engine/tools.js";
import { runAgentLoop } from "./engine/loop.js";
import { PermissionGate } from "./engine/permissions.js";
import { startDiscovery, ensureGitRepo } from "./engine/discover.js";
import { setupWorktrees } from "./engine/worktree.js";
import { runCommand } from "./engine/exec.js";
import { UsageLedger } from "./engine/usage.js";
import { OpenAIModel } from "./model/openai.js";
import { SpawnManager } from "./engine/spawn.js";
import { ChatHost } from "./engine/chat.js";
import { buildMemoryContext } from "./engine/memory.js";
import { ROOT } from "./config.js";

export function createModelFactory(config) {
  return (agent = {}) =>
    new OpenAIModel({
      ...config.model,
      model: agent.model ?? config.model.model,
      reasoningEffort: agent.reasoningEffort ?? config.model.reasoningEffort,
    });
}

// メインチャット常駐モード(v5): メイン3体+スポーンされるサブ/作業員。
// コントローラ { say, manager } を返す(UIの入力欄からsayが呼ばれる)。
export async function runChat({ config, bus = new Bus() }) {
  mkdirSync(config.workspace, { recursive: true });
  const board = new Board(bus);
  const tasks = new TaskBlackboard(config.workspace, bus);
  const gate = new PermissionGate({ bus, ...(config.permissions ?? {}) });
  const ledger = new UsageLedger();

  // chat用の最小シード(package.jsonのみ)。scenarioのseedFiles/tasksは持ち込まない
  const p = join(config.workspace, "package.json");
  if (!existsSync(p)) {
    writeFileSync(p, '{ "name": "hive-workspace", "private": true, "type": "module", "scripts": { "test": "node --test tests/*.test.mjs" } }\n');
  }
  await ensureGitRepo(config.workspace);

  const worktreeRoot = resolve(ROOT, config.worktrees?.dir ?? "worktrees");
  const mains = config.agents
    .filter((a) => (config.chat?.mains ?? config.agents.map((x) => x.id)).includes(a.id))
    .map((a) => ({ ...a, depth: 0 }));
  const worktreePaths = await setupWorktrees({
    mainWorkspace: config.workspace,
    worktreeRoot,
    agents: mains,
    onKept: ({ agentId, path, detail }) => {
      bus.emit("worktree.kept", { agent: agentId, path });
      board.post("system", `[worktree保持] worktrees/${agentId} に前回実行の未コミット変更があるため初期化をスキップしました。引き継ぐ場合はそのまま作業するか、確定させてください。\n\n${detail}`);
    },
  });

  // 永続記憶(memory/)は毎回読み直す(distill-learningsの反映を次ラウンドから効かせる)
  const memoryFn = () => buildMemoryContext(config.workspace);

  const discovery = startDiscovery({
    workspace: config.workspace, tasks, bus,
    intervalSec: config.discovery?.intervalSec ?? 30,
    testCommand: config.discovery?.testCommand,
  });
  bus.on("merge.completed", () => void discovery.tick());

  const manager = new SpawnManager({
    mainWorkspace: config.workspace,
    worktreeRoot,
    board, tasks, bus, gate, ledger,
    budget: config.budget,
    hierarchy: config.hierarchy,
    modelFactory: createModelFactory(config),
    maxTurns: config.loop.maxTurns,
    contextWindow: config.model.contextWindow ?? 200000,
    thresholdPercent: config.compact?.thresholdPercent,
    memoryFn,
  });
  const toolsFactory = (main) =>
    createTools({
      agent: main,
      workspace: worktreePaths[main.id],
      mainWorkspace: config.workspace,
      board, tasks, bus, gate,
      spawner: manager,
    });

  const host = new ChatHost({
    mains,
    mainWorkspace: config.workspace,
    modelFactory: createModelFactory(config),
    toolsFactory,
    board, tasks, bus, ledger,
    budget: config.budget,
    maxTurnsPerRound: config.chat?.maxTurnsPerRound ?? 12,
    contextWindow: config.model.contextWindow ?? 200000,
    thresholdPercent: config.compact?.thresholdPercent,
    memoryFn,
  });
  host.worktreePaths = worktreePaths;

  bus.emit("scenario.started", { name: `chat:${config.scenario.name}`, tasks: [] });
  return {
    say: (text) => host.say(text),
    manager,
    bus,
  };
}

export async function runScenario({ config, modelFactory, bus = new Bus() }) {
  mkdirSync(config.workspace, { recursive: true });
  const board = new Board(bus);
  const tasks = new TaskBlackboard(config.workspace, bus);
  const gate = new PermissionGate({ bus, ...(config.permissions ?? {}) });

  // シードファイル(テストコード等)をgitベースラインより先に置く
  for (const f of config.scenario.seedFiles ?? []) {
    const p = join(config.workspace, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }
  await ensureGitRepo(config.workspace);
  tasks.seed(config.scenario.tasks);
  bus.emit("scenario.started", { name: config.scenario.name, tasks: config.scenario.tasks.map((t) => t.id) });

  // v3: エージェント別worktree(作業の隔離)
  const worktreeRoot = resolve(ROOT, config.worktrees?.dir ?? "worktrees");
  const worktreePaths = await setupWorktrees({
    mainWorkspace: config.workspace,
    worktreeRoot,
    agents: config.agents,
    onKept: ({ agentId, path, detail }) => {
      bus.emit("worktree.kept", { agent: agentId, path });
      board.post("system", `[worktree保持] worktrees/${agentId} に前回実行の未コミット変更があるため初期化をスキップしました。\n\n${detail}`);
    },
  });
  bus.emit("worktrees.ready", { paths: Object.values(worktreePaths) });

  const discovery = startDiscovery({
    workspace: config.workspace,
    tasks,
    bus,
    intervalSec: config.discovery?.intervalSec ?? 30,
    testCommand: config.discovery?.testCommand,
  });
  // マージでmainが動くたびに即時プローブ(レビュータスクの立ち遅れ防止)
  bus.on("merge.completed", () => void discovery.tick());

  const ledger = new UsageLedger();

  const runs = config.agents.map((agent) => (async () => {
    // エージェント別モデル上書き(agents[].model / agents[].reasoningEffort)
    const model = modelFactory
      ? modelFactory(agent)
      : new OpenAIModel({
          ...config.model,
          model: agent.model ?? config.model.model,
          reasoningEffort: agent.reasoningEffort ?? config.model.reasoningEffort,
        });
    const tools = createTools({
      agent,
      workspace: worktreePaths[agent.id],
      mainWorkspace: config.workspace,
      board,
      tasks,
      bus,
      gate,
    });
    const shellKind = await tools.detectShell();
    const agentWithCtx = { ...agent, scenarioName: config.scenario.name };
    return runAgentLoop({
      agent: agentWithCtx, model, tools, board, tasks, bus,
      ledger, budget: config.budget,
      maxTurns: config.loop.maxTurns, shellKind,
      contextWindow: config.model.contextWindow ?? 200000,
      thresholdPercent: config.compact?.thresholdPercent,
      memory: buildMemoryContext(config.workspace) || null,
    });
  })());

  const timeoutMs = config.runner.timeoutSec * 1000;
  const results = await withOverallTimeout(runs, timeoutMs);

  // 収尾: 先にコミットしてdiffを空にしてから最終プローブ(phantom reviewタスクの防止)
  // 最終プローブでテスト失敗が見つかった場合、fixタスクはあえてopenのまま残す(次回ランへの仕事の受け渡し)
  await commitIfChanged(config.workspace);
  await discovery.tick();
  discovery.stop();

  const unfinished = tasks.snapshot().claimed;
  if (unfinished.length) {
    bus.emit("scenario.warn", { message: `完了せず残った請求タスク: ${unfinished.join(", ")}` });
  }
  const usage = { byAgent: ledger.snapshot(), totals: ledger.totals() };
  bus.emit("usage.summary", usage);
  const snapshot = { board: board.posts, tasks: tasks.snapshot(), results, usage };
  bus.emit("scenario.finished", snapshot);
  return snapshot;
}

async function commitIfChanged(workspace) {
  if (!existsSync(join(workspace, ".git"))) return;
  await runCommand({
    command: "git add -A && (git diff --cached --quiet || git -c user.name=hive -c user.email=hive@local commit -m 'scenario complete')",
    cwd: workspace,
    outputLimit: 2000,
  });
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
