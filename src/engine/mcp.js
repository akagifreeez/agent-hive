// MCP(stdio)サーバーをhiveのツールとして接続する薄いクライアント(v1)。
// 新行区切りJSON-RPCでinitialize → notifications/initialized → tools/list → tools/call。
// サーバーが起動しなくてもhive全体は止めない(失敗はbusへ通知してスキップ)。
import { spawn } from "node:child_process";
import { scrubEnv } from "./exec.js";

/**
 * @typedef {Object} McpHostInstance
 * @property {string} name サーバー名(ツール名の接頭辞 mcp__<name>__ に使う)
 * @property {string} command 起動コマンド
 * @property {string[]} args 引数
 * @property {Object.<string,string>} env 環境変数
 * @property {Array<{name: string, description?: string}>} tools 公開ツール(tools/listの結果)
 * @property {any} child 起動済みプロセス
 * @property {() => Promise<{ok: boolean, tools?: number, error?: string}>} start ハンドシェイクしてtools/listまで進める
 * @property {() => void} stop サーバープロセスを止める
 * @property {(name: string) => boolean} handles ツール名がこのサーバー宛か
 * @property {(name: string, args: Object) => Promise<{ok: boolean, text: string}>} call ツール呼び出し
 */

/** 設定ウィンドウ向けのサーバー一覧(envの値は含めない)。 */
/**
 * @param {McpHostInstance[]} hosts
 * @returns {Array<{name: string, command: string, args: string[], envKeys: string[], tools: string[], started: boolean}>}
 */
export function mcpServersInfo(hosts) {
  return hosts.map((h) => ({
    name: h.name,
    command: h.command,
    args: h.args,
    envKeys: Object.keys(h.env ?? {}),
    tools: (h.tools ?? []).map((t) => t.name),
    started: Boolean(h.child),
  }));
}

export class McpHost {
  constructor({ name, command, args = [], env = {}, bus = null, timeoutMs = 60000 }) {
    /** @type {string} */
    this.name = String(name);
    /** @type {string} */
    this.command = command;
    /** @type {string[]} */
    this.args = args;
    /** @type {Record<string,string>} */
    this.env = env;
    this.bus = bus;
    this.timeoutMs = timeoutMs;
    /** @type {any} */
    this.child = null;
    /** @type {Array<{name: string, description?: string, inputSchema?: any}>} */
    this.tools = [];
    this.nextId = 1;
    this.pending = new Map(); // id => {resolve, reject, timer}
    this.buf = "";
  }

  async start() {
    try {
      this.child = spawn(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        // 周辺環境はスクラブし、設定env(this.env=狙いの割り当て)は上書きで通す(exec.js参照)
        env: scrubEnv(process.env, this.env),
        windowsHide: true,
      });
    } catch (err) {
      this.bus?.emit("mcp.failed", { name: this.name, error: err.message });
      return { ok: false, error: err.message };
    }
    // イシュー#27: コマンドが存在しない等はspawn自体は成功し、後から非同期のerrorイベント(ENOENT等)が
    // 発火する。未処理のまま放置するとhiveプロセス全体が落ちるため、ここで捕捉して起動失敗として扱う
    // (実装契約「起動失敗してもhiveは続行」を実際に満たす)。
    this.spawnError = null;
    this.child.on("error", (err) => {
      this.spawnError = err;
      this.failPending(`MCPサーバー ${this.name} の起動に失敗: ${err.message}`);
    });
    // stdinへの書き込み口のエラーも握り潰す(起動失敗後のEPIPE等でhiveが落ちないように)
    this.child.stdin.on("error", () => {});
    let out = "";
    this.child.stdout.on("data", (d) => {
      out += d.toString();
      let nl;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else p.resolve(msg.result ?? {});
        }
      }
    });
    this.child.stderr.on("data", () => {}); // サーバーのログは捨てる
    // 子のstdioパイプがイベントループを握ってプロセスが終わらなくならないようにする
    this.child.unref?.();
    /** @type {any} */ (this.child.stdout).unref?.();
    /** @type {any} */ (this.child.stderr).unref?.();
    this.child.on("exit", (code) => {
      this.failPending(`MCPサーバー ${this.name} が終了しました(code=${code})`);
    });

    try {
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-hive", version: "1.0" },
      });
      this.notify("notifications/initialized");
      const res = await this.request("tools/list", {});
      this.tools = (res.tools ?? []).filter((t) => t.name);
      this.bus?.emit("mcp.started", { name: this.name, tools: this.tools.map((t) => t.name) });
      return { ok: true, tools: this.tools.length };
    } catch (err) {
      this.bus?.emit("mcp.failed", { name: this.name, error: err.message });
      try { this.child.kill(); } catch {}
      return { ok: false, error: err.message };
    }
  }

  // hiveツール形式のspec一覧(mcp__<サーバー>__<ツール>)
  specs() {
    return this.tools.map((t) => ({
      name: `mcp__${this.name}__${t.name}`,
      description: `[MCP:${this.name}] ${t.description ?? t.name}`,
      parameters: t.inputSchema ?? { type: "object", properties: {}, additionalProperties: false },
    }));
  }

  handles(name) {
    return name.startsWith(`mcp__${this.name}__`);
  }

  async call(name, args) {
    const local = name.slice(`mcp__${this.name}__`.length);
    try {
      const r = await this.request("tools/call", { name: local, arguments: args ?? {} });
      const text = (r.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return { ok: !r.isError, text: text || "(空の結果)" };
    } catch (err) {
      // 接続断・起動失敗・タイムアウトはツール失敗(ok:false)として返す(例外を外へ漏らさない)
      return { ok: false, text: `MCP呼び出し失敗: ${err.message}` };
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    if (!this.child || this.spawnError) {
      return Promise.reject(new Error(`MCPサーバー ${this.name} は接続できません`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP応答タイムアウト(${this.timeoutMs}ms): ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(msg);
    });
  }

  notify(method) {
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    } catch {}
  }

  // 起動失敗・切断時に全pending要求を失敗させる(タイマーも解放)
  failPending(message) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
  }
  stop() {
    try { this.child?.kill(); } catch {}
  }
}
