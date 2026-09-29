// メインチャット(v5): ユーザーが指示を送ると、常駐のメインエージェントが
// ラウンド(有限ターンの応答)を開始する。ラウンド間の記憶は各エージェントの
// messages配列として保持され、会話が続く限り積み上がる(v4.5のcompactが適用される)。
// 横つながりのルール: ユーザー入力は全メインに見え、@表示名で特定の仲間を呼べる。
// ラウンド中にスポーンされたサブの進捗もボードに流れ、次のラウンドで読まれる。
// v6.1: 各メインのmessagesはラウンド終了ごとに workspace/state/ へ保存し、
// 再起動時に復元する(チャットの記憶がプロセスをまたいで続く)。
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
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
    project = null, // スレッドスコープ(自動継続の「まだ仕事があるか」判定に使う)
    autoContinueRounds = 3, // ターン上限でも仕事が残っていれば自動で次ラウンドへ(0=従来どおり停止)
    hooks = null, // Hooksインスタンス(roundEndフック)
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
    this.project = project;
    this.autoContinueRounds = autoContinueRounds;
    this.hooks = hooks;
    this.worktreePaths = null; // runChatが後から設定できる(ラウンド終了マージ用)
    this.paused = false; // 一時停止中は新しい起床を潰す(実行中ラウンドはターン境界で自然終了)
    this.memories = new Map(); // id => messages配列(ラウンド間で保持)
    this.seen = new Map(); // id => ボード既読位置(ラウンド間で保持。配信はボード注入の1経路のみ)
    this.roundState = new Map(); // id => {running, pending[]}
    this.autoRounds = new Map(); // id => 連続自動継続ラウンド数(ユーザー起点ラウンドで0に戻る)
    for (const m of mains) this.seen.set(m.id, board.lastId());
    // ボード上の@表示名でメインを起こす(横つながりの入口)
    bus.on("board", (p) => this.handleBoardPost(p));
    // 新タスクの投入で自分のスレッド(と、共通の自動仕事)のメンバーを起こす。
    // これがないと全員退出後の発見器起票タスクが誰にも消化されない。
    bus.on("task.created", (p) => this.handleTaskCreated(p));
    // 解放(退場した担当者のタスクがopenへ戻る)でも同様に起こす。
    bus.on("task.released", (p) => this.handleTaskReleased(p));
  }

  // 新タスク投入時の起床: 自分のprojectのタスク、または全スレッド共通の自動仕事(fix/review/distill)のみ
  /**
   * @param {{taskId: string, project: string}} p
   */
  handleTaskCreated({ taskId, project }) {
    if (this.project && (project === this.project || /^(fix-|review-|distill-)/.test(taskId))) {
      for (const m of this.mains) {
        this.wake(m, `[システム] 新しいタスク ${taskId} が投入されました。claim_next_task で確認してください。`, 300);
      }
    }
  }

  // 解放タスクでの起床: 退場した担当者のタスクがopenへ戻ったら同じスレッドのメンバーを起こす。
  // task.createdだけだと「解放→誰にも起されず凍結」が起きる(r7で実際に発生)。
  /**
   * @param {{taskId: string}} p
   */
  handleTaskReleased({ taskId }) {
    if (!this.project) return;
    let t = null;
    try {
      t = this.tasks.list().open.find((x) => x.id === taskId);
    } catch {}
    if (!t && !/^(fix-|review-|distill-)/.test(taskId)) return;
    if (t && (t.project || "") !== this.project) return;
    for (const m of this.mains) {
      this.wake(m, `[システム] タスク ${taskId} がopenへ戻りました。claim_next_task で請求を検討してください。`, 300);
    }
  }

  memory(main) {
    if (!this.memories.has(main.id)) {
      const restored = this.loadMemories(main.id);
      if (restored) {
        this.memories.set(main.id, restored);
      } else {
        this.memories.set(main.id, [
          { role: "system", content: buildSystemPrompt(main, this.shellKind) },
          { role: "user", content: "あなたはメインチャットに常駐するエージェントとして活動を始めます。ユーザーや同僚の入力を待って応答・行動してください。" },
        ]);
      }
    }
    return this.memories.get(main.id);
  }

  // 会話メモリの保存/復元(workspace/state/mem-<id>.json)
  memPath(id) {
    return this.mainWorkspace ? join(this.mainWorkspace, "state", `mem-${id}.json`) : null;
  }

  loadMemories(id) {
    const p = this.memPath(id);
    if (!p) return null;
    try {
      const d = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(d.messages) && d.messages.length > 1) return d.messages;
    } catch {}
    return null;
  }

  saveMemories(main) {
    const p = this.memPath(main.id);
    if (!p || !this.memories.has(main.id)) return;
    try {
      mkdirSync(join(this.mainWorkspace, "state"), { recursive: true });
      // 一時ファイル経由の原子書込(クラッシュ時の半端JSONで復元が壊れるのを防ぐ)
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify({ messages: this.memories.get(main.id) }));
      renameSync(tmp, p);
    } catch {
      // 保存失敗でラウンドを壊さない
    }
  }

  // ユーザー入力: 全メインを時間差で起こす(同時だと議論にならないため)。
  // 本文はボード経由で1回だけ届く(seen管理)。キックオフは中身を持たない汎用文。
  say(text) {
    this.board.post("you", text);
    this.mains.forEach((m, i) => {
      this.wake(m, "[チャット] ユーザーからの新着入力があります。直前のボード新着を確認して応答してください。", i * this.staggerMs);
    });
  }

  // ボード上の@表示名で特定のメインを起こす。ただし自分のスレッドの投稿だけ
  // (他スレッドのボードで同名が呼ばれても起こされない)
  handleBoardPost(post) {
    if (post.from === "you") return; // ユーザー入力はsay()経由で処理済み
    if (post.thread !== this.board.name) return;
    for (const m of this.mains) {
      if (post.from === m.id) continue;
      if (post.text.includes(`@${m.displayName}`)) {
        this.wake(m, "[ボード] あなたが呼ばれました。直前のボード新着を確認して応答してください。", 800);
      }
    }
  }

  // 画像を添付する(全メインへ)。実行中はターン境界で、非実行なら次ラウンドの最初に渡る
  attachImage(note, dataUrl, uploadPath = null) {
    // ボードにも記録として残す(markdownの画像描画でストリームに表示される)
    if (uploadPath) this.board.post("you", `![画像添付](/${uploadPath})${note ? "\n\n" + note : ""}`);
    for (const m of this.mains) {
      const st = this.roundState.get(m.id) ?? { running: false, pending: [] };
      this.roundState.set(m.id, st);
      st.pending.push({
        role: "user",
        content: [
          { type: "text", text: `[画像添付] ${note ?? ""}` },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      });
      this.wake(m, "[画像添付] 画像を確認して応答してください。");
    }
  }

  // 一時停止/再開(Claude Squad手本の「コミットして止める/再開」の翻訳)。
  // 停止中はwake(指示・タスク投入・@呼び出し)を握り潰すのでトークンを消さない。
  // 記憶・タスク・ボードはそのままなので、再開すれば続きから働き直せる。
  setPaused(paused) {
    const was = this.paused;
    this.paused = Boolean(paused);
    this.board.post("system", this.paused
      ? "[一時停止] このスレッドの稼働を停止しました。再開までワーカーは新しい指示・タスクで動きません。"
      : "[再開] このスレッドの稼働を再開しました。");
    this.bus.emit("thread.paused", { name: this.board.name, paused: this.paused });
    // 停止中に握り潰した起床(指示・タスク投入・@呼び出し)をここで一括で拾い直す
    if (was && !this.paused) {
      for (const m of this.mains) this.wake(m, "[再開] 停止中のボード新着と未着手タスクを確認して作業を続けてください。");
    }
    return { ok: true, name: this.board.name, paused: this.paused };
  }

  wake(main, kickoffText, delayMs = 0) {
    if (this.paused) return; // 停止中の起床は握り潰す(再開後に改めて起こされる)
    const st = this.roundState.get(main.id) ?? { running: false, pending: [] };
    this.roundState.set(main.id, st);
    if (st.running) {
      st.pending.push(kickoffText);
      return;
    }
    st.running = true;
    this.autoRounds.set(main.id, 0); // ユーザー/ボード起点のラウンドでは連続回数をリセット
    const run = async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      let r = null; // 最後のラウンド結果(roundEndフックで参照)
      for (;;) {
        const messages = this.memory(main);
        // ラウンド開始ごとにシステムプロンプトを張り直す(永続記憶がdistillで更新されても次ラウンドから反映)
        if (this.memoryFn) {
          const mem = this.memoryFn();
          messages[0] = { role: "system", content: mem ? `${buildSystemPrompt(main, this.shellKind)}\n\n${mem}` : buildSystemPrompt(main, this.shellKind) };
        }
        messages.push({ role: "user", content: kickoffText });
        try {
          r = await runAgentLoop({
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
          drainInput: () => st.pending.splice(0), // ラウンド実行中の入力はターン境界で割込む(steering)
          peekInput: () => st.pending.length > 0, // idle退場が入力を捨てないための覗き見
        });
          // 既読位置をラウンド間で保持(同じ入力の二重配信を防ぐ)
        if (typeof r.seenBoard === "number") this.seen.set(main.id, r.seenBoard);
        // 会話メモリを永続化(再起動後も続きから)
        this.saveMemories(main);
        // ラウンドごとの消費を運用データとして記録(state/usage.json)
        if (this.ledger) {
          try {
            this.bus.emit("usage.round", { agent: main.id, endedBy: r?.endedBy ?? "ok", totals: this.ledger.agent(main.id) });
          } catch {}
        }
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
        } catch (err) {
          this.bus.emit("scenario.warn", { message: `ラウンド異常(${main.id}): ${err.message}` });
          // 理由を会話内にも見せる(scenario.warnだけだとチャット画面に出ず「返事がない」に見える:
          // モデル未接続の鍵エラー等はここで初めて利用者に届く)
          try {
            this.board.post("system", `[エラー] ${main.displayName}のラウンドが失敗しました: ${err.message}\n設定の「モデルと接続」から接続と鍵を確認してください。`);
          } catch { /* ボード書き込みに失敗しても元の例外を優先 */ }
        }
        // 自動継続: ターン上限で止まっても、まだ仕事が残っていれば次ラウンドへ(上限回数まで)
        let again = false;
        if (r?.endedBy === "turn-limit" && this.autoContinueRounds > 0) {
          const count = (this.autoRounds.get(main.id) ?? 0) + 1;
          const work = this.hasWork(main);
          if (work && count <= this.autoContinueRounds) {
            this.autoRounds.set(main.id, count);
            kickoffText = `[システム] 自動継続(${count}ラウンド目)。請求中タスクが残っていれば finish_task で完了し、無ければ claim_next_task で次を請求してください。`;
            again = true;
          } else if (work) {
            this.autoRounds.set(main.id, 0);
            this.board.post(main.id, `[自動継続停止] ${this.autoContinueRounds}ラウンド進めて一旦停止します。続きがあれば「続けて」と送ってください。`);
          } else {
            this.autoRounds.set(main.id, 0);
          }
        } else {
          this.autoRounds.set(main.id, 0);
        }
        if (!again) break;
      }
      // ラウンド終了フック(通知・記録などに使う。ブロックはしない)
      if (this.hooks?.has("roundEnd")) {
        await this.hooks.run("roundEnd", { AGENT: main.id, THREAD: this.board.name, ENDED_BY: r?.endedBy ?? "ok" }).catch(() => {});
      }
      st.running = false;
      const next = st.pending.shift();
      if (next) this.wake(main, next, 0);
    };
    void run();
  }

  // 自動継続を続けるべきか: 請求中タスクが残る/自分のスレッド(project)に未着手タスクがある
  hasWork(main) {
    try {
      if (this.tasks.claimedBy(main.id).length > 0) return true;
      if (this.project) {
        if (this.tasks.list().open.some((t) => (t.project || "") === this.project)) return true;
      }
    } catch {}
    return false;
  }
}
