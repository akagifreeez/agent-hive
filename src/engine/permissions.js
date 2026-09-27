// 承認制ゲート。bashコマンドを3段で扱う:
//  denyパターン → 即拒否 / askパターン → UI承認を待つ(タイムアウトで拒否) / それ以外 → 許可
// v6.12: モード追加 — "auto"はaskも自動承認(待ち時間ゼロ)、"normal"は従来どおり。
const DEFAULT_DENY = ["rm -rf /", "rm -rf ~", "mkfs", "shutdown", "format ", "del /", ":(){:|:&};:"];
const DEFAULT_ASK = ["rm -rf", "git reset --hard", "git clean", "git push", "npm publish", "curl ", "Invoke-WebRequest"];

// コマンド正規化: (1)空白の連続を1つへ圧縮 (2)連続する単一文字オプションを結合(-r -f → -rf)。
// トークン単位で処理し、非オプション引数や長いオプション(--hard)はそのまま保持する。
export function normalizeCommand(cmd) {
  const tokens = String(cmd ?? "").trim().split(/\s+/).filter(Boolean);
  const out = [];
  let pending = "";
  const flush = () => {
    if (pending) {
      out.push("-" + [...new Set(pending.split(""))].join(""));
      pending = "";
    }
  };
  for (const t of tokens) {
    if (/^-[a-zA-Z]$/.test(t)) {
      pending += t.slice(1); // 単一文字オプションは結合候補へ
    } else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out.join(" ");
}

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
    // 自明な回避形の吸収: 空白圧縮 + 連続する単一文字オプションの結合(-r -f → -rf)。
    // 完全な回避防止ではなく、パターン照合が素通りする自明な揺らぎを塞ぐ範囲。
    const normalized = normalizeCommand(command);
    const hitDeny = this.deny.find((p) => normalized.includes(p) || command.includes(p));
    if (hitDeny) return { allowed: false, reason: `禁止パターン「${hitDeny}」` };

    const hitAsk = this.ask.find((p) => normalized.includes(p) || command.includes(p));
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
