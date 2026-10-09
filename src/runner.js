// シナリオ実行器: ワークスペース初期化(git blackboard化)→タスク/シード投入→
// 発見器起動→全エージェント同時走行→最終プローブ→回収。
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Board, Bus } from "./engine/board.js";
import { readModelPolicy } from "./engine/model-policy.js";
import { TaskBlackboard } from "./engine/tasks.js";
import { createTools } from "./engine/tools.js";
import { runAgentLoop } from "./engine/loop.js";
import { PermissionGate } from "./engine/permissions.js";
import { startDiscovery, ensureGitRepo } from "./engine/discover.js";
import { applyTestSemaphoreConfig } from "./engine/exec.js";
import { setupWorktrees } from "./engine/worktree.js";
import { ensureMainCheckout } from "./engine/branch-guard.js";
import { respawnUnfinishedWork } from "./engine/respawn.js";
import { runCommand } from "./engine/exec.js";
import { UsageLedger } from "./engine/usage.js";
import { OpenAIModel } from "./model/openai.js";
import { createModelFactory } from "./model/factory.js";
import { buildCatalog, resolveModel, resolveAuthValue } from "./model/catalog.js";
import { hasOAuthEntry } from "./model/openai-auth.js";

// 旧来のrunner.js内実装をsrc/model/factory.jsへ移設済み。api(ワイヤ形式)で
// アダプタを選択する新版(agent.modelは"provider/model"でもベアIDでもよい)。
// re-exportで既存の参照(index.js等)の互換を維持する。
export { createModelFactory };
import { SpawnManager } from "./engine/spawn.js";
import { ChatHost, normalizeAutoResume } from "./engine/chat.js";
import { buildMemoryContext, ensurePcRules } from "./engine/memory.js";
import { buildSkillsIndex } from "./engine/skills.js";
import { McpHost, mcpServersInfo } from "./engine/mcp.js";
import { createWorkflowApi, runWorkflowScript } from "./engine/workflow.js";
import { Hooks } from "./engine/hooks.js";
import { ROOT, dataDir } from "./config.js";
import { renameSync } from "node:fs";

// メインチャット常駐モード(v6): リーダー1体がメインチャットで壁打ちと計画を担い、
// open_threadで開かれたサブスレッド(project)ごとに3ワーカーが並行作業する。
// コントローラ { say(text, thread?), openThread, listThreads, manager } を返す。
export async function runChat({ config, bus = new Bus(), modelFactory = null }) {
  mkdirSync(config.workspace, { recursive: true });
  // PC操作の制限ルールをmemory/へシード(既存があれば触らない)。全エージェントに常時注入される
  ensurePcRules(config.workspace);
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

  // 漂流チェック(runChat): チャット起動時も同様にmainワークスペースのチェックアウトを検査。
  // 漂流+中断マージの残骸はゾンビ回収・ラウンド開始より先に片付ける(判定不能時は何もしない)。
  try {
    const gc = await ensureMainCheckout({ mainWorkspace: config.workspace });
    if (gc.branch && gc.branch !== "main") {
      const driftMsg = gc.ok
        ? "[ブランチ漂流] mainワークスペースが " + gc.branch + " にチェックアウトされていました。mainへ復帰しました。"
        : "[ブランチ漂流] mainワークスペースが " + gc.branch + " にチェックアウトされており、自動復帰できませんでした: " + (gc.reason ?? "");
      mainBoard.post("system", driftMsg);
      bus.emit("scenario.warn", { message: driftMsg });
    }
  } catch (err) {
    bus.emit("scenario.warn", { message: "起動時ブランチチェックに失敗(起動は続行): " + (err instanceof Error ? err.message : err) });
  }

  // 起動時のゾンビclaim回収: プロセス再起動で走行中ラウンドは全て死んでいるため、claimedのまま
  // 残ったタスクは誰にも進められない(idle-claim待ちのデッドロック)。起動直後なので全claimedは
  // ゾンビと見なして解放する(task.releasedが出るが、この時点でラウンドは無いので無害)
  // プロセスガードのboard可視化(long-run-resilience): index.jsのwireCrashGuardが
  // "crash.guarded"を出すので、ここでメインボードへ[システム]投稿する(黙殺防止)。
  // 頻度警告(process.burst相当)も同じく可視化。
  bus.on("crash.guarded", (e) => {
    if (e.kind === "rate.warn") return; // 頻度警告は別メッセージで流す
    try { mainBoard.post("system", `[プロセス警告] ${e.kind} を捕捉(プロセスは生存しています): ${String(e.message).slice(0, 300)}`); } catch { /* 投稿失敗でガードを止めない */ }
  });
  bus.on("crash.rate", (e) => {
    try { mainBoard.post("system", `[プロセス警告][異常頻度] ガード対象エラーがしきい値を超えました。ログ run-chat.err.log を確認してください(${String(e.body ?? "").slice(0, 150)})`); } catch { /* 同上 */ }
  });

  const zombies = tasks.list().claimed;
  for (const t of zombies) {
    tasks.release(t.agent, "[起動時回収] プロセス再起動により走行中ラウンドが消滅したため解放しました");
  }
  if (zombies.length) {
    console.log(`[agent-hive] 起動時: 前回走行中だったclaimedタスク${zombies.length}件を解放しました`);
    bus.emit("scenario.warn", { message: `起動時: 前回のclaimedタスク${zombies.length}件を回収(解放)しました` });
  }

  const worktreeRoot = resolve(ROOT, config.worktrees?.dir ?? "worktrees");
  // 起動時のクラッシュ復旧スキャン(#7): 前回プロセス死で中断したworktree差分から
  // 未完了作業を再起票し、変更ゼロの放棄ブランチを掃除(提案/オプションで自動)する。
  // 失敗しても起動は止めない(スキャンは最善努力)。
  try {
    const rr = await respawnUnfinishedWork({
      mainWorkspace: config.workspace, worktreeRoot, tasks,
      board: mainBoard, bus,
      opts: { cleanup: Boolean(config.chat?.respawn?.cleanup) },
    });
    if (rr.respawned.length) console.log(`[agent-hive] 起動時: 未完了のworktree作業を再起票しました(${rr.respawned.join(", ")})`);
    if (rr.swept.length) console.log(`[agent-hive] 起動時: 放棄worktree/ブランチを掃除しました(${rr.swept.join(", ")})`);
  } catch (err) {
    bus.emit("scenario.warn", { message: `起動時スキャンに失敗(起動は続行): ${err instanceof Error ? err.message : err}` });
  }

  // 永続記憶(memory/)+スキル索引を毎回読み直す(distill反映・スキル追加を次ラウンドから効かせる)
  const memoryFn = () => {
    const parts = [buildMemoryContext(config.workspace), buildSkillsIndex(config.workspace)].filter(Boolean);
    return parts.length ? parts.join("\n\n") : null;
  };

  applyTestSemaphoreConfig(config.exec);
  const discovery = startDiscovery({
    workspace: config.workspace, tasks, bus,
    intervalSec: config.discovery?.intervalSec ?? 30,
    testCommand: config.discovery?.testCommand,
    probes: config.discovery?.probes,
  });
  bus.on("merge.completed", () => void discovery.tick());

  // 実装者≠検証者の強制(#3): chat.requireSeparateApprove=trueでfinish_task時に検証タスクを
  // 起票し、approve_task(実装者以外)で承認されたタスクだけをマージする。全createToolsへ共有
  const approvals = {
    require: Boolean(config.chat?.requireSeparateApprove),
    pending: new Map(), // taskId => {agentId, worktreePath}
    pickReviewer(excludeId) {
      const candidates = (config.agents ?? []).filter((a) => a.id !== excludeId);
      return candidates.find((a) => a.role === "review") ?? candidates[0] ?? null;
    },
  };

  // 実行時のモデル/思考レベル切替(/model・/effortコマンドやUIから)。nullならconfigどおり
  const runtime = { model: null, effort: null };
  const modelFor = (agent) => {
    if (modelFactory) return modelFactory({ ...agent, model: runtime.model ?? agent.model, reasoningEffort: runtime.effort ?? agent.reasoningEffort });
    return createModelFactory(config)({
      ...agent,
      model: runtime.model ?? agent.model,
      reasoningEffort: runtime.effort ?? agent.reasoningEffort ?? config.model.reasoningEffort,
    });
  };
  const keptNotice = (board) => ({ agentId, path, detail }) => {
    bus.emit("worktree.kept", { agent: agentId, path });
    board.post("system", `[worktree保持] worktrees/${agentId} に前回実行の未コミット変更があるため初期化をスキップしました。引き継ぐ場合はそのまま作業するか、確定させてください。\n\n${detail}`);
  };

  // MCPサーバー(config.mcp.servers)を起動してツールとして接続(失敗してもhiveは続行)
  /** @type {import("./engine/mcp.js").McpHostInstance[]} */
  const mcpHosts = Object.entries(config.mcp?.servers ?? {}).map(([name, def]) =>
    new McpHost({ name, bus, ...(typeof def === "string" ? { command: def } : def) })
  );
  for (const h of mcpHosts) {
    const r = await h.start();
    if (!r.ok) bus.emit("scenario.warn", { message: `MCPサーバー ${h.name} の起動に失敗: ${r.error}` });
  }

  const hooks = new Hooks({ config, cwd: config.workspace, bus });
  // MCP設定の動的管理(設定ウィンドウから)。追加/削除はhive.local.json(DATA側)へ永続化する
  const localCfgPath = join(dataDir(), "hive.local.json");
  const readLocalCfg = () => {
    try { return JSON.parse(readFileSync(localCfgPath, "utf8")); } catch { return {}; }
  };
  const writeLocalServers = (servers) => {
    const local = readLocalCfg();
    local.mcp = { ...(local.mcp ?? {}), servers };
    const tmp = `${localCfgPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(local, null, 1));
    renameSync(tmp, localCfgPath);
  };
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
    hooks,
    idleClaimWaitSec: config.chat?.idleClaimWaitSec ?? 0,
    approvals,
    modelPolicy: readModelPolicy(config),
  });
  const mcpTo = (extra) => ({ ...extra, mcpHosts, hooks, idleClaimWaitSec: config.chat?.idleClaimWaitSec ?? 0, modelPolicy: readModelPolicy(config) });

  // サブスレッド: project名=スレッド名。3ワーカー( personas: workers )が専用ボードで並行作業
  const threads = new Map();
  // UIからのチャット履歴クリア: 対象スレッドのBoardメモリを空にする(ディスク/索引はserver側のBoardStore.clear)。
  // タスク・メモリ(mem-*.json)には触らない=完了済みタスクの履歴は消えない。
  // 既読位置(seen)もリセットする: クリア後の投稿idは1から再採番されるため、旧既読のままだと
  // since(旧id)が空になりエージェントが新着を見落とす
  bus.on("board.clear", (p) => {
    const t = p?.thread ?? "__main__";
    const b = t === "__main__" ? mainBoard : threads.get(t)?.board;
    if (b) b.clearMemory();
    const host = t === "__main__" ? leadHost : threads.get(t)?.host;
    host?.seen?.clear?.();
  });
  const workflowRuns = new Map(); // 実行中のワークフロー(同名の同時実行を防ぐ)
  const registryPath = join(stateDir, "threads.json");
  const writeRegistry = () => {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(registryPath, JSON.stringify([...threads.values()].map((t) => ({ name: t.name, goal: t.goal, folder: t.folder ?? null })), null, 1));
    } catch {
      // 簿記の失敗でスレッド運用を止めない
    }
  };
  const openThread = async ({ project, goal, folder = null }, opts = {}) => {
    const name = String(project).trim();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return { error: "project(スレッド名)は英小文字数字とハイフンで40字以内" };
    if (threads.has(name)) return { error: `スレッド ${name} は既に開いています` };
    const folderName = folder ? String(folder).trim().slice(0, 30) || null : null;
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

        crossPoster,
        resolveBoard,
        approvals,

      })),
      board: threadBoard, tasks, bus, ledger,
      budget: config.budget,
      maxTurnsPerRound: config.chat?.maxTurnsPerRound ?? 12,
      chatConfig: config.chat,
      contextWindow: config.model.contextWindow ?? 200000,
      thresholdPercent: config.compact?.thresholdPercent,
      memoryFn,
      staggerMs: 0, // ユーザー入力時の全ワーカー同時起こしを遅延なく(2番目以降にstagger秒の純遅延が乗るバグのため0固定)
      project: name,
      autoContinueRounds: config.chat?.autoContinueRounds ?? 3,
      autoResume: normalizeAutoResume(config.chat?.autoResume),
      hooks,
      approvals, // ラウンド末マージの保留判定(イシュー#22)
    });
    host.worktreePaths = wtPaths;
    threads.set(name, { name, goal, folder: folderName, host, board: threadBoard });
    writeRegistry();
    bus.emit("thread.opened", { name, goal, folder: folderName, agents: members.map((m) => ({ id: m.id, displayName: m.displayName })) });
    // 復元(silent)時はキックオフせず静かに開く。ユーザーが投稿したときにワーカーが起きる
    if (!opts.silent) {
      host.say(`[スレッド開始] project: ${name}\n目標: ${goal}\n\nタスクは claim_next_task で project: ${name} を指定して請求してください。`);
    }
    return { ok: true, id: name };
  };

  // 流動ワーカー: backlogに応じてスレッドへ追加ワーカーを増員し、余ったワーカーは
  // 請求ミス1回で早期退場させる(expendable)。並行度が仕事量に追従する。
  const aliveWorkers = new Map(); // thread => Set(agentId)
  const threadOfAgent = new Map();
  const agentStatus = new Map(); // agentId => 最新の状態
  bus.on("thread.opened", (p) => {
    const set = aliveWorkers.get(p.name) ?? new Set();
    for (const m of p.agents) { threadOfAgent.set(m.id, p.name); set.add(m.id); agentStatus.set(m.id, "idle"); }
    aliveWorkers.set(p.name, set);
  });
  // thread.openedの同tick登録順問題: listener登録はemitより後でも動くよう、
  // openThread内のemit(276行目)はここで受ける。ただしrunChat内のthreads.setが
  // emitより先なので、復元(silent)で開かれたスレッドも同様に拾う。
  bus.on("agent.spawned", (p) => {
    agentStatus.set(p.agent.id, "working");
    const th = threadOfAgent.get(p.agent.parent);
    if (th) { threadOfAgent.set(p.agent.id, th); aliveWorkers.get(th)?.add(p.agent.id); }
  });
  bus.on("agent.status", (ev) => {
    agentStatus.set(ev.agent, ev.status);
    const th = threadOfAgent.get(ev.agent);
    if (th && ["done", "error", "budget-stop"].includes(ev.status)) aliveWorkers.get(th)?.delete(ev.agent);
  });
  bus.on("thread.closed", (p) => {
    for (const [id, th] of [...threadOfAgent]) if (th === p.name) threadOfAgent.delete(id);
    aliveWorkers.delete(p.name);
  });
  const autoscale = async () => {
    const base = (config.chat?.workers ?? config.chat?.mains ?? ["alpha", "beta", "gamma"]).length;
    const max = config.chat?.maxWorkersPerThread ?? 4;
    const globalCap = config.hierarchy?.maxConcurrent ?? 6;
    const list = tasks.list();
    // 再起動などで担当者が停止したままの請求を解放(作業が凍結するのを防ぐ)
    // ChatHostラウンド実行中の担当者は稼働中とみなす(agent.status workingの発火が
    // ラウンド開始より遅れる競合があり、直後tickで請求を誤解放するため)
    const runningNow = new Set();
    for (const [, th2] of threads) {
      for (const m of th2.host?.mains ?? []) {
        if (th2.host?.roundState?.get(m.id)?.running) runningNow.add(m.id);
      }
    }
    for (const t of list.claimed) {
      if (!t.agent) continue;
      if (agentStatus.get(t.agent) === "working" || runningNow.has(t.agent)) continue;
      tasks.releaseOne(t.agent, t.id, "[自動解放] 担当者が稼働していないため再請求可能にしました。");
    }
    const open = list.open;
    for (const [name, alive] of aliveWorkers) {
      const th = threads.get(name);
      // host無しスレッド(ディスカッション等・タスク請求なし)は増員対象外
      if (!th || !th.host || th.host.paused) continue; // 停止中スレッドは増員しない
      // host.mains が実際に稼働中(ラウンド実行中)なら縮小しない: agentStatus/claimed依存の
      // 判定は scripted応答などの即完了ラウンドで取りこぼす(statusがworkingに戻る前の
      // tickで縮小判定→alive削除済み)ため、ラウンド稼働を直接観測するガードを併設する。
      const anyMainRunning = (th.host?.mains ?? []).some((m) => th.host?.roundState?.get(m.id)?.running === true);
      const nOpen = open.filter((t) => (t.project || "") === name).length;
      const nClaimedMine = list.claimed.filter((t) => (t.project || "") === name && agentStatus.get(t.agent) === "working").length;
      // 請求中(稼働中)の仕事があるスレッドは縮小しない(open==0でも作業進行中ならbase維持)
      const desired = nOpen === 0 && nClaimedMine === 0 && !anyMainRunning ? Math.min(base, alive.size) : Math.min(max, base + Math.ceil((nOpen + nClaimedMine) / 2));
      if (alive.size >= desired || manager.live.size >= globalCap) continue;
      const member = th.host?.mains?.[0];
      if (!member) continue;
      const r = await manager.spawn({
        parent: { id: `${name}-scale`, displayName: `スレッド ${name}`, depth: 1 },
        board: th.board,
        displayName: `追加ワーカー(${name})`,
        role: "impl",
        project: name,
        expendable: true,
        brief: `[自動増員] project ${name} の追加ワーカーです。スレッド目標: ${th.goal ?? ""}
claim_next_task({project: "${name}"}) で仕事を拾い、タスク本文の完了条件を満たしたら finish_task でマージしてください。他のワーカーと同じファイルを触らないよう、タスク本文をよく読んで割り当ててください。仕事が無くなったら速やかに終了します(請求ミス1回で退場)。`,
      });
      if (!r.error) {
        threadOfAgent.set(r.id, name);
        alive.add(r.id);
        break; // 1tickにつき1体まで(急増防止)
      }
    }
  };
  const autoscaleTimer = config.chat?.autoscale === false ? null : setInterval(() => { void autoscale(); }, (config.chat?.autoscaleIntervalSec ?? 30) * 1000);
  // テスト/デバッグ用の明示tick(autoscaleをintervalの到達を待たず1回実行)
  const autoscaleTick = () => autoscale();
  // テスト/デバッグ用: スレッドごとの生きたワーカーid集合の観測点
  const aliveWorkersFor = (threadName) => aliveWorkers.get(String(threadName)) ?? null;
  if (autoscaleTimer?.unref) autoscaleTimer.unref();

  // 前回実行で開いていたスレッドを無音で復元(ボード・メモリ・タブが復帰する)
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    for (const t of Array.isArray(registry) ? registry : []) {
      await openThread({ project: t.name, goal: t.goal ?? "", folder: t.folder ?? null }, { silent: true });
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
    // 閉じたスレッドのホストを破棄(bus購読解除+起床遮断)。これが無いと
    // 閉鎖後も task.created/task.released でワーカーが起こされ続ける(イシュー#29)。
    try { t.host?.dispose?.(); } catch (e) { console.error("[closeThread] dispose失敗", e); }
    writeRegistry();
    if (typeof t.host?.unsubscribe === "function") t.host.unsubscribe(); // 閉じたスレッドのHostはイベントで再起床しない(イシュー#29)
    bus.emit("thread.closed", { name });
    t.board.post("system", `[スレッド終了] ${name} を閉じました。成果物とログは保持されています(再open時は履歴ごと戻ります)。`);
    return { ok: true };
  };

  // crosstalk: 指定スレッドのボードへ直接投稿する(to_thread引数用)。不在スレッドはエラー
  const crossPoster = (threadName, from, text) => {
    const t = threads.get(String(threadName ?? "").trim());
    if (!t) return { ok: false, error: `スレッド ${threadName} は開いていません` };
    const post = t.board.post(from, text);
    return { ok: true, id: post.id };
  };

  // to_thread宛先解決(design-to-thread.md): 自分のボード/threads/__main__を解決。他はnull
  const resolveBoard = (threadName) => {
    const name = String(threadName ?? "").trim();
    if (name === mainBoard.name) return mainBoard;
    return threads.get(name)?.board ?? null;
  };

  // スレッドのフォルダ(ナビ表示用分類)を付け替え。openThreadと同じ正規化を適用
  const setThreadFolder = ({ project, folder }) => {
    const name = String(project).trim();
    const t = threads.get(name);
    if (!t) return { error: `スレッド ${name} は開いていません` };
    const folderName = folder ? String(folder).trim().slice(0, 30) || null : null;
    t.folder = folderName;
    writeRegistry();
    bus.emit("thread.folder", { name, folder: folderName });
    return { ok: true, name, folder: folderName };
  };


  // スレッドの一時停止/再開(Claude Squad手本)。__main__はリーダー自身を休ませる。
  // 停止中はワーカーの起床と自動増員を止めるのでトークンを消さない
  const setThreadPaused = ({ project, paused }) => {
    const name = String(project ?? "").trim();
    const host = name && name !== "__main__" ? threads.get(name)?.host : leadHost;
    if (!host) return { error: `スレッド ${name} は開いていません` };
    return host.setPaused(Boolean(paused));
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
      crossPoster,
      resolveBoard,
      threadOpener: openThread,
      threadCloser: closeThread,
      approvals,
    })),
    board: mainBoard, tasks, bus, ledger,
    budget: config.budget,
    maxTurnsPerRound: config.chat?.maxTurnsPerRound ?? 12,
    chatConfig: config.chat,
    contextWindow: config.model.contextWindow ?? 200000,
    thresholdPercent: config.compact?.thresholdPercent,
    memoryFn,
    staggerMs: config.chat?.staggerMs ?? 3000,
    project: null, // リーダーは請求しないので自動継続は実質発火しない
    autoContinueRounds: config.chat?.autoContinueRounds ?? 3,
      autoResume: normalizeAutoResume(config.chat?.autoResume),
    hooks,
    approvals, // ラウンド末マージの保留判定(イシュー#22)
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

    mcpList: () => mcpServersInfo(mcpHosts),
    // デバッグ/テスト用: 承認フロー保留 Map(ラウンド末マージ保留判定が本番配線で生きていることの観測点)
    approvalsPending: approvals.pending,
    // デバッグ/テスト用: スレッド名ごとのChatHost(ラウンド状態の観測点。replyHost等の内部参照用)
    threadHost: (name) => (name === "__main__" ? leadHost : threads.get(name)?.host ?? null),
    /** @param {{name?: string, command?: string, args?: string[], env?: Object.<string,string>}} o */
    mcpAdd: async ({ name, command, args, env } = {}) => {
      const id = String(name ?? "").trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) return { error: "サーバー名は英小文字数字と_-で32字以内" };
      if (!String(command ?? "").trim()) return { error: "commandが空です" };
      if (mcpHosts.some((h) => h.name === id)) return { error: `サーバー ${id} は既に接続されています` };
      const host = new McpHost({ name: id, command: String(command).trim(), args, env, bus });
      const r = await host.start();
      if (!r.ok) return { error: `起動に失敗: ${r.error}` };
      mcpHosts.push(/** @type {import("./engine/mcp.js").McpHostInstance} */ (/** @type {any} */ (host))); // 配列は全エージェントのツール一覧と共有。次のラウンドから反映される
      const local = readLocalCfg();
      writeLocalServers({ ...(local.mcp?.servers ?? {}), [id]: { command: String(command).trim(), args: args ?? [], env: env ?? {} } });
      return { ok: true, tools: r.tools };
    },

    /** @param {{name?: string}} o */
    mcpRemove: ({ name } = {}) => {
      const id = String(name ?? "");
      const idx = mcpHosts.findIndex((h) => h.name === id);
      if (idx < 0) return { error: `サーバー ${id} は接続されていません` };
      mcpHosts[idx].stop();
      mcpHosts.splice(idx, 1);
      const local = readLocalCfg();
      const servers = { ...(local.mcp?.servers ?? {}) };
      delete servers[id];
      writeLocalServers(servers);
      return { ok: true };
    },
    say: (text, thread = null) => {
      // 引数順は(text, thread)。旧実装は h.say(text) に2引数をそのまま流し、
      // threadがChatHost.sayの第2引数(delayMs滑落は無いがwake遅延の温床)へ混入していたため正規化。
      const t = thread ? threads.get(thread) : null;
      if (t) return t.host ? t.host.say(text) : { ok: false, error: `スレッド ${thread} はワーカーを持たないためsayできません` };
      return leadHost.say(text);
    },
    attachImage: (note, dataUrl, thread = null, path = null) => {
      const t = thread ? threads.get(thread) : null;
      const host = t ? t.host : leadHost;
      host.attachImage(note, dataUrl, path);
      return { ok: true };
    },
    // 差分レビューからの修正依頼: 該当スレッドにタスクを起票し、ワーカーを起こして気づかせる。
    // メイン(__main__)のマージならリーダーへ届ける(起票はプロジェクトなし=リーダーが割当を判断)
    feedback: ({ taskId, comment, thread }) => {
      const base = String(taskId ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
      const text = String(comment ?? "").trim();
      if (!base || !text) return { error: "taskIdとコメントが必要です" };
      const th = thread && threads.has(thread) ? thread : null;
      const id = `fb-${base}-${Date.now().toString(36)}`;
      tasks.create({
        id,
        project: th ?? "",
        acceptance: "レビューコメントの指摘がすべて解消していること(修正後の差分で確認可能)",
        body: `[修正依頼] マージ済みタスク ${taskId} の差分へのレビューコメント:\n${text}\n\n該当箇所とその周辺を確認して修正し、通常どおり finish_task で完了してください。`,
      });
      const host = th ? threads.get(th).host : leadHost;
      host.say(`[修正依頼] タスク ${taskId} の差分にフィードバックが届きました。未着手タスク ${id} として起票済みです。確認して対応してください。`);
      return { ok: true, id, thread: th ?? "__main__" };
    },
    setModel: (patch) => {
      if (patch.model !== undefined) runtime.model = String(patch.model).trim() || null;
      if (patch.effort !== undefined) runtime.effort = ["low", "medium", "high"].includes(patch.effort) ? patch.effort : null;
      bus.emit("model.changed", { model: runtime.model, effort: runtime.effort });
      return { ok: true, model: runtime.model, effort: runtime.effort };
    },
    setPermMode: (mode) => {
      gate.setMode(mode);
      bus.emit("perm.mode", { mode: gate.mode });
      return { ok: true, mode: gate.mode };
    },
    runWorkflow: (name) => {
      const safe = String(name).replace(/[^\w-]/g, "");
      if (!safe) return { error: "ワークフロー名が不正です" };
      if (workflowRuns.has(safe)) return { error: `ワークフロー ${safe} は実行中です` };
      const file = join(config.workspace, "workflows", safe + ".mjs");
      if (!existsSync(file)) return { error: `ワークフローファイルがありません: ${file}` };
      workflowRuns.set(safe, { startedAt: Date.now() });
      const log = (t) => bus.emit("workflow.log", { name: safe, text: t });
      bus.emit("workflow.started", { name: safe });
      const api = createWorkflowApi({
        openThread,
        closeThread,
        say: (text, thread) => {
          const h = thread ? threads.get(thread)?.host : leadHost;
          if (!h) return { ok: false, error: `スレッド ${thread} はワーカーを持たない(host無し)ため、sayできません` };
          return h.say(text); // ChatHost.sayの契約は(text)。thread解決は上で済んでいる
        },
        tasks,
        bus,
        log,
      });
      void runWorkflowScript({ path: file, api, timeoutMs: 30 * 60000 })
        .then(() => {
          bus.emit("workflow.finished", { name: safe });
          log("完了");
        })
        .catch((err) => {
          bus.emit("workflow.failed", { name: safe, error: err.message });
          log("失敗: " + err.message);
        })
        .finally(() => workflowRuns.delete(safe));
      return { ok: true, name: safe };
    },
    listWorkflows: () => {
      const dir = join(config.workspace, "workflows");
      try {
        return readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => f.replace(/\.mjs$/, ""));
      } catch {
        return [];
      }
    },
    openThread,
    closeThread,
    setThreadFolder,
    setThreadPaused,
    listThreads: () => [...threads.keys()],
    // プロセス警告の投稿先解決(long-run-resilience): スレッド名→そのスレッドのBoard。
    // __main__はメインボード。開いていないスレッドはnull
    boardOf: (threadName) => {
      const name = String(threadName ?? "").trim();
      if (name === mainBoard.name) return mainBoard;
      return threads.get(name)?.board ?? null;
    },
    runDiscussion: (req) => {
      // モデル横断ディスカッション: 接続済みプロバイダの代表モデル同士を1つのボードで議論させる。
      // host無しのBoard単体スレッド(タスク請求なし)なので、発言分のトークンだけで完結する
      const topic = String(req?.topic ?? "").trim();
      if (!topic) return { error: "論点が空です(/discuss <トピック>)" };
      const refs = Array.isArray(req?.refs) ? req.refs.map(String) : null;
      const rounds = Math.max(1, Math.min(Number(req?.rounds ?? 2), 5));
      const name = `discuss-${Date.now().toString(36)}`;
      const board = new Board(bus, name, join(stateDir, `board-${name}.jsonl`));
      threads.set(name, { name, goal: `ディスカッション: ${topic}`, folder: "discussion", host: null, board });
      writeRegistry();
      bus.emit("thread.opened", { name, goal: `ディスカッション: ${topic}`, folder: "discussion", agents: [] });
      // 接続済みプロバイダの代表モデル(先頭行)を参加者として構築する(未接続は除外)
      const factory = createModelFactory(config);
      const catalog = buildCatalog(config.models);
      const baseDirs = [ROOT, dataDir()];
      const participants = [];
      const notes = [];
      const providerIds = refs ? [...new Set(refs.map((r) => String(r).split("/")[0]))] : Object.keys(catalog.providers);
      for (const pid of providerIds) {
        const p = catalog.providers[pid];
        if (!p) { notes.push(`${pid}: 未知のプロバイダ(除外)`); continue; }
        try {
          const spec = resolveModel(catalog, (refs ?? []).find((r) => String(r).startsWith(pid + "/")) ?? `${pid}/${(p.models ?? [])[0]?.id}`);
          const authOk = spec.provider.api === "openai-chatgpt-responses"
            ? hasOAuthEntry({ provider: spec.provider.id, file: spec.provider.auth?.file ?? `state/models-${spec.provider.id}.oauth.json` }, baseDirs)
            : Boolean(resolveAuthValue(spec.provider, baseDirs));
          if (!authOk) { notes.push(`${p.name ?? pid}: 未接続(除外)`); continue; }
          participants.push({
            id: `dis-${pid}`, provider: pid, ref: `${spec.provider.id}/${spec.model.id}`,
            model: factory({ model: `${spec.provider.id}/${spec.model.id}` }),
          });
        } catch (err) {
          notes.push(`${pid}: ${err.message}(除外)`);
        }
      }
      if (participants.length < 2) {
        threads.delete(name);
        return { error: `参加できるモデルが2つ未満です(${notes.join(" / ") || "接続状況を確認"})` };
      }
      void runDiscussionLoop({ board, participants, topic, rounds }).catch((err) => {
        board.post("system", `[ディスカッション異常] ${err.message}`);
      });
      return { ok: true, thread: name, participants: participants.map((p) => p.ref), notes };
    },
    autoscaleTick,
    aliveWorkersFor,
    tasks,
    manager,
    mcpHosts,
    bus,
  };
}

// ===== モデル横断ディスカッション =====
// 接続済みプロバイダの代表モデル同士を1つのボードで議論させる。
// 各参加者はボードの新着を読んで応答する(順番に発言・指定ラウンド数だけ周回)。
// 最後に先頭参加者が結論をまとめて投稿する。
export async function runDiscussionLoop({ board, participants, topic, rounds = 2 }) {
  board.post("system", `[ディスカッション開始] 論点: ${topic}\n参加: ${participants.map((p) => p.ref).join(", ")} / ${rounds}ラウンド`);
  const seen = new Map(participants.map((p) => [p.id, board.lastId()]));
  for (let round = 1; round <= rounds; round++) {
    for (const p of participants) {
      const fresh = board.since(seen.get(p.id) ?? 0).filter((x) => x.from !== p.id);
      if (fresh.length) seen.set(p.id, fresh[fresh.length - 1].id);
      const transcript = fresh.map((x) => `${x.from}: ${x.text}`).join("\n---\n").slice(0, 8000);
      const prompt = round === 1
        ? `論点「${topic}」について、あなたの立場から最初の意見を述べてください。日本語・600字以内。`
        : `これまでの議論:\n${transcript}\n\n論点「${topic}」について、他者の意見を受けた反論・補足・合意のいずれかを述べてください。日本語・600字以内。`;
      try {
        const res = await p.model.chat({ messages: [{ role: "user", content: prompt }] });
        if (res.content) board.post(p.id, res.content);
        else board.post("system", `[ディスカッション] ${p.ref} から空応答(スキップ)`);
      } catch (err) {
        board.post("system", `[ディスカッション] ${p.ref} の発言に失敗: ${String(err.message ?? err).slice(0, 150)}`);
      }
    }
  }
  // まとめ: 先頭参加者が結論を出す
  const all = board.posts.map((x) => `${x.from}: ${x.text}`).join("\n---\n");
  try {
    const res = await participants[0].model.chat({
      messages: [{ role: "user", content: `論点「${topic}」の議論全体を、結論・合意事項・残る懸念の3部構成でまとめてください。日本語。\n\n${all.slice(-8000)}` }],
    });
    board.post("system", `[結論] ${res.content ?? "(まとめの生成に失敗)"}`);
  } catch (err) {
    board.post("system", `[ディスカッション] まとめの生成に失敗: ${String(err.message ?? err).slice(0, 150)}`);
  }
  board.post("system", "[ディスカッション終了]");
}

export async function runScenario({ config, modelFactory, bus = new Bus() }) {
  mkdirSync(config.workspace, { recursive: true });
  ensurePcRules(config.workspace);
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

  // 起動時ブランチ漂流チェック(self-improve-lab-lessons): mainワークスペースのチェックアウトが
  // agent/<id>等へ漂流していたら安全にmainへ復帰し、逸脱をボードへ警告(2026-10-07朝の本番実害)。
  // 判定不能(git不在等)は起動を止めない(既存契約)。
  try {
    const gc = await ensureMainCheckout({ mainWorkspace: config.workspace });
    if (gc.branch && gc.branch !== "main") {
      const driftMsg = gc.ok
        ? "[ブランチ漂流] mainワークスペースが " + gc.branch + " にチェックアウトされていました。mainへ復帰しました。"
        : "[ブランチ漂流] mainワークスペースが " + gc.branch + " にチェックアウトされており、自動復帰できませんでした: " + (gc.reason ?? "");
      board.post("system", driftMsg);
      bus.emit("scenario.warn", { message: driftMsg });
    }
  } catch (err) {
    bus.emit("scenario.warn", { message: "起動時ブランチチェックに失敗(起動は続行): " + (err instanceof Error ? err.message : err) });
  }
  tasks.seed(config.scenario.tasks);
  bus.emit("scenario.started", { name: config.scenario.name, tasks: config.scenario.tasks.map((t) => t.id) });

  // 起動時のゾンビclaim回収(runScenario): チャット(runChat)と同じく、プロセス再起動で
  // claimedのまま宙吊りになったタスクを解放する(2026-10-07 hive-lab-dash実害: alpha/delta
  // 二重宙吊りでidle-claim待ちデッドロック)。seedより先に回収し、再投入と干渉しない。
  for (const z of tasks.list().claimed) {
    tasks.releaseOne(z.agent, z.id, "[起動時回収] 前回走行のラウンド消滅により解放しました(宙吊りclaim回収)");
  }

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

  applyTestSemaphoreConfig(config.exec);
  const discovery = startDiscovery({
    workspace: config.workspace,
    tasks,
    bus,
    intervalSec: config.discovery?.intervalSec ?? 30,
    testCommand: config.discovery?.testCommand,
    probes: config.discovery?.probes,
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
          webSearch: agent.webSearch ?? config.model.webSearch,
        });
    const tools = createTools({
      agent,
      workspace: worktreePaths[agent.id],
      mainWorkspace: config.workspace,
      board,
      tasks,
      bus,
      gate,
      // scenario実行でもモデル選択ポリシーを有効化(承認フロー競合の検証差し戻し経路で参照される)
      modelPolicy: readModelPolicy(config),
      // scenario実行ではスレッド機構が無いので自分のボードのみ解決(他スレッド宛はok:false)
      resolveBoard: (name) => (String(name ?? "").trim() === board.name ? board : null),
    });
    const shellKind = await tools.detectShell();
    const agentWithCtx = { ...agent, scenarioName: config.scenario.name };
    return runAgentLoop({
      agent: agentWithCtx, model, tools, board, tasks, bus,
      ledger, budget: config.budget,
      maxTurns: config.loop.maxTurns, shellKind,
      contextWindow: config.model.contextWindow ?? 200000,
      thresholdPercent: config.compact?.thresholdPercent,
      sessionLogKeep: config.sessionLog?.keep ?? null,
      sessionLogMaxBytes: config.sessionLog?.maxBytes ?? null,
      memory: [buildMemoryContext(config.workspace), buildSkillsIndex(config.workspace)].filter(Boolean).join("\n\n") || null,
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
