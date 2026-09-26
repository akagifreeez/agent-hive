// シナリオ実行器: ワークスペース初期化(git blackboard化)→タスク/シード投入→
// 発見器起動→全エージェント同時走行→最終プローブ→回収。
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
import { OpenAIModel, FallbackModel } from "./model/openai.js";
import { SpawnManager } from "./engine/spawn.js";
import { ChatHost } from "./engine/chat.js";
import { buildMemoryContext } from "./engine/memory.js";
import { McpHost } from "./engine/mcp.js";
import { ROOT } from "./config.js";

export function createModelFactory(config) {
  return (agent = {}) => {
    const mk = (model, effort) => new OpenAIModel({
      ...config.model,
      model: model ?? config.model.model,
      reasoningEffort: effort ?? agent.reasoningEffort ?? config.model.reasoningEffort,
    });
    const primary = agent.model ? mk(agent.model) : mk();
    // フォールバック列(config.model.fallbackModels)があれば、終端エラー時に順に試す(ZCode model-selection流)
    const fallbacks = (config.model.fallbackModels ?? []).map((m) => mk(m));
    return fallbacks.length ? new FallbackModel({ primary, fallbacks }) : primary;
  };
}

// メインチャット常駐モード(v6): リーダー1体がメインチャットで壁打ちと計画を担い、
// open_threadで開かれたサブスレッド(project)ごとに3ワーカーが並行作業する。
// コントローラ { say(text, thread?), openThread, listThreads, manager } を返す。
export async function runChat({ config, bus = new Bus(), modelFactory = null }) {
  mkdirSync(config.workspace, { recursive: true });
  // チャットの永続化先(workspace/state/。git除外済み)。再起動後も会話を復帰できる
  const stateDir = join(config.workspace, "state");
  const mainBoard = new Board(bus, "__main__", join(stateDir, "board__main__.jsonl"));
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
  // 永続記憶(memory/)は毎回読み直す(distill-learningsの反映を次ラウンドから効かせる)
  const memoryFn = () => buildMemoryContext(config.workspace);

  const discovery = startDiscovery({
    workspace: config.workspace, tasks, bus,
    intervalSec: config.discovery?.intervalSec ?? 30,
    testCommand: config.discovery?.testCommand,
  });
  bus.on("merge.completed", () => void discovery.tick());

  const modelFor = modelFactory ?? createModelFactory(config);
  const keptNotice = (board) => ({ agentId, path, detail }) => {
    bus.emit("worktree.kept", { agent: agentId, path });
    board.post("system", `[worktree保持] worktrees/${agentId} に前回実行の未コミット変更があるため初期化をスキップしました。引き継ぐ場合はそのまま作業するか、確定させてください。\n\n${detail}`);
  };

  // MCPサーバー(config.mcp.servers)を起動してツールとして接続(失敗してもhiveは続行)
  const mcpHosts = Object.entries(config.mcp?.servers ?? {}).map(([name, def]) =>
    new McpHost({ name, bus, ...(typeof def === "string" ? { command: def } : def) })
  );
  for (const h of mcpHosts) {
    const r = await h.start();
    if (!r.ok) bus.emit("scenario.warn", { message: `MCPサーバー ${h.name} の起動に失敗: ${r.error}` });
  }

  const manager = new SpawnManager({
    mainWorkspace: config.workspace,
    worktreeRoot,
    board: mainBoard, tasks, bus, gate, ledger,
    budget: config.budget,
    hierarchy: config.hierarchy,
    modelFactory: modelFor,
    maxTurns: config.loop.maxTurns,
    contextWindow: config.model.contextWindow ?? 200000,
    thresholdPercent: config.compact?.thresholdPercent,
    memoryFn,
    mcpHosts,
  });
  const mcpTo = (extra) => ({ ...extra, mcpHosts });

  // サブスレッド: project名=スレッド名。3ワーカー( personas: workers )が専用ボードで並行作業
  const threads = new Map();
  const registryPath = join(stateDir, "threads.json");
  const writeRegistry = () => {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(registryPath, JSON.stringify([...threads.values()].map((t) => ({ name: t.name, goal: t.goal })), null, 1));
    } catch {
      // 簿記の失敗でスレッド運用を止めない
    }
  };
  const openThread = async ({ project, goal }, opts = {}) => {
    const name = String(project).trim();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return { error: "project(スレッド名)は英小文字数字とハイフンで40字以内" };
    if (threads.has(name)) return { error: `スレッド ${name} は既に開いています` };
    const workerIds = config.chat?.workers ?? config.chat?.mains ?? ["alpha", "beta", "gamma"];
    const members = workerIds.map((w) => {
      const base = config.agents.find((a) => a.id === w) ?? { id: w, displayName: w, role: "impl" };
      return {
        id: `${name}-${w}`,
        displayName: base.displayName ?? w,
        role: base.role ?? "impl",
        depth: 1,
        personaPath: resolve(ROOT, base.persona ?? `agents/${w}.md`),
        scenarioName: "chat",
      };
    });
    const wtPaths = await setupWorktrees({
      mainWorkspace: config.workspace,
      worktreeRoot,
      agents: members,
      onKept: keptNotice(mainBoard),
    });
    const threadBoard = new Board(bus, name, join(stateDir, `board-${name}.jsonl`));
    const host = new ChatHost({
      mains: members,
      mainWorkspace: config.workspace,
      modelFactory: modelFor,
      toolsFactory: (agent) => createTools(mcpTo({
        agent,
        workspace: wtPaths[agent.id],
        mainWorkspace: config.workspace,
        board: threadBoard, tasks, bus, gate,
        spawner: manager,
      })),
      board: threadBoard, tasks, bus, ledger,
      budget: config.budget,
      maxTurnsPerRound: config.chat?.maxTurnsPerRound ?? 12,
      contextWindow: config.model.contextWindow ?? 200000,
      thresholdPercent: config.compact?.thresholdPercent,
      memoryFn,
      staggerMs: config.chat?.staggerMs ?? 3000,
      project: name,
      autoContinueRounds: config.chat?.autoContinueRounds ?? 3,
    });
    host.worktreePaths = wtPaths;
    threads.set(name, { name, goal, host, board: threadBoard });
    writeRegistry();
    bus.emit("thread.opened", { name, goal, agents: members.map((m) => ({ id: m.id, displayName: m.displayName })) });
    // 復元(silent)時はキックオフせず静かに開く。ユーザーが投稿したときにワーカーが起きる
    if (!opts.silent) {
      host.say(`[スレッド開始] project: ${name}\n目標: ${goal}\n\nタスクは claim_next_task で project: ${name} を指定して請求してください。`);
    }
    return { ok: true, id: name };
  };

  // 前回実行で開いていたスレッドを無音で復元(ボード・メモリ・タブが復帰する)
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    for (const t of Array.isArray(registry) ? registry : []) {
      await openThread({ project: t.name, goal: t.goal ?? "" }, { silent: true });
    }
  } catch {
    // registryが無ければ初回起動
  }

  // スレッドを閉じる: 一覧から外し、ボードに告知。成果物・ログは残り、再openすれば履歴ごと戻る
  const closeThread = ({ project }) => {
    const name = String(project).trim();
    const t = threads.get(name);
    if (!t) return { error: `スレッド ${name} は開いていません` };
    threads.delete(name);
    writeRegistry();
    t.board.post("system", `[スレッド終了] ${name} を閉じました。成果物とログは保持されています(再open時は履歴ごと戻ります)。`);
    return { ok: true };
  };

  // リーダー(メインチャットに1体)。壁打ち→計画→open_thread
  const leadDef = config.agents.find((a) => a.id === (config.chat?.lead ?? "lead")) ?? {};
  const lead = {
    id: leadDef.id ?? config.chat?.lead ?? "lead",
    displayName: leadDef.displayName ?? "リーダー",
    role: "lead",
    depth: 0,
    personaPath: resolve(ROOT, leadDef.persona ?? `agents/${leadDef.id ?? "lead"}.md`),
    scenarioName: "chat",
  };
  const leadWt = await setupWorktrees({
    mainWorkspace: config.workspace,
    worktreeRoot,
    agents: [lead],
    onKept: keptNotice(mainBoard),
  });
  const leadHost = new ChatHost({
    mains: [lead],
    mainWorkspace: config.workspace,
    modelFactory: modelFor,
    toolsFactory: (agent) => createTools(mcpTo({
      agent,
      workspace: leadWt[lead.id],
      mainWorkspace: config.workspace,
      board: mainBoard, tasks, bus, gate,
      spawner: manager,
      threadOpener: openThread,
      threadCloser: closeThread,
    })),
    board: mainBoard, tasks, bus, ledger,
    budget: config.budget,
    maxTurnsPerRound: config.chat?.maxTurnsPerRound ?? 12,
    contextWindow: config.model.contextWindow ?? 200000,
    thresholdPercent: config.compact?.thresholdPercent,
    memoryFn,
    staggerMs: config.chat?.staggerMs ?? 3000,
    project: null, // リーダーは請求しないので自動継続は実質発火しない
    autoContinueRounds: config.chat?.autoContinueRounds ?? 3,
  });
  leadHost.worktreePaths = leadWt;
  bus.emit("thread.opened", { name: "__main__", goal: "メインチャット(壁打ちと計画)", agents: [{ id: lead.id, displayName: lead.displayName }] });

  // 定期実行(cron): chat.schedules = [{everyMinutes, text, thread?}]。thread省略でリーダーへ
  for (const sch of config.chat?.schedules ?? []) {
    const every = Math.max(0.02, Number(sch.everyMinutes ?? 30));
    const timer = setInterval(() => {
      const target = sch.thread ? threads.get(sch.thread) : null;
      (target ? target.host : leadHost).say(`[定期] ${sch.text}`);
    }, every * 60000);
    if (timer.unref) timer.unref();
  }

  bus.emit("scenario.started", { name: `chat:${config.scenario.name}`, tasks: [] });
  return {
    say: (text, thread = null) => {
      const t = thread ? threads.get(thread) : null;
      if (t) return t.host.say(text);
      return leadHost.say(text);
    },
    openThread,
    closeThread,
    listThreads: () => [...threads.keys()],
    manager,
    mcpHosts,
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
