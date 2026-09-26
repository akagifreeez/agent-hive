// スポーン管理(v5): エージェントが spawn_agent ツールで他エージェントを立てる。
// 階層(メイン→サブ→作業員)は「仕事の組織化」だけに使い、コミュニケーションは
// 全レベルが同じボードで合流する(報告は必ずボード/親への秘密チャネルは作らない)。
import { join, resolve } from "node:path";
import { createWorktree } from "./worktree.js";
import { createTools } from "./tools.js";
import { runAgentLoop, buildSystemPrompt } from "./loop.js";
import { runCommand } from "./exec.js";

const WORKER_PERSONA = (displayName, role) => `# ${displayName}(スポーンされた作業エージェント/ロール: ${role})

あなたはハイブで働く作業エージェントです。親エージェントからのブリーフ(最初の指示)に従って作業します。

## 方針
- ブリーフは要点(目標・完了条件)だけ書かれている。着手前に gather_context でボードの経過と、必要なら完了タスク(source: "done")も読み、**このタスクに必要な前提を自分で集めてから**作業計画を立てる(読み取り時キュレーション)。
- ブリーフに書かれたことだけを確実にやる。範囲を広げすぎない。
- 作ったら必ず自分で実行・確認し、結果をボードへ報告する。
- 追加の仕事が必要になったら create_task で起票し、ボードでも告知する。
- 困ったらボードで質問する(親に直接ではなく全員に見える形で)。
`;

export class SpawnManager {
  constructor({
    mainWorkspace, worktreeRoot, board, tasks, bus, gate = null, ledger = null, budget = null,
    hierarchy = { maxDepth: 2, maxConcurrent: 6 }, modelFactory, maxTurns = 40,
    contextWindow = 200000, thresholdPercent,
    memoryFn = null, // () => 永続記憶の注入文脈
    mcpHosts = null, // MCPサーバー群(外部ツール)
  }) {
    this.mainWorkspace = mainWorkspace;
    this.worktreeRoot = worktreeRoot;
    this.board = board;
    this.tasks = tasks;
    this.bus = bus;
    this.gate = gate;
    this.ledger = ledger;
    this.budget = budget;
    this.hierarchy = hierarchy;
    this.modelFactory = modelFactory;
    this.maxTurns = maxTurns;
    this.contextWindow = contextWindow;
    this.thresholdPercent = thresholdPercent;
    this.memoryFn = memoryFn;
    this.mcpHosts = mcpHosts;
    this.live = new Map(); // id => {displayName, depth, parent, status}
    this.counter = 0;
  }

  // ツールから呼ばれる。呼び出し元は待たせないので、ループは非同期で走らせる。
  // boardは呼び出し元のスレッドのボード(v6。省略時は構築時のboard=メイン)。
  async spawn({ parent, board = null, displayName, role, brief, project = "" }) {
    const depth = (parent.depth ?? 0) + 1;
    if (depth > this.hierarchy.maxDepth) {
      return { error: `深さの上限(${this.hierarchy.maxDepth})に達しています。あなたの配下には作れません。` };
    }
    if (this.live.size >= this.hierarchy.maxConcurrent) {
      return { error: `同時エージェント数の上限(${this.hierarchy.maxConcurrent})に達しています。既存の作業の完了を待ってください。` };
    }
    if (!brief || !brief.trim()) {
      return { error: "briefが空です。何を/どう確認するかを書いてください。" };
    }
    const n = ++this.counter;
    const id = `${role ?? "worker"}-${n}`;
    const dn = displayName?.trim() || `${role ?? "worker"}-${n}`;
    const b = board ?? this.board; // 呼び出し元のスレッドのボード
    let worktreePath;
    try {
      worktreePath = await createWorktree({
        mainWorkspace: this.mainWorkspace,
        worktreeRoot: this.worktreeRoot,
        agentId: id,
      });
    } catch (err) {
      return { error: `worktreeの作成に失敗: ${err.message}` };
    }
    const agent = {
      id, displayName: dn,
      role: role ?? "impl",
      depth, parent: parent.id,
      personaText: WORKER_PERSONA(dn, role ?? "impl"),
      scenarioName: "chat",
    };
    this.live.set(id, { displayName: dn, depth, parent: parent.id, status: "working" });
    // ブリーフ=このエージェントの請求済みタスク。finish_taskで完了→main自動マージまで繋がる
    const projNote = project ? `文脈(project): ${project} — 追加のタスクを請求するときは project: ${project} で絞ること。\n\n` : "";
    this.tasks.assign({ agentId: id, taskId: `spawn-${id}`, project, body: `${projNote}スポーン元: ${parent.displayName}(${parent.id})\nロール: ${role ?? "impl"}\n\n${brief.trim()}` });
    this.bus.emit("agent.spawned", { agent: { id, displayName: dn, depth, parent: parent.id, role: agent.role } });
    b.post("system", `[スポーン] ${parent.displayName} が作業エージェント ${dn}(${id}) を作成しました。`);

    // 呼び出し元をブロックしない(縦の待ちを作らない)
    void this.runAgent(agent, worktreePath, brief.trim(), b);
    return { id, displayName: dn };
  }

  async runAgent(agent, worktreePath, brief, board = null) {
    const b = board ?? this.board;
    const model = this.modelFactory(agent);
    const tools = createTools({
      agent,
      workspace: worktreePath,
      mainWorkspace: this.mainWorkspace,
      board: b,
      tasks: this.tasks,
      bus: this.bus,
      gate: this.gate,
      spawner: this,
      mcpHosts: this.mcpHosts,
    });
    const shellKind = await tools.detectShell();
    const mem = this.memoryFn?.() ?? "";
    const messages = [
      { role: "system", content: mem ? `${buildSystemPrompt(agent, shellKind)}\n\n${mem}` : buildSystemPrompt(agent, shellKind) },
      { role: "user", content: `親(${agent.parent})からのブリーフです。まず gather_context でボード経過と関連素材を読み、必要な前提を集めてから着手してください:\n\n${brief}` },
    ];
    const loopOpts = {
      agent, model, tools,
      board: this.board, tasks: this.tasks, bus: this.bus,
      ledger: this.ledger, budget: this.budget,
      maxTurns: this.maxTurns, shellKind,
      contextWindow: this.contextWindow, thresholdPercent: this.thresholdPercent,
      messages,
      memory: mem || null, // 圧縮時の権威分離判定に使う
    };
    let r = await runAgentLoop(loopOpts);
    // ターン上限での中断は1回だけ自動継続(同じworktree・同じ記憶で)
    if (r.endedBy === "turn-limit") {
      messages.push({ role: "user", content: "[システム] ターン上限で中断しました。請求中のタスクがあれば続きを完了し、finish_task まで進めてください。" });
      r = await runAgentLoop(loopOpts);
    }
    // 継続しても完了できなかった場合、担当者はもう戻ってこないので請求中を解放する
    if (r.endedBy === "turn-limit" || r.endedBy === "budget" || r.endedBy === "error") {
      const released = this.tasks.release(
        agent.id,
        `[解放] 担当者(${agent.id})が終了したためopenへ戻しました。前走者の未反映作業は worktrees/${agent.id} にある場合があります。`
      );
      if (released.length) {
        b.post("system", `[解放] ${agent.id} 終了により ${released.join(", ")} をopenへ戻しました。誰でも請求できます。`);
      }
    }
    const e = this.live.get(agent.id);
    if (e) e.status = r.ok ? "done" : `ended:${r.endedBy ?? "error"}`;
    this.bus.emit("agent.exited", { agent: agent.id, ok: r.ok, endedBy: r.endedBy ?? r.error });
    await this.cleanupOrKeep(b, agent, worktreePath, r);
  }

  // 終了後のworktree後始末: 未コミット/未マージがゼロなら掃除、あるなら保持してボードに告知
  async cleanupOrKeep(board, agent, worktreePath, r) {
    try {
      const status = await runCommand({ command: "git status --porcelain", cwd: worktreePath, outputLimit: 2000 });
      const unmerged = await runCommand({ command: `git log main..agent/${agent.id} --oneline`, cwd: this.mainWorkspace, outputLimit: 2000 });
      const dirty = status.text.split("\n").slice(1).some((l) => l.trim());
      const hasCommits = unmerged.text.split("\n").slice(1).some((l) => l.trim());
      if (dirty || hasCommits) {
        board.post("system", `[保持] ${agent.displayName}(${agent.id}) のworktreeに未反映の作業があります(worktrees/${agent.id})。引き継ぐ場合はそちらから。`);
        return;
      }
      await runCommand({ command: `git worktree remove --force '${worktreePath}'`, cwd: this.mainWorkspace, outputLimit: 1000 });
      await runCommand({ command: `git branch -D agent/${agent.id} 2>/dev/null || true`, cwd: this.mainWorkspace, outputLimit: 1000 });
    } catch (err) {
      this.bus.emit("scenario.warn", { message: `worktreeの後始末に失敗(${agent.id}): ${err.message}` });
    }
  }

  snapshot() {
    return Object.fromEntries([...this.live].map(([id, v]) => [id, v]));
  }
}
