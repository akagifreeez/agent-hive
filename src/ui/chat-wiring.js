// chatコントローラ(runChatの戻り値)をUIサーバーのコールバック群へ翻訳する共通配線。
// デスクトップ殻と --chat CLI の両方から使う。片方だけ配線が欠けると
// 設定の保存(/api/model・/api/perm)やスレッド作成・画像添付が404になる、という事故の再発防止。
// 引数はコントローラそのものか、それを返す関数(UI立ち上げが先でcontrollerが後から入る場合
// は () => controller の関数を渡す。値渡しするとnullが固定されてしまう)。
export function chatUiHandlers(getController) {
  const c = () => (typeof getController === "function" ? getController() : getController);
  return {
    onSay: (text, thread) => c()?.say(text, thread),
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
  };
}
