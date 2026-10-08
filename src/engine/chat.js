// メインチャット(v5): ユーザーが指示を送ると、常駐のメインエージェントが
// ラウンド(有限ターンの応答)を開始する。ラウンド間の記憶は各エージェントの
// messages配列として保持され、会話が続く限り積み上がる(v4.5のcompactが適用される)。
// 横つながりのルール: ユーザー入力は全メインに見え、@表示名で特定の仲間を呼べる。
// ラウンド中にスポーンされたサブの進捗もボードに流れ、次のラウンドで読まれる。
// v6.1: 各メインのmessagesはラウンド終了ごとに workspace/state/ へ保存し、
// 再起動時に復元する(チャットの記憶がプロセスをまたいで続く)。
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runAgentLoop, buildSystemPrompt } from "./loop.js";
import { createTools } from "./tools.js";
import { mergeAgentWork } from "./worktree.js";
import { pruneMemories } from "./compact.js";

export class ChatHost {
  constructor({
    mains, // [{id, displayName, role, depth:0, personaPath}]
    mainWorkspace = null, // 指定時: 各ラウンド終了後にメインの作業をmainへ自動マージ
    modelFactory, toolsFactory, board, tasks, bus,
    ledger = null, budget = null,
    maxTurnsPerRound = 12, contextWindow = 200000, thresholdPercent,
    shellKind = "bash", staggerMs = 3000,
    memoryFn = null, // () => 永続記憶の注入文脈。ラウンド開始ごとに読み直す(distill反映のため)
    config = null,
    chatConfig = null, // 直接渡すchat設定(memMaxMessages等)。config.chatより優先 // HiveConfig(会話メモリの上限設定chat.memMax*を読む)
    project = null, // スレッドスコープ(自動継続の「まだ仕事があるか」判定に使う)
    autoContinueRounds = 3, // ターン上限でも仕事が残っていれば自動で次ラウンドへ(0=従来どおり停止)
    autoResume = null, // 停止後の自動再開({enabled,delaySec,maxConsecutive})。「続けて」待ちの無駄時間を解消する
    hooks = null, // Hooksインスタンス(roundEndフック)
    approvals = null, // 承認フロー状態(runner.jsの共有オブジェクト)。ラウンド末マージの保留判定に使う(イシュー#22)
    landingSignal = null, // テスト起点: () => 着地(タスクdone/マージ/コミット)を報せる。ラウンド中に真を返したら着地あり
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
    this.config = config;
    this.chatConfig = chatConfig;
    this.project = project;
    this.autoContinueRounds = autoContinueRounds;
    this.autoResume = normalizeAutoResume(autoResume); // 停止後の自動再開設定(無効時は従来どおり停止)
    this.sessionLogCfg = config?.sessionLog ?? null; // session-logの世代数/上限(config.sessionLog)
    this.autoResumes = new Map(); // id => 連続自動再開回数(着地で回復・外部起点のwakeでリセット)
    this._autoResumeTimers = new Set(); // 待機中の再開タイマー(disposeで解除)
    this.hooks = hooks;
    this.worktreePaths = null; // runChatが後から設定できる(ラウンド終了マージ用)
    this.paused = false; // 一時停止中は新しい起床を潰す(実行中ラウンドはターン境界で自然終了)
    this.disposed = false; // dispose後は閉鎖スレッド。新しい起床・sayを一切起こさない(イシュー#29)
    this.unsubs = []; // bus購読の解除関数(disposeで全解除)
    const effChat = this.chatConfig ?? this.config?.chat ?? null; // chatConfig(直接)/config.chat の両対応
    this.memPrune = { // 会話メモリの刈り取り設定(イシュー#20)。0/nullで無効化可
      maxMessages: effChat?.memMaxMessages ?? 200,
      maxBytes: effChat?.memMaxBytes ?? 512 * 1024,
    };
    this.memories = new Map(); // id => messages配列(ラウンド間で保持)
    this.seen = new Map(); // id => ボード既読位置(ラウンド間で保持。配信はボード注入の1経路のみ)
    this.roundState = new Map(); // id => {running, pending[]}
    this.autoRounds = new Map(); // id => 連続自動継続ラウンド数(ユーザー起点ラウンドで0に戻る)
    this.landingSignal = landingSignal; // null可(未指定時はイベント購読のみ)
    this.landedThisRound = new Map(); // id => 直前ラウンドに着地(タスクdone/マージ完了)があったか(進捗ゲート用)
    this.approvals = approvals; // 承認フロー(null可=無効。ラウンド末マージの保留判定)
    this._subscriptions = []; // 購読解除ハンドラ(unsubscribe()で解除。イシュー#29)
    for (const m of mains) {
      this.seen.set(m.id, board.lastId());
      this.landedThisRound.set(m.id, false); // 着地フラグの初期値(進捗ゲート)
    }
    // ボード上の@表示名でメインを起こす(横つながりの入口)
    this._subscriptions.push(bus.on("board", (p) => this.handleBoardPost(p)));
    // 新タスクの投入で自分のスレッド(と、共通の自動仕事)のメンバーを起こす。
    // これがないと全員退出後の発見器起票タスクが誰にも消化されない。
    this._subscriptions.push(bus.on("task.created", (p) => this.handleTaskCreated(p)));
    // 進捗ゲート(自動継続の着地検出): タスク完了とラウンド末mainマージを着地として記録する。
    // landedThisRoundはwake()でリセットし、ラウンド中の実績だけを次判定に使う。
    this._subscriptions.push(bus.on("task.finished", (p) => this.noteLanding(p.agent)));
    // テスト起点: ChatHost外(ユニットテスト等)から着地を直接報せる入口(進捗ゲートの観測点)。
    this._subscriptions.push(bus.on("agent.merged", (p) => this.noteLanding(p.agent)));
    // create_task(新しい仕事の発生)も着地として扱う: 「次にやることが生まれた」のは進捗。
    // これが無いと「探索ラウンドで新タスクを起票→次ラウンドで着手」の正当な循環が止まる。
    this._subscriptions.push(bus.on("task.created", (p) => this.noteLanding(null)));
    // 解放(退場した担当者のタスクがopenへ戻る)でも同様に起こす。
    this._subscriptions.push(bus.on("task.released", (p) => this.handleTaskReleased(p)));
  }

  // 購読解除: 閉じたスレッドのHostがboard/taskイベントで再び動かないようにする(イシュー#29)。
  // runner.jsのcloseThreadから呼ばれる。二重呼び出しは安全(no-op)。
  // dispose: unsubscribeの別名(イシュー#29のテスト・runner.js双方から呼ばれる名称)。二重呼び出し安全。
  dispose() { this.unsubscribe(); }

  unsubscribe() {
    if (this._unsubscribed) return;
    this._unsubscribed = true;
    this.disposed = true; // dispose()別名経路でも閉鎖フラグを立てる(say/wakeの二重防御)
    for (const t of this._autoResumeTimers ?? []) clearTimeout(t);
    this._autoResumeTimers?.clear();
    for (const off of this._subscriptions ?? []) {
      try { off?.(); } catch { /* 解除失敗は無視(既に外れている) */ }
    }
    this._subscriptions = [];
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
      // ラウンドをまたぐ肥大止め(イシュー#20): 上限超過時は古い分を刈り取り、
      // in-memoryと永続化の両方へ反映する(復元時に再肥大しない)
      const pruned = pruneMemories(this.memories.get(main.id), this.memPrune);
      if (pruned.changed) {
        this.memories.set(main.id, pruned.messages);
        this.bus.emit("memory.pruned", { agent: main.id, removed: pruned.removed, messages: pruned.messages.length });
      }
      // 一時ファイル経由の原子書込(クラッシュ時の半端JSONで復元が壊れるのを防ぐ)
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify({ messages: this.memories.get(main.id) }));
      renameSync(tmp, p);
    } catch {
      // 保存失敗でラウンドを壊さない
    }
  }

  // ラウンドcheckpoint(イシュー#4): ツール実行済みmessagesのスナップショット。
  // モデル異常で中断したラウンドをスナップショット地点から再開するためのもの。
  checkpointPath(id) {
    return join(this.mainWorkspace ?? ".", "state", `checkpoint-${id}.json`);
  }

  saveCheckpoint(main, messages) {
    const p = this.checkpointPath(main.id);
    if (!p) return;
    try {
      mkdirSync(join(p, ".."), { recursive: true });
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify({ messages }));
      renameSync(tmp, p);
    } catch { /* 保存失敗でラウンドを壊さない */ }
  }

  loadCheckpoint(id) {
    const p = this.checkpointPath(id);
    if (!p) return null;
    try {
      const d = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(d.messages) && d.messages.length > 1) {
        // 復元でもsaveMemoriesと同じ上限を適用する(イシュー#21): 上限超過のスナップショットを
        // そのまま積むと、復元を起点に再肥大する。超過分はここで刈っておく。
        const pruned = pruneMemories(d.messages, this.memPrune);
        return pruned.messages;
      }
    } catch {}
    return null;
  }

  clearCheckpoint(id) {
    const p = this.checkpointPath(id);
    if (!p) return;
    try { rmSync(p, { force: true }); } catch {}
  }
  // ユーザー入力: 全メインを時間差で起こす(同時だと議論にならないため)。
  // イシュー#21: ボード側はslice(0,6000)打ち切り+seen進行を持ち、巨大worker投稿の影で
  // 質問本文は実行中ならsteering([入力])で、未実行ならkickoffへ載せて届ける(二重配信しない)。
  say(text) {
    if (this.disposed) return { ok: false, error: `スレッド ${this.board.name} は閉じられています` }; // 閉鎖後の入力は無効(イシュー#29)
    // 破損入力(U+FFFD等)の検知(イシュー#20 提案3): 化けた入力をそのまま渡すと
    // リーダーが断片から主題を推測して答えてしまうため、注入文へ明示的に警告を載せる。
    const broken = detectBrokenInput(text)
      ? "\n[警告] この入力は文字化け(エンコード破損)で入力が壊れていて読めない。推測で応答せず、ユーザーに文面の再送を求めてください。"
      : "";
    this.board.post("you", text);
    this.mains.forEach((m, i) => {
      const bodyText = this.roundState.get(m.id)?.running ? "" : "\n[入力] " + text;
      this.wake(m, "[チャット] ユーザーからの新着入力があります。ユーザー入力を最優先で応答してください。直近のワーカー投稿は触れなくてよい(必要なら後でまとめて)。" + bodyText + broken, i * this.staggerMs);
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

  wake(main, kickoffText, delayMs = 0, opts = {}) {
    if (this.disposed) return; // 閉鎖済みスレッドの再循環を遮断(イシュー#29)
    if (this.paused) return; // 停止中の起床は握り潰す(再開後に改めて起こされる)
    const st = this.roundState.get(main.id) ?? { running: false, pending: [] };
    this.roundState.set(main.id, st);
    if (st.running) {
      st.pending.push(kickoffText);
      return;
    }
    st.running = true;
    st.lastKickoff = kickoffText; // 直近ラウンドの注入文(観測・テスト用)
    this.autoRounds.set(main.id, 0); // ユーザー/ボード起点のラウンドでは連続回数をリセット
    if (!opts?.auto) this.autoResumes.set(main.id, 0); // 外部起点のwakeは自動再開の連続回数も回復させる
    this.landedThisRound.set(main.id, false); // ラウンド開始で着地フラグをリセット(ラウンド中の実績だけを見る)
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
            sessionLogKeep: this.sessionLogCfg?.keep ?? null,
            sessionLogMaxBytes: this.sessionLogCfg?.maxBytes ?? null,
          messages,
          seenBoard: this.seen.get(main.id) ?? null,
          memory: this.memoryFn?.() ?? null, // 圧縮時の権威分離判定に使う
          drainInput: () => st.pending.splice(0), // ラウンド実行中の入力はターン境界で割込む(steering)
          peekInput: () => st.pending.length > 0, // idle退場が入力を捨てないための覗き見
          checkpointFn: (msgs) => this.saveCheckpoint(main, msgs), // ツール実行済み地点のスナップショット(イシュー#4)
        });
          // 既読位置をラウンド間で保持(同じ入力の二重配信を防ぐ)。
        // クランプ: /clearでボードが空になり投稿idが1から再採番されるため、走行中ラウンドが
        // 旧値(例: 150)を持ち越すとsince(150)が空になり新着が一切注入されなくなる。
        // board.lastId()へ下げるだけでよい(クリア後に蓄積した新着はlastId以降に含まれる)
        // モデル異常で中断したラウンドはスナップショットから復元する(イシュー#4)。
        // kickoff文を積み直す前のmemoriesをスナップショットで差し替えることで、
        // 「ツール実行済み地点から再開」になりkickoffの二重積みも起きない。
        // checkpointファイルは削除する(復元済み。残すと失敗が無限ループする)。
        if (r?.endedBy === "error") {
          const snap = this.loadCheckpoint(main.id);
          if (snap) {
            this.memories.set(main.id, snap);
            this.clearCheckpoint(main.id);
            this.bus.emit("checkpoint.restored", { agent: main.id, messages: snap.length });
          }
        } else {
          // 正常系: スナップショットはもう要らない
          this.clearCheckpoint(main.id);
        }
        if (typeof r.seenBoard === "number") this.seen.set(main.id, Math.min(r.seenBoard, this.board.lastId()));
        // 会話メモリを永続化(再起動後も続きから)
        this.saveMemories(main);
        // ラウンドごとの消費を運用データとして記録(state/usage.json)
        if (this.ledger) {
          try {
                        // totalsは台帳エントリのスナップショット(UsageLedger.agentはライブ参照を返すため、
            // そのまま乗せると後続ラウンドの更新で過去イベントのtotalsまで変異する)。
            this.bus.emit("usage.round", { agent: main.id, thread: this.project ?? "__main__", endedBy: r?.endedBy ?? "ok", totals: { ...this.ledger.agent(main.id) }, delta: r?.usage ?? null });
          } catch {}
        }
          // メインが自ら直接作業した場合の受け皿: ラウンド終了時にmainへ自動マージ
          // 承認フロー(approvals.require)有効時は、この実装者が保留中(検証待ち)のタスクを
          // 持つ間はマージしない(イシュー#22): 検証承認後(approve_task)にだけmainへ入る。
          // worktree未作成ならマージせずスキップ(origin/mainのガード)。
          const heldByApproval = this.approvals?.require
            ? [...(this.approvals.pending ?? [])].some(([, p]) => p.agentId === main.id)
            : false;
          if (this.mainWorkspace && !heldByApproval && this.worktreePaths?.[main.id]) {
            const m = await mergeAgentWork({
              mainWorkspace: this.mainWorkspace,
              worktreePath: this.worktreePaths?.[main.id],
              agent: main,
              taskId: "chat-round",
            });
            if (m.ok && m.merged) {
              this.bus.emit("agent.merged", { agent: main.id, thread: this.board.name }); // 着地(進捗ゲート)
              this.board.post("system", `[マージ] ${main.displayName} がラウンド中の作業を main へ取り込みました。`);
            }
          } else if (heldByApproval) {
            // 承認待ちで保留した旨を見える化(黙ってマージされない状態で混乱させない)
            this.board.post("system", `[承認待ち] ${main.displayName} のラウンド作業は検証承認待ちのためmainへの取り込みを保留しました。`);
          }
        } catch (err) {
          this.bus.emit("scenario.warn", { message: `ラウンド異常(${main.id}): ${err.message}` });
          // 理由を会話内にも見せる(scenario.warnだけだとチャット画面に出ず「返事がない」に見える:
          // モデル未接続の鍵エラー等はここで初めて利用者に届く)
          try {
            this.board.post("system", `[エラー] ${main.displayName}のラウンドが失敗しました: ${err.message}\n設定の「モデルと接続」から接続と鍵を確認してください。`);
          } catch { /* ボード書き込みに失敗しても元の例外を優先 */ }
        }
        // 自動継続(進捗ゲート): ターン上限で止まっても「直前ラウンドに着地(進捗)があった」
        // ときだけ次ラウンドへ。着地ゼロのラウンドでは静止(これ以上続けても進まないため)。
        // autoContinueRounds はハード上限として残す(着地ありでも上限に達したら停止)。
        let again = false;
        if (r?.endedBy === "turn-limit" && this.autoContinueRounds > 0) {
          const count = (this.autoRounds.get(main.id) ?? 0) + 1;
          const work = this.hasWork(main);
          const landed = this.landedThisRound.get(main.id) === true || this.landingSignal?.() === true;
          this.landedThisRound.set(main.id, false); // 着地フラグは1判定で消費する
          if (work && landed && count <= this.autoContinueRounds) {
            this.autoRounds.set(main.id, count);
            kickoffText = `[システム] 自動継続(${count}ラウンド目)。請求中タスクが残っていれば finish_task で完了し、無ければ claim_next_task で次を請求してください。`;
            st.lastKickoff = kickoffText; // 継続ノートも観測・テスト契約に反映
            again = true;
          } else if (work) {
            this.autoRounds.set(main.id, 0);
            const reason = landed ? "ハード上限" : "着地ゼロ(進捗なし)";
            this.board.post(main.id, `[自動継続停止(${reason})] ${this.autoContinueRounds}ラウンド進めて一旦停止します。続きがあれば「続けて」と送ってください。`);
            this.bus.emit("round.stalled", { agent: main.id, reason, rounds: this.autoContinueRounds }); // 通知経路(停止系)
            this.scheduleAutoResume(main, landed); // 仕事が残る停止は自動再開で無駄時間を埋める(設定無効時は従来どおり)
          } else {
            // 仕事が無い場合もここで静止(着地ゼロと同じ経路。通知は出さない=元仕様)。
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

  // 着地(ランディング)検出: タスクdone(task.finished)・mainマージ(agent.merged)・
  // コミット等(landingSignalをゲート判定時に評価)の3経路を1か所に集約する。
  // agent指定時は自分に関係ないイベントを無視(agentが無い場合のみ全体として記録)。
  noteLanding(agent = null) {
    if (agent == null || this.mains.some((m) => m.id === agent)) {
      for (const m of this.mains) this.landedThisRound.set(m.id, true);
    }
  }

  // 自動継続を続けるべきか: 請求中タスクが残る/自分のスレッド(project)に「誰かが請求できる」未着手タスクがある。
  // role一致も見る(検証役不在で宙吊りのrole:reviewタスクを実装役の仕事と数えない)。ただし
  // リーダー(role:lead)はロール不問=検証役のスポーン自体が仕事なので全openを数える。
  hasWork(main) {
    try {
      if (this.tasks.claimedBy(main.id).length > 0) return true;
      const roles = new Set(this.mains.map((m) => m.role).filter(Boolean));
      const coord = this.mains.some((m) => m.role === "lead");
      const open = this.tasks.list().open ?? [];
      return open.some((t) => {
        if (this.project && (t.project || "") !== this.project) return false;
        if (!t.role) return true;
        return coord || roles.has(t.role);
      });
    } catch {}
    return false;
  }

  // 停止後の自動再開(無駄時間の解消): 「続けて」待ちで誰も動かない時間を埋める。
  // 連続回数は着地(進捗)で回復・外部起点のwakeでも回復するため、進み続ける限り止まらない。
  // 上限に達したら本当に停止し通知する(暴走はautoResume.maxConsecutiveで抑える)。
  scheduleAutoResume(main, landed) {
    const ar = this.autoResume;
    if (!ar?.enabled) return;
    if (landed) this.autoResumes.set(main.id, 0); // 進捗があった停止は予算を回復
    const count = (this.autoResumes.get(main.id) ?? 0) + 1;
    if (count > ar.maxConsecutive) {
      this.autoResumes.set(main.id, 0);
      this.board.post(main.id, `[自動再開停止] 自動再開${ar.maxConsecutive}回でも仕事が消化できませんでした。「続けて」で再開してください。`);
      this.bus.emit("round.stalled", { agent: main.id, reason: "自動再開上限", rounds: ar.maxConsecutive });
      return;
    }
    this.autoResumes.set(main.id, count);
    const t = setTimeout(() => {
      this._autoResumeTimers.delete(t);
      if (this.disposed || this.paused) return; // 閉鎖・一時停止時は再開しない
      if (!this.hasWork(main)) return; // 待機中に仕事が無くなったら何もしない
      this.wake(main, `[システム] 自動再開(${count}/${ar.maxConsecutive})。未着手・請求中のタスクが残っているため作業を続けてください。`, 0, { auto: true });
    }, ar.delaySec * 1000);
    t.unref?.(); // タイマーでプロセスを保持しない(終了妨害の防止)
    this._autoResumeTimers.add(t);
  }
}

// 破損入力検知(イシュー#20 提案3): エンコード破損でテキストがU+FFFD(置換文字)へ化けた入力を
// 検知する。化けた入力をそのまま渡すとリーダーが断片から主題を推測してしまうため、
// say()注入時に警告文を付けて「再送を求める」運用へ切り替える。
// 加えて UTF-8→cp932 二重エンコードの典型兆候(日本語UTF-8先頭バイト由来のラテン文字塊)も検知。
// ===== 会話メモリの刈り取り(イシュー#20-2: mem-*.json 肥大化対策)=====

// mem-<id>.json の既定上限(メッセージ数)。chat.memMaxMessages で上書きできる。
export const DEFAULT_MEM_MAX_MESSAGES = 200;

// ボード投稿参照(番号単独)の検出。刈り取り要約時にラベル付きへ補正する。
export const MEM_REF_RE = /(?:ボード|board)?#(\d{1,4})(?!\d)(?!\s*\()/g;

// メッセージ配列を1行ずつ要約する(LLM不要の手軽方式)。参照はラベル/日時付きへ補正。
function summarizeForPrune(messages, boardName) {
  const lines = [];
  for (const m of messages) {
    const text = String(m.content ?? "").replace(/s+/g, " ").trim();
    if (!text) continue;
    const labeled = text.replace(MEM_REF_RE, (all) => all + "(" + (boardName ?? "main") + "・日時不明)");
    lines.push((m.role === "user" ? "- 入力: " : "- 応答: ") + labeled.slice(0, 160));
  }
  return lines.join("\n");
}

// ラウンド境界の記憶刈り取り。上限超過時は「system + 要約 + 直近分」へ縮める。
// @returns messages(非配列はnull)。上限以内なら同一配列をそのまま返す。
export function trimMemories(messages, opts = {}) {
  if (!Array.isArray(messages)) return null;
  const max = Math.max(4, Number(opts.memMaxMessages ?? DEFAULT_MEM_MAX_MESSAGES));
  if (messages.length <= max) return messages;
  const system = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m !== system);
  const pruned = rest.slice(0, Math.max(1, rest.length - (max - (system ? 1 : 0) - 2)));
  const kept = rest.slice(-Math.max(0, max - (system ? 1 : 0) - 2));
  const summary = summarizeForPrune(pruned, opts.boardName);
  const note = { role: "user", content: "[Memory pruned] 古い会話を要約しました(参照はボード名・日時付き)。\n" + summary };
  return [
    ...(system ? [system] : []),
    note,
    ...kept,
  ];
}

// U+FFFD(置換文字)を含むか。エンコード壊れの決定打。
export function containsReplacementChar(text) {
  return typeof text === "string" && text.includes(String.fromCharCode(0xfffd));
}

// 自動再開設定の正規化(config.chat.autoResume)。既定は無効(従来どおり「続けて」待ち)。
export function normalizeAutoResume(cfg) {
  if (!cfg || typeof cfg !== "object") return { enabled: false, delaySec: 120, maxConsecutive: 3 };
  const n = (v, d, lo, hi) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.floor(x))) : d;
  };
  return {
    enabled: cfg.enabled === true,
    delaySec: n(cfg.delaySec, 120, 0, 3600),
    maxConsecutive: n(cfg.maxConsecutive, 3, 1, 10),
  };
}

// UTF-8→cp932二重エンコードの兆候(置換文字なしでも化け型を拾う)。
export function looksDoubleEncoded(text) {
  return detectBrokenInput(text) && !containsReplacementChar(text);
}

// say()注入文へ付ける警告。検知しなければnull。
export function mojibakeWarning(text) {
  if (!detectBrokenInput(text)) return null;
  return "[警告] この入力は文字化けしている可能性があり、入力が壊れていて読めない。推測で応答せず、ユーザーに文面の再送を求めること。";
}

export function detectBrokenInput(text) {
  if (!text || typeof text !== "string") return false;
  if (text.includes("�")) return true; // 置換文字=確実な破損
  // 二重エンコード兆候: UTF-8のマルチバイト先頭バイトが cp932 再解読で Ã/ã/å/æ/ç 系に化ける。
  // その文字が高密度(全体の75%以上)で出現する=日本語文ではなく化けの塊とみなす。
  // 対象は Latin-1補助(U+00C0-U+00FF)+ Latin-1領域の記号(U+00A0-U+00BF)。
  // UTF-8バイト列をcp932/Latin-1で再解読するとこの帯に落ちるのが典型(テ→Ã¦Â¥Â¹等)。
  // 通常の日本語・英語・絵文字テキストにはほぼ出現しない。
  const m = text.match(/[\u00a0-\u00ff]/g);
  if (!m || m.length < 3) return false; // 散発1-2個は通常の欧文
  // 密度: Ã/ã等の化け文字が文字種の過半を占める(日本語本文が混じると下がる)。
  // ただし「化け塊+少量の記号」も捉えたいので、出現数が6個以上なら密度に関わらず検知。
  return m.length >= 6 || m.length / text.length >= 0.5;
}
