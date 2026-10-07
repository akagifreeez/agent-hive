// シェル実行の共用層。ツールのbashも発見器のプローブもこれを使う。
// WindowsではGit Bashを自動検出してPOSIXコマンドを受けられるようにする。
// さらにテスト系コマンド(npm test / node --test)にはプロセス横断セマフォを掛け、
// 複数ワーカーと発見器プローブが重なってもテストの子プロセスが百オーダ同時起動して
// マシンが飽和するのを防ぐ(exec.testMaxConcurrentで上限を上書き可)。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { isTestCommand, runTestCommand, configureTestSemaphore } from "./test-semaphore.js";

// config.exec.testMaxConcurrent の反映用(runner起動時に呼ぶ)。空でも既定(1)へ戻す。
export function applyTestSemaphoreConfig(execCfg) {
  return configureTestSemaphore(execCfg ?? {});
}

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

// 子プロセスへ渡す環境変数から鍵っぽいものを落とす(DeepSeek Harness defensive-patternsの移植)。
// ハーネス自身の資格情報(HIVE_UI_TOKEN等)や.env由来の鍵がエージェントのコマンドへ漏えるのを防ぐ。
// 明示的に渡されたenv(MCPサーバーの設定env等)は狙いの割り当てなので、スクラブ後の上書きとしてそのまま通す。
// GH_TOKEN/GITHUB_TOKENはhiveの正規ワークフロー(gh issue view等)で使うため既定で残す。
const ENV_SECRET_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i;
const ENV_DEFAULT_ALLOW = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

/** @param {Object} [base] スクラブ対象の基礎(省略時process.env)
 *  @param {Object|null} [extra] 明示割り当てのenv(スクラブせず上書きする) */
export function scrubEnv(base = process.env, extra = null) {
  const allowed = new Set(ENV_DEFAULT_ALLOW);
  for (const name of String(process.env.HIVE_ENV_ALLOW ?? "").split(",")) {
    const n = name.trim();
    if (n) allowed.add(n);
  }
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (ENV_SECRET_RE.test(k) && !allowed.has(k)) continue;
    out[k] = v;
  }
  return extra ? { ...out, ...extra } : out;
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
 * 子プロセスの環境はscrubEnvで鍵っぽい変数を落として渡す(env引数は明示割り当てとして上書き)。
 * テスト系コマンド(npm test / node --test)はプロセス横断セマフォで同時実行が上限までに抑えられ、
 * 上限超過の待ちがテスト待ちタイムアウトを過ぎたら教師文面つきで失敗を返す。
 * @param {{command: string, cwd?: string, env?: Object, outputLimit?: number, timeoutMs?: number}} o
 * @param {string} [keep="head"] 出力の丸め方向。"head"=先頭から保持(従来動作・既定)|"tail"=末尾を保持(テストサマリ等・失敗節が末尾に出る形式向け)
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function runCommand({ command, cwd, timeoutMs = 30000, outputLimit = 8 * 1024, env = null, keep = "head" }) {
  // テスト系コマンド(npm test / node --test 等)はプロセス横断セマフォで直列化する
  // (exec-test-semaphore)。非テストコマンドは従来どおり即実行(影響ゼロ)。
  if (isTestCommand(command)) {
  return runTestCommand({ command, cwd, timeoutMs, outputLimit, env, keep }, runCommandInner);
  }
  return runCommandInner({ command, cwd, timeoutMs, outputLimit, env, keep });
}

/** @param {{command: string, cwd?: string, env?: Object, outputLimit?: number, timeoutMs?: number}} o
 * @returns {Promise<{ok: boolean, text: string}>}
 */
async function runCommandInner({ command, cwd, timeoutMs = 30000, outputLimit = 8 * 1024, env = null, keep = "head" }) {
  const kind = await detectShell();
  const childEnv = scrubEnv(process.env, env);
  const child =
    kind === "bash"
      ? spawn(bashCommand, ["-c", command], { cwd, windowsHide: true, env: childEnv })
      : spawn(command, { shell: true, cwd, windowsHide: true, env: childEnv });
  let out = "";
  const append = (d) => {
    if (keep === "tail") {
      out += d.toString();
      if (out.length > outputLimit) out = out.slice(out.length - outputLimit);
    } else if (out.length < outputLimit) {
      out += d.toString();
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return await new Promise((res) => {
    const timer = setTimeout(() => {
      child.kill();
      res({ ok: false, text: `タイムアウト(${timeoutMs}ms)で中断:\n${out.slice(0, outputLimit)}` });
    }, timeoutMs);
    if (timer.unref) timer.unref();
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
