// 承認制ゲート。bashコマンドを3段で扱う:
//  denyパターン → 即拒否 / askパターン → UI承認を待つ(タイムアウトで拒否) / それ以外 → 許可
// v6.12: モード追加 — "auto"はaskも自動承認(待ち時間ゼロ)、"normal"は従来どおり。
const DEFAULT_DENY = ["rm -rf /", "rm -rf ~", "mkfs", "shutdown", "format ", "del /", ":(){:|:&};:"];
const DEFAULT_ASK = ["rm -rf", "git reset --hard", "git clean", "git push", "npm publish", "curl ", "Invoke-WebRequest"];
// v6.13: confirm 段 — curl/wget(外部送信の足がかり)と kill/taskkill(プロセス停止)は、
// auto モードでも自動承認せず必ず人の承認を待つ(deny ではないため承認があれば実行可)。
const DEFAULT_CONFIRM = ["curl", "wget", "Invoke-RestMethod", "kill ", "killall", "pkill", "taskkill", "Stop-Process"];

// コマンド正規化: (1)空白の連続を1つへ圧縮 (2)連続する単一文字オプションを結合(-r -f → -rf)。
// トークン単位で処理し、非オプション引数や長いオプション(--hard)はそのまま保持する。
export function normalizeCommand(cmd, { sort = false } = {}) {
  const tokens = String(cmd ?? "").trim().split(/\s+/).filter(Boolean);
  const out = [];
  let pending = "";
  const flush = () => {
    if (pending) {
      let chars = [...new Set(pending.split(""))];
      if (sort) chars.sort(); // オプション順序入替(-f -r / -fr)を正規形へ寄せる
      out.push("-" + chars.join(""));
      pending = "";
    }
  };
  for (const t of tokens) {
    if (/^-[a-zA-Z]$/.test(t)) {
      pending += t.slice(1); // 単一文字オプションは結合候補へ
    } else if (sort && /^-[a-z]{2,}$/.test(t)) {
      flush(); // ソート時は連結済みオプション(-rf等)も文字順を正規化する
      out.push("-" + [...t.slice(1)].sort().join(""));
    } else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out.join(" ");
}


// シェルの実行単位への分割: 複合コマンド(; && & || パイプ 改行)を実行単位ごとに切る。
// クォート内の区切りは考慮しない(過剰分割は「承認要求が増える」安全側に倒れるため、confirm判定には十分)。
// 正規表現を使わず文字コードで走査する(59=';' 38='&' 124='|' 10=LF 13=CR)。
export function splitExecUnits(cmd) {
  const text = String(cmd ?? "");
  const units = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 59 || c === 38 || c === 124 || c === 10 || c === 13) {
      units.push(cur);
      cur = "";
      continue;
    }
    cur += text[i];
  }
  units.push(cur);
  return units.map((u) => u.trim()).filter(Boolean);
}

// confirm用の引数正規化: 連結オプション(-9 / -f 等)を分割して照合する。
// 例: `curl -sS -m 5 http://...` の -sS はそのままでも、`kill -9` の -9 は `kill - 9` に分裂させて
// 「kill 」前方一致 + オプション除外の照合を素通りさせない。
function normalizeConfirmArgv(cmd) {
  const tokens = normalizeCommand(cmd).split(/\s+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (/^-[a-zA-Z0-9]{2,}$/.test(t)) {
      for (const ch of [...t.slice(1)]) out.push("-" + ch);
    } else {
      out.push(t);
    }
  }
  return out.join(" ");
}

/**
 * #24: シェルコマンドを実行単位へ分割する。
 * 区切りは ; && || | と改行。クォート(「"」「'」)内の区切り文字は分割しない。
 * エスケープ処理や括弧・サブシェルまで完全に解析するものではない(確認目的の分割)。
 * @param {string} cmd
 * @returns {string[]}
 */
export function splitShellSegments(cmd) {
  const s = String(cmd ?? "");
  const out = [];
  let cur = "";
  let quote = null; // null | '"' | "'"
  let prev = "";
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      prev = ch;
      continue;
    }
    if (ch === "\n") {
      out.push(cur);
      cur = "";
      prev = "";
      continue;
    }
    if (ch === ";") {
      out.push(cur);
      cur = "";
      prev = "";
      continue;
    }
    if ((ch === "&" && prev === "&") || (ch === "|" && prev === "|")) {
      out.push(cur);
      cur = "";
      prev = "";
      continue;
    }
    if (ch === "|" && prev !== "|") {
      out.push(cur);
      cur = "";
      prev = "";
      continue;
    }
    if (ch === "&" && prev !== "&") {
      out.push(cur);
      cur = "";
      prev = "";
      continue;
    }
    cur += ch;
    prev = ch;
    continue;
  }
  out.push(cur);
  return out.map((seg) => seg.trim()).filter(Boolean);
}

export class PermissionGate {
  /**
   * @param {{bus?: import("./board.js").Bus, deny?: string[], ask?: string[], confirm?: string[], askTimeoutSec?: number, mode?: string}} opts
   */
  constructor({ bus, deny = DEFAULT_DENY, ask = DEFAULT_ASK, confirm = DEFAULT_CONFIRM, askTimeoutSec = 120, mode = "normal" } = {}) {
    this.bus = bus;
    this.deny = deny;
    this.ask = ask;
    this.confirm = confirm;
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
    // 照合はソート正規形で行い、オプション順序入替(rm -f -r / → rm -fr /)の素通りを防ぐ。
    // パターン側の単一文字オプションも同様にソートして比較する(rf ↔ fr を同一視)。
    // 元コマンドでの照合は従来どおり併用(長いオプション等の揺らぎは元文字列側で捕捉)。
    const normalized = normalizeCommand(command, { sort: true });
    const normPattern = (p) => {
      // パターン内の連結オプション(-rf 等)もトークン分解して正規化し、rf ↔ fr を同一視する
      const spaced = String(p).replace(/(^|\s)-([a-z]{2,})(?=\s|$)/gi, (_m, pre, opts) =>
        pre + opts.split("").map((c) => "-" + c).join(" ")
      );
      return normalizeCommand(spaced, { sort: true });
    };
    const hitDeny = this.deny.find((p) => normalized.includes(normPattern(p)) || command.includes(p));
    if (hitDeny) return { allowed: false, reason: `禁止パターン「${hitDeny}」` };

    // confirm 段: curl/wget(送信の足がかり)や kill/taskkill(プロセス停止)は、
    // auto モードであっても自動承認しない(必ず承認要求を出して人の判断を待つ)。
    // #24: 複合コマンド対応 — 実行単位区切り(; && || | 改行)で分割し、
    // 各実行単位ごとに confirm 判定を行う。1つでも confirm 対象が含まれれば
    // 全体を承認要求扱いにする(2番目以降の curl/kill 等の素通りを塞ぐ)。
    const argv = normalizeConfirmArgv(command);
    const argvTokens = argv.split(" ");
    const segments = splitShellSegments(command);
    const hitConfirm = (() => {
      for (const seg of segments) {
        const segTokens = normalizeConfirmArgv(seg).split(" ").filter(Boolean);
        const p = this.confirm.find((pat) => {
          // 実行単位の先頭トークン一致(部分一致の誤爆「echo killing」等を避ける)。複数語パターンは前置詞一致
          const pt = String(pat).trim().split(/\s+/);
          return pt.every((w, i) => segTokens[i] === w);
        });
        if (p) return p;
      }
      // 従来経路(全体の先頭トークン照合)も併用: 区切り未検出の単一コマンド等の後方互換
      return this.confirm.find((pat) => {
        const pt = String(pat).trim().split(/\s+/);
        return pt.every((w, i) => argvTokens[i] === w);
      });
    })();
    if (hitConfirm) {
      const verdict2 = await this.requestApproval(command, hitConfirm);
      if (verdict2 === "approve") {
        return { allowed: true };
      }
      return { allowed: false, reason: verdict2 === "timeout" ? `承認が${this.askTimeoutMs / 1000}秒以内に得られなかった` : "人が拒否した" };
    }

    const hitAsk = this.ask.find((p) => normalized.includes(normPattern(p)) || command.includes(p));
    if (!hitAsk) return { allowed: true };
    if (this.mode === "auto") {
      this.bus?.emit("permission.resolved", { id: -1, command, verdict: "auto" });
      return { allowed: true };
    }

    const verdict = await this.requestApproval(command, hitAsk);
    if (verdict === "approve") {
      return { allowed: true };
    }
    return { allowed: false, reason: verdict === "timeout" ? `承認が${this.askTimeoutMs / 1000}秒以内に得られなかった` : "人が拒否した" };
  }

  /**
   * 承認要求を出して verdict を待つ(normal/confirm 共通)。confirm は auto でもここへ来る。
   * @param {string} command
   * @param {string} pattern
   * @returns {Promise<"approve"|"deny"|"timeout">}
   */
  requestApproval(command, pattern) {
    const id = ++this.seq;
    this.bus.emit("permission.request", { id, command, pattern });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve("timeout");
      }, this.askTimeoutMs);
      const off = this.bus.on("permission.verdict", (p) => {
        if (p.id !== id) return;
        cleanup();
        const v = p.approve ? "approve" : "deny";
        if (v === "approve") this.bus.emit("permission.resolved", { id, command, verdict: v });
        resolve(v);
      });
      function cleanup() {
        clearTimeout(timer);
        off();
      }
    });
  }
}
