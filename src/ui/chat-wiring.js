// chatコントローラ(runChatの戻り値)をUIサーバーのコールバック群へ翻訳する共通配線。
// デスクトップ殻と --chat CLI の両方から使う。片方だけ配線が欠けると
// 設定の保存(/api/model・/api/perm)やスレッド作成・画像添付が404になる、という事故の再発防止。
// 引数はコントローラそのものか、それを返す関数(UI立ち上げが先でcontrollerが後から入る場合
// は () => controller の関数を渡す。値渡しするとnullが固定されてしまう)。
export function chatUiHandlers(getController) {
  const c = () => (typeof getController === "function" ? getController() : getController);
  // UI立ち上げが先・controller(runChatの戻り値)は後から入るため、接続までの間
  // /api/sayはok:trueだけ返して入力を黙って捨てていた。queueに貯め、controller代入後に
  // 呼び出し側がflushPendingSay()で配信する(起動直後の「送ったのに届かない」対策)。
  const pending = [];
  const PENDING_CAP = 50;
  return {
    onSay: (text, thread) => {
      const ctl = c();
      if (ctl) return ctl.say(text, thread);
      if (pending.length >= PENDING_CAP) pending.shift(); // 溢れたら最古を落とす(controllerが一度も入らない起動失敗でも無限に育てない)
      pending.push({ text, thread });
    },
    onAttach: (path, dataUrl, note, thread) => c()?.attachImage(note, dataUrl, thread, path),
    onThread: (req) => c()?.openThread(req),
    onDiscuss: (req) => c()?.runDiscussion(req),
    onCloseThread: (req) => c()?.closeThread(req),
    onFolder: (req) => c()?.setThreadFolder(req),
    onModel: (patch) => c()?.setModel(patch),
    onPermMode: (mode) => c()?.setPermMode(mode),
    onWorkflow: (name) => c()?.runWorkflow(name),
    onListWorkflows: () => c()?.listWorkflows() ?? [],
    onFeedback: (req) => c()?.feedback(req),
    onThreadPause: (req) => c()?.setThreadPaused(req),
    onMcpList: () => c()?.mcpList() ?? [],
    onMcpAdd: (req) => c()?.mcpAdd(req),
    onMcpRemove: (req) => c()?.mcpRemove(req),
    // controller(runChat)完了の直後に呼ぶ。接続前にqueueされた入力を到着順で配信する
    flushPendingSay: () => {
      const ctl = c();
      if (!ctl) return 0;
      let n = 0;
      while (pending.length) {
        const { text, thread } = pending.shift();
        ctl.say(text, thread);
        n++;
      }
      return n;
    },
    pendingSayCount: () => pending.length,
  };
}
