// MCP(stdio)サーバーをhiveのツールとして接続する薄いクライアント(v1)。
// 新行区切りJSON-RPCでinitialize → notifications/initialized → tools/list → tools/call。
// サーバーが起動しなくてもhive全体は止めない(失敗はbusへ通知してスキップ)。
import { spawn } from "node:child_process";

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
    /** @type {import("node:child_process").ChildProcess|null} */
    this.child = null;
    /** @type {Array<{name:string,description?:string,inputSchema?:object}>} */
    this.tools = [];
    this.nextId = 1;
    this.pending = new Map(); // id => {resolve, reject, timer}
    this.buf = "";
  }

  async start() {
    try {
      this.child = spawn(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.env },
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
    const r = await this.request("tools/call", { name: local, arguments: args ?? {} });
    const text = (r.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { ok: !r.isError, text: text || "(空の結果)" };
  }

  request(method, params) {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
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
