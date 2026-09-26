// 承認制ゲート。bashコマンドを3段で扱う:
//  denyパターン → 即拒否 / askパターン → UI承認を待つ(タイムアウトで拒否) / それ以外 → 許可
// v6.12: モード追加 — "auto"はaskも自動承認(待ち時間ゼロ)、"normal"は従来どおり。
const DEFAULT_DENY = ["rm -rf /", "rm -rf ~", "mkfs", "shutdown", "format ", "del /", ":(){:|:&};:"];
const DEFAULT_ASK = ["rm -rf", "git reset --hard", "git clean", "git push", "npm publish", "curl ", "Invoke-WebRequest"];

export class PermissionGate {
  constructor({ bus, deny = DEFAULT_DENY, ask = DEFAULT_ASK, askTimeoutSec = 120, mode = "normal" } = {}) {
    this.bus = bus;
    this.deny = deny;
    this.ask = ask;
    this.askTimeoutMs = askTimeoutSec * 1000;
    this.mode = mode; // "normal" | "auto"
    this.seq = 0;
  }

  setMode(mode) {
    if (mode === "normal" || mode === "auto") {
      this.mode = mode;
      this.bus?.emit("perm.mode", { mode });
    }
  }

  async check(command) {
    const hitDeny = this.deny.find((p) => command.includes(p));
    if (hitDeny) return { allowed: false, reason: `禁止パターン「${hitDeny}」` };

    const hitAsk = this.ask.find((p) => command.includes(p));
    if (!hitAsk) return { allowed: true };
    if (this.mode === "auto") {
      this.bus?.emit("permission.resolved", { id: -1, command, verdict: "auto" });
      return { allowed: true };
    }

    const id = ++this.seq;
    this.bus.emit("permission.request", { id, command, pattern: hitAsk });
    const verdict = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve("timeout");
      }, this.askTimeoutMs);
      const off = this.bus.on("permission.verdict", (p) => {
        if (p.id !== id) return;
        cleanup();
        resolve(p.approve ? "approve" : "deny");
      });
      function cleanup() {
        clearTimeout(timer);
        off();
      }
    });
    if (verdict === "approve") {
      this.bus.emit("permission.resolved", { id, command, verdict });
      return { allowed: true };
    }
    return { allowed: false, reason: verdict === "timeout" ? `承認が${this.askTimeoutMs / 1000}秒以内に得られなかった` : "人が拒否した" };
  }
}
