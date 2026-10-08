// Hooks(v1): ライフサイクルの節目でconfig.hooksに書かれたシェルコマンドを実行する。
// beforeToolが非ゼロ終了したらそのツールはブロックされる(コードによる強制ルール)。
// env経由で文脈を渡す: HIVE_HOOK_AGENT / HIVE_HOOK_TOOL / HIVE_HOOK_ARGS / HIVE_HOOK_OK ほか。
import { runCommand } from "./exec.js";

export class Hooks {
  constructor({ config = null, cwd = null, bus = null, timeoutMs = 10000 }) {
    this.hooks = config?.hooks ?? {};
    this.cwd = cwd;
    this.bus = bus;
    this.timeoutMs = timeoutMs;
  }

  has(event) {
    const h = this.hooks[event];
    return Array.isArray(h) ? h.length > 0 : Boolean(h);
  }

  // 1イベントにつき全コマンドを実行。1つでも非ゼロ終了なら { blocked: true, text } を返す
  async run(event, env = {}) {
    const cmds = this.hooks[event];
    if (!cmds) return { ran: false, blocked: false };
    const list = Array.isArray(cmds) ? cmds : [cmds];
    for (const cmd of list) {
      const r = await runCommand({
        command: String(cmd),
        cwd: this.cwd ?? undefined,
        timeoutMs: this.timeoutMs,
        outputLimit: 2000,
        env: Object.fromEntries(Object.entries(env).map(([k, v]) => [`HIVE_HOOK_${k}`, String(v ?? "")])),
      });
      if (!r.ok) {
        this.bus?.emit("hook.blocked", { event, command: String(cmd), text: r.text.slice(0, 500) });
        return { ran: true, blocked: true, text: `${event} フックが非ゼロ終了しました(${String(cmd).slice(0, 120)}):\n${r.text.slice(0, 500)}` };
      }
    }
    return { ran: true, blocked: false };
  }
}
