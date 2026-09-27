// chatコントローラ(runChatの戻り値)をUIサーバーのコールバック群へ翻訳する共通配線。
// デスクトップ殻と --chat CLI の両方から使う。片方だけ配線が欠けると
// 設定の保存(/api/model・/api/perm)やスレッド作成・画像添付が404になる、という事故の再発防止。
// controllerはrunChat完了までnullのことがあるので、各呼び出しはoptional chainingで守る。
export function chatUiHandlers(controller) {
  return {
    onSay: (text, thread) => controller?.say(text, thread),
    onAttach: (path, dataUrl, note, thread) => controller?.attachImage(note, dataUrl, thread, path),
    onThread: (req) => controller?.openThread(req),
    onCloseThread: (req) => controller?.closeThread(req),
    onFolder: (req) => controller?.setThreadFolder(req),
    onModel: (patch) => controller?.setModel(patch),
    onPermMode: (mode) => controller?.setPermMode(mode),
    onWorkflow: (name) => controller?.runWorkflow(name),
    onListWorkflows: () => controller?.listWorkflows() ?? [],
    onFeedback: (req) => controller?.feedback(req),
    onThreadPause: (req) => controller?.setThreadPaused(req),
  };
}
