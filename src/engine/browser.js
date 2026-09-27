// URLをOS既定のブラウザで開く。プラットフォーム別コマンドをspawnするだけの薄いラッパ。
// テスト容易性のため、openInBrowser(url, runner) のrunner差し替えを許す。
import { spawn } from "node:child_process";

export function defaultOpenCommand(url) {
  if (process.platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  if (process.platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}

export async function openInBrowser(url, runner = defaultOpenCommand) {
  try {
    const { cmd, args } = runner(url);
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
