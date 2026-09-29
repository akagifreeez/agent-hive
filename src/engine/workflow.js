// ワークフロー(v1): スクリプト(workflows/<名前>.mjs)で一連のhive操作を決定論的に実行する。
// スクリプトはデフォルトexportのasync関数で、api引数経由でhiveを操作する:
//   export default async (api) => {
//     await api.createTask({ id: "x-impl", project: "x", body: "..." });
//     await api.openThread({ project: "x", goal: "..." });
//     await api.waitProject("x");
//     await api.say("完了しました");
//   };
// 制御構文(if/for/while)は普通のJS。型のある中間結果ではなく、blackboard上の実データを受け渡す。
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateSchema, findPlaceholders, parseJsonLoose, guardJson } from "./schema-guard.js";

/**
 * ワークフロースクリプトへ渡すAPI群を組み立てる。
 * @param {Object} o
 * @param {Function} o.openThread
 * @param {Function} o.closeThread
 * @param {Function} o.say
 * @param {import("./tasks.js").TaskBlackboard} o.tasks
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {number} [o.pollMs]
 * @param {Function} [o.log]
 * @param {import("./board.js").Bus} [o.bus]
 */
export function createWorkflowApi({ openThread, closeThread, say, tasks, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000, log = () => {} }) {
  const counts = (project) => {
    const l = tasks.list();
    const inP = [...l.open, ...l.claimed, ...l.done].filter((t) => (t.project || "") === project);
    return {
      open: inP.filter((t) => t.state === "open").length,
      claimed: inP.filter((t) => t.state === "claimed").length,
      done: inP.filter((t) => t.state === "done").length,
      total: inP.length,
    };
  };
  return {
    async createTask({ id, project, body, role = null }) {
      const ok = tasks.create({ id, role, project, body });
      if (!ok) log(`タスク ${id} は既に存在します(スキップ)`);
      return ok;
    },
    async say(text, thread = null) {
      say(text, thread);
    },
    async waitProject(project, { quietMs = 10000, timeoutMs = 15 * 60000 } = {}) {
      // projectの全タスクが完了(open/claimedが0)になり、quietMs安定したら解決
      const start = Date.now();
      let stableSince = null;
      for (;;) {
        const c = counts(project);
        if (c.total > 0 && c.open === 0 && c.claimed === 0) return { ...c, elapsedMs: Date.now() - start };
        if (Date.now() - start > timeoutMs) throw new Error(`waitProjectタイムアウト(${project}): open=${c.open} claimed=${c.claimed}`);
        if (stableSince && Date.now() - stableSince > quietMs) {
          // 変化が止まった=ワーカーが全員退出した(予算停止など)。タイムアウトより早く諦める
          throw new Error(`waitProject: ${project} のタスクが停止しています(open=${c.open} claimed=${c.claimed})`);
        }
        stableSince ??= Date.now();
        await sleep(pollMs);
        stableSince = null; // 変化があった可能性があるので安定計測をやり直し
      }
    },
    status(project) {
      const c = counts(project);
      return { ...c, complete: c.total > 0 && c.open === 0 && c.claimed === 0 };
    },
    log,
  };
}

// スクリプトファイルを実行(デフォルトexportのasync関数)。タイムアウト付き。
export async function runWorkflowScript({ path, api, timeoutMs = 30 * 60000 }) {
  if (!existsSync(path)) throw new Error(`ワークフローファイルがありません: ${path}`);
  const mod = await import(pathToFileURL(path).href);
  const fn = mod.default;
  if (typeof fn !== "function") throw new Error("デフォルトexportのasync関数が必要です");
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ワークフローがタイムアウトしました(${timeoutMs}ms)`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(fn(api)), timeout]).finally(() => clearTimeout(timer));
}
