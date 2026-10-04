// シェル実行の共用層。ツールのbashも発見器のプローブもこれを使う。
// WindowsではGit Bashを自動検出してPOSIXコマンドを受けられるようにする。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

let cachedShell = null;
let bashCommand = "bash";

// PATH上のbashはWSLランチャーの場合がある。Gitの配置からネイティブのbashを先に探す。
export function gitBashCandidates(env = process.env) {
  const roots = [
    env.ProgramFiles && join(env.ProgramFiles, "Git"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Git"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Git"),
  ].filter(Boolean);
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    const path = dir.replace(/^"|"$/g, "");
    if (existsSync(join(path, "git.exe"))) roots.push(resolve(path, ".."));
  }
  return [...new Set(roots.flatMap((root) => [join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")]))];
}

function probeShell(command) {
  return new Promise((res) => {
    const p = spawn(command, ["-c", "echo __hive_ok__"], { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => { p.kill(); res(false); }, 5000);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => { clearTimeout(timer); res(false); });
    p.on("close", (code) => { clearTimeout(timer); res(code === 0 && out.includes("__hive_ok__")); });
  });
}

export async function detectShell() {
  if (cachedShell) return cachedShell;
  if (process.platform !== "win32") return (cachedShell = "bash");
  for (const command of [...gitBashCandidates().filter(existsSync), "bash"]) {
    if (await probeShell(command)) {
      bashCommand = command;
      return (cachedShell = "bash");
    }
  }
  return (cachedShell = "cmd");
}

/**
 * コマンドを実行する(outputLimitで出力を丸める)。cwd省略時はプロセスのカレント。
 * @param {{command: string, cwd?: string, env?: Object, outputLimit?: number, timeoutMs?: number}} o
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function runCommand({ command, cwd, timeoutMs = 30000, outputLimit = 8 * 1024, env = null }) {
  const kind = await detectShell();
  const child =
    kind === "bash"
      ? spawn(bashCommand, ["-c", command], { cwd, windowsHide: true, env: env ? { ...process.env, ...env } : undefined })
      : spawn(command, { shell: true, cwd, windowsHide: true, env: env ? { ...process.env, ...env } : undefined });
  let out = "";
  const append = (d) => {
    if (out.length < outputLimit) out += d.toString();
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return await new Promise((res) => {
    const timer = setTimeout(() => {
      child.kill();
      res({ ok: false, text: `タイムアウト(${timeoutMs}ms)で中断:\n${out.slice(0, outputLimit)}` });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      res({ ok: false, text: `起動エラー: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ ok: code === 0, text: `exit=${code}\n${out.slice(0, outputLimit)}` });
    });
  });
}
