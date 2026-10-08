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
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    return await new Promise((resolve) => {
      child.once("error", () => resolve(false));
      child.once("spawn", () => { child.unref(); resolve(true); });
    });
  } catch {
    return false;
  }
}

// ==== browser-tools: HTTPレベル内蔵ブラウザ操作(依存ゼロ) ====
// 実装は browser-tools.js(解析)・browser-net.js(通信)へ分離。ここから再公開する。
export {
  normalizeUrl,
  parsePage,
  extractElements,
  extractText,
  extractForm,
  applyFormValues,
  buildSubmission,
} from "./browser-tools.js";
export { browserFetch, browserExtract, browserSubmit } from "./browser-net.js";
