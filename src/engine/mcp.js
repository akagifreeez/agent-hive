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
    this.spawnError = null; // 起動時の非同期エラー(ENOENT等)。テスト・診断用に記録する
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
    // イシュー#27: spawnの非同期error(ENOENT等)を捕捉する。未処理のまま放置すると
    // Unhandled error eventでhiveプロセス全体が落ちる。ここでは失敗を記録し、
    // pending要求を全てrejectして、以後のrequestは切断状態として即座に失敗させる。
    this.child.on("error", (err) => {
      this.spawnError = err;
      this.bus?.emit("mcp.failed", { name: this.name, error: err.message });
      this.failPending(new Error(`MCPサーバー ${this.name} に接続できません: ${err.message}`));
    });
    this.child.stdin?.on("error", () => {}); // EPIPE等を握りつぶす(子はもう死んでいる)

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
      if (!this.spawnError) this.bus?.emit("mcp.failed", { name: this.name, error: err.message }); // spawn由来はerrorハンドラが通知済み(二重通知しない)
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
    let r;
    try {
      r = await this.request("tools/call", { name: local, arguments: args ?? {} });
    } catch (err) {
      // 切断・タイムアウト等はツール失敗として扱う(例外を外に投げない/イシュー#27)
      return { ok: false, text: err.message };
    }
    const text = (r.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { ok: !r.isError, text: text || "(空の結果)" };
  }

  // 切断状態の子プロセスに積まれたpending要求を全てrejectする(exit/error共通)
  failPending(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  request(method, params) {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    // 切断状態(child無し/spawn済みだがerror確定)なら即座に失敗させる
    if (!this.child || this.child.stdin?.destroyed || this.spawnError) {
      const e = this.spawnError
        ? new Error(`MCPサーバー ${this.name} に接続できません(${this.spawnError.message})`)
        : new Error(`MCPサーバー ${this.name} に接続できません(切断状態)`);
      return Promise.reject(e);
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

  stop() {
    try { this.child?.kill(); } catch {}
  }
}
