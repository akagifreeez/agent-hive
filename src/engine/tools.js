// エージェントに渡すツール一式。ファイル系はワークスペース配下に閉じ込める
// (パス検証で workspace 外への脱出を拒否)。bashは cwd=ワークスペースで実行し、
// 承認制ゲート(gate)を通す。
import { statSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";
import { runCommand, detectShell } from "./exec.js";

const READ_LIMIT = 120 * 1024;
const BASH_OUTPUT_LIMIT = 8 * 1024;

export function createTools({ agent, workspace, board, tasks, bus, gate = null, maxBashMs = 30000 }) {
  const specs = [
    {
      name: "claim_next_task",
      description: "タスクボードから自分が担当できる次のタスクを1件請求(claim)する。成功でタスク本文、無ければ『請求できるタスクはありません』が返る。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "finish_task",
      description: "自分が請求中のタスクを完了として確定する。task_idはclaim_next_taskの返値に示されたもの。",
      parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false },
    },
    {
      name: "list_files",
      description: "ワークスペース内のファイル一覧を取得する。",
      parameters: { type: "object", properties: { path: { type: "string", description: "ワークスペース相対パス(省略時はルート)" } }, additionalProperties: false },
    },
    {
      name: "read_file",
      description: "ワークスペース内のファイルを読む。",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    },
    {
      name: "write_file",
      description: "ワークスペース内にファイルを新規作成または上書きする。",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    },
    {
      name: "edit_file",
      description: "既存ファイルの一部を置換する。old_textは一意に一致すること(複数箇所や不一致はエラー)。",
      parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"], additionalProperties: false },
    },
    {
      name: "bash",
      description: "ワークスペースを作業ディレクトリとしてシェルコマンドを実行する。作業の検証(テスト実行等)に使う。",
      parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "number", description: "省略時30000ms、最大120000ms" } }, required: ["command"], additionalProperties: false },
    },
    {
      name: "post_to_board",
      description: "共有ボードへ報告・指摘・質問を投稿する。他の全エージェントの目に留まる。",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    },
    {
      name: "wait_for_board",
      description: "他エージェントのボード投稿を待つ(最大180秒)。完了報告待ち等に使う。タイムアウト時はその旨が返る。",
      parameters: { type: "object", properties: { timeout_sec: { type: "number", description: "省略時60秒、最大180秒" } }, additionalProperties: false },
    },
  ];

  async function execute(name, args = {}) {
    try {
      return await dispatch(name, args);
    } catch (err) {
      return { ok: false, text: `ツールエラー: ${err.message}` };
    }
  }

  async function dispatch(name, args) {
    switch (name) {
      case "claim_next_task": {
        const t = tasks.claim(agent);
        if (!t) return { ok: true, text: "請求できるタスクはありません。" };
        return { ok: true, text: `タスク ${t.id} を請求しました。\n\n${t.body}` };
      }
      case "finish_task": {
        const done = tasks.finish(agent, String(args.task_id ?? ""));
        if (!done) return { ok: false, text: "そのタスクは請求していません(task_idを確認)。" };
        return { ok: true, text: `タスク ${args.task_id} を完了にしました。` };
      }
      case "list_files": {
        const files = listWorkspaceFiles(safePath(args.path ?? "."));
        return { ok: true, text: files.length ? files.join("\n") : "(空)" };
      }
      case "read_file": {
        const p = safePath(args.path);
        const s = statSync(p, { throwIfNoEntry: false });
        if (!s || s.isDirectory()) return { ok: false, text: `ファイルが無いかディレクトリです: ${args.path}` };
        const buf = readFileSync(p);
        const clipped = buf.length > READ_LIMIT ? buf.subarray(0, READ_LIMIT).toString("utf8") + "\n...(以降省略)" : buf.toString("utf8");
        return { ok: true, text: clipped };
      }
      case "write_file": {
        const p = safePath(args.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(args.content ?? ""));
        return { ok: true, text: `${args.path} に書き込みました(${String(args.content ?? "").length}文字)。` };
      }
      case "edit_file": {
        const p = safePath(args.path);
        const src = readFileSync(p, "utf8");
        const oldText = String(args.old_text ?? "");
        const count = src.split(oldText).length - 1;
        if (count === 0) return { ok: false, text: "old_textが見つかりません。" };
        if (count > 1) return { ok: false, text: `old_textが${count}箇所に一致します。一意になるよう範囲を広げてください。` };
        writeFileSync(p, src.replace(oldText, String(args.new_text ?? "")));
        return { ok: true, text: `${args.path} を編集しました。` };
      }
      case "bash":
        return await gatedBash(String(args.command ?? ""), clamp(Number(args.timeout_ms) || maxBashMs, 1000, 120000));
      case "post_to_board": {
        const post = board.post(agent.id, String(args.text ?? ""));
        return { ok: true, text: `ボード#${post.id}へ投稿しました。` };
      }
      case "wait_for_board": {
        const sec = clamp(Number(args.timeout_sec) || 60, 5, 180);
        const got = await board.wait(agent.id, sec * 1000);
        return got
          ? { ok: true, text: `[${got.from}の投稿] ${got.text}` }
          : { ok: true, text: `${sec}秒で新着はありませんでした。` };
      }
      default:
        return { ok: false, text: `未知のツール: ${name}` };
    }
  }

  function safePath(p) {
    const root = resolve(workspace);
    const full = resolve(root, String(p ?? "."));
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`ワークスペース外のパスは扱えません: ${p}`);
    }
    return full;
  }

  // 承認制ゲート: 禁止パターンは即拒否、要承認パターンはUI承認を待つ
  async function gatedBash(command, timeoutMs) {
    if (gate) {
      const verdict = await gate.check(command);
      if (!verdict.allowed) {
        bus.emit("permission.denied", { agent: agent.id, command });
        return { ok: false, text: `このコマンドは拒否されました(${verdict.reason})。別の安全な方法で作業を続けてください。` };
      }
    }
    return await runCommand({ command, cwd: workspace, timeoutMs, outputLimit: BASH_OUTPUT_LIMIT });
  }

  return { specs, execute, detectShell };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ワークスペースのファイル一覧(UI共用)。node_modulesと隠しファイルは除外。
export function listWorkspaceFiles(dir) {
  const out = [];
  const walk = (d, prefix, depth) => {
    if (depth > 4 || out.length > 400) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      out.push(prefix + e.name + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) walk(join(d, e.name), prefix + e.name + "/", depth + 1);
    }
  };
  walk(dir, "", 0);
  return out;
}
