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
    // 子プロセス自体の起動失敗(ENOENT等)の非同期errorでhiveが落ちないようにする(fix#27)
    this.child.on("error", (err) => {
      this.bus?.emit("mcp.failed", { name: this.name, error: err.message });
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.child = null; // 切断状態へ。以後のrequest()は即reject
    });
    // stdinのEPIPE等でUnhandled 'error'にならないように握りつぶす
    this.child.stdin?.on("error", () => {});
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
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCPサーバー ${this.name} が終了しました(code=${code})`));
      }
      this.pending.clear();
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
      try { this.child?.kill(); } catch {}
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
    const r = await this.request("tools/call", { name: local, arguments: args ?? {} });
    const text = (r.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { ok: !r.isError, text: text || "(空の結果)" };
  }

  request(method, params) {
    if (!this.child) {
      // 起動失敗・終了済みなど切断状態ではpendingに積まず即reject(fix#27)
      return Promise.reject(new Error(`MCPサーバー ${this.name} は切断状態です(起動失敗または終了済み)`));
    }
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP応答タイムアウト(${this.timeoutMs}ms): ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        if (!this.child.stdin || this.child.stdin.destroyed) {
          throw new Error(`MCPサーバー ${this.name} のstdinは書き込み不可です`);
        }
        this.child.stdin.write(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method) {
    try {
      if (this.child?.stdin && !this.child.stdin.destroyed) {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
      }
    } catch {}
  }

  stop() {
    try { this.child?.kill(); } catch {}
  }
}
