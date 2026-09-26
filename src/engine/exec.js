// シェル実行の共用層。ツールのbashも発見器のプローブもこれを使う。
// WindowsではGit Bashを自動検出してPOSIXコマンドを受けられるようにする。
import { spawn } from "node:child_process";

let cachedShell = null;

export async function detectShell() {
  if (cachedShell) return cachedShell;
  if (process.platform !== "win32") return (cachedShell = "bash");
  cachedShell = await new Promise((res) => {
    const p = spawn("bash", ["-c", "echo __hive_ok__"], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => res("cmd"));
    p.on("close", (code) => res(code === 0 && out.includes("__hive_ok__") ? "bash" : "cmd"));
  });
  return cachedShell;
}

export async function runCommand({ command, cwd, timeoutMs = 30000, outputLimit = 8 * 1024, env = null }) {
  const kind = await detectShell();
  const child =
    kind === "bash"
      ? spawn("bash", ["-c", command], { cwd, windowsHide: true, env: env ? { ...process.env, ...env } : undefined })
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
