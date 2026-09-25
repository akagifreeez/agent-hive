// メインチャット(v5): ユーザーが指示を送ると、常駐のメインエージェントが
// ラウンド(有限ターンの応答)を開始する。ラウンド間の記憶は各エージェントの
// messages配列として保持され、会話が続く限り積み上がる(v4.5のcompactが適用される)。
// 横つながりのルール: ユーザー入力は全メインに見え、@表示名で特定の仲間を呼べる。
// ラウンド中にスポーンされたサブの進捗もボードに流れ、次のラウンドで読まれる。
import { runAgentLoop, buildSystemPrompt } from "./loop.js";
import { createTools } from "./tools.js";
import { mergeAgentWork } from "./worktree.js";

export class ChatHost {
  constructor({
    mains, // [{id, displayName, role, depth:0, personaPath}]
    mainWorkspace = null, // 指定時: 各ラウンド終了後にメインの作業をmainへ自動マージ
    modelFactory, toolsFactory, board, tasks, bus,
    ledger = null, budget = null,
    maxTurnsPerRound = 12, contextWindow = 200000, thresholdPercent,
    shellKind = "bash", staggerMs = 3000,
    memoryFn = null, // () => 永続記憶の注入文脈。ラウンド開始ごとに読み直す(distill反映のため)
  }) {
    this.mains = mains;
    this.mainWorkspace = mainWorkspace;
    this.modelFactory = modelFactory;
    this.toolsFactory = toolsFactory;
    this.board = board;
    this.tasks = tasks;
    this.bus = bus;
    this.ledger = ledger;
    this.budget = budget;
    this.maxTurnsPerRound = maxTurnsPerRound;
    this.contextWindow = contextWindow;
    this.thresholdPercent = thresholdPercent;
    this.shellKind = shellKind;
    this.staggerMs = staggerMs;
    this.memoryFn = memoryFn;
    this.worktreePaths = null; // runChatが後から設定できる(ラウンド終了マージ用)
    this.memories = new Map(); // id => messages配列(ラウンド間で保持)
    this.seen = new Map(); // id => ボード既読位置(ラウンド間で保持。配信はボード注入の1経路のみ)
    this.roundState = new Map(); // id => {running, pending[]}
    for (const m of mains) this.seen.set(m.id, board.lastId());
    // ボード上の@表示名でメインを起こす(横つながりの入口)
    bus.on("board", (p) => this.handleBoardPost(p));
  }

  memory(main) {
    if (!this.memories.has(main.id)) {
      this.memories.set(main.id, [
        { role: "system", content: buildSystemPrompt(main, this.shellKind) },
        { role: "user", content: "あなたはメインチャットに常駐するエージェントとして活動を始めます。ユーザーや同僚の入力を待って応答・行動してください。" },
      ]);
    }
    return this.memories.get(main.id);
  }

  // ユーザー入力: 全メインを時間差で起こす(同時だと議論にならないため)。
  // 本文はボード経由で1回だけ届く(seen管理)。キックオフは中身を持たない汎用文。
  say(text) {
    this.board.post("you", text);
    this.mains.forEach((m, i) => {
      this.wake(m, "[チャット] ユーザーからの新着入力があります。直前のボード新着を確認して応答してください。", i * this.staggerMs);
    });
  }

  // ボード上の@表示名で特定のメインを起こす
  handleBoardPost(post) {
    if (post.from === "you") return; // ユーザー入力はsay()経由で処理済み
    for (const m of this.mains) {
      if (post.from === m.id) continue;
      if (post.text.includes(`@${m.displayName}`)) {
        this.wake(m, "[ボード] あなたが呼ばれました。直前のボード新着を確認して応答してください。", 800);
      }
    }
  }

  wake(main, kickoffText, delayMs = 0) {
    const st = this.roundState.get(main.id) ?? { running: false, pending: [] };
    this.roundState.set(main.id, st);
    if (st.running) {
      st.pending.push(kickoffText);
      return;
    }
    st.running = true;
    const run = async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const messages = this.memory(main);
      // ラウンド開始ごとにシステムプロンプトを張り直す(永続記憶がdistillで更新されても次ラウンドから反映)
      if (this.memoryFn) {
        const mem = this.memoryFn();
        messages[0] = { role: "system", content: mem ? `${buildSystemPrompt(main, this.shellKind)}\n\n${mem}` : buildSystemPrompt(main, this.shellKind) };
      }
      messages.push({ role: "user", content: kickoffText });
      try {
        const r = await runAgentLoop({
          agent: main,
          model: this.modelFactory(main),
          tools: this.toolsFactory(main),
          board: this.board,
          tasks: this.tasks,
          bus: this.bus,
          ledger: this.ledger,
          budget: this.budget,
          maxTurns: this.maxTurnsPerRound,
          shellKind: this.shellKind,
          contextWindow: this.contextWindow,
          thresholdPercent: this.thresholdPercent,
          messages,
          seenBoard: this.seen.get(main.id) ?? null,
          memory: this.memoryFn?.() ?? null, // 圧縮時の権威分離判定に使う
        });
        // 既読位置をラウンド間で保持(同じ入力の二重配信を防ぐ)
        if (typeof r.seenBoard === "number") this.seen.set(main.id, r.seenBoard);
        // メインが自ら直接作業した場合の受け皿: ラウンド終了時にmainへ自動マージ
        if (this.mainWorkspace) {
          const m = await mergeAgentWork({
            mainWorkspace: this.mainWorkspace,
            worktreePath: this.worktreePaths?.[main.id],
            agent: main,
            taskId: "chat-round",
          });
          if (m.ok && m.merged) {
            this.board.post("system", `[マージ] ${main.displayName} がラウンド中の作業を main へ取り込みました。`);
          }
        }
      } finally {
        st.running = false;
      }
      const next = st.pending.shift();
      if (next) this.wake(main, next, 0);
    };
    void run();
  }
}
