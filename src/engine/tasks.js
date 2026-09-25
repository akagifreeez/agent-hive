// タスクblackboard。workspace/tasks/{open,claimed,done} 配下のMarkdownファイルが
// 仕事そのもの。claimは「open→claimedへのrename」=同一ボリュームで原子的なので、
// 複数エージェントが同時に請求しても二重請求が起きない。
import { mkdirSync, readdirSync, renameSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export class TaskBlackboard {
  constructor(workspace, bus = null) {
    this.dir = join(workspace, "tasks");
    this.open = join(this.dir, "open");
    this.claimed = join(this.dir, "claimed");
    this.done = join(this.dir, "done");
    this.bus = bus;
    for (const d of [this.open, this.claimed, this.done]) mkdirSync(d, { recursive: true });
  }

  seed(tasks) {
    for (const t of tasks ?? []) this.create(t);
  }

  // 発見器などが直接タスクを投入する
  create({ id, role, body }) {
    const f = join(this.open, `${id}.md`);
    if (existsSync(f)) return false;
    const roleLine = role ? `role: ${role}\n` : "";
    writeFileSync(f, `${roleLine}\n${body ?? ""}\n`);
    this.bus?.emit("task.created", { taskId: id });
    return true;
  }

  // スポーンなどで最初から請求済みとしてタスクを投入する(ブリーフ=そのエージェントの担当)
  assign({ agentId, taskId, body }) {
    const f = join(this.claimed, `${agentId}--${taskId}.md`);
    if (existsSync(f)) return false;
    writeFileSync(f, `${body ?? ""}\n`);
    return true;
  }

  // 指定idのタスクがopen/claimedのどこかに存在するか(自動仕事の二重生成防止)
  existsOpenOrClaimed(id) {
    if (existsSync(join(this.open, `${id}.md`))) return true;
    return readdirSync(this.claimed).some((f) => f === `${id}.md` || f.endsWith(`--${id}.md`));
  }

  // 未着手/作業中の自動タスクを解決済みへ(テスト復旧時など)。noteはファイル末尾に追記。
  autoResolve(id, note) {
    const openFile = join(this.open, `${id}.md`);
    if (existsSync(openFile)) {
      appendNote(openFile, note);
      renameSync(openFile, join(this.done, `auto--${id}.md`));
      this.bus?.emit("task.autoResolved", { taskId: id });
      return true;
    }
    const claimedFile = readdirSync(this.claimed).find((f) => f.endsWith(`--${id}.md`));
    if (claimedFile) {
      const p = join(this.claimed, claimedFile);
      appendNote(p, note);
      renameSync(p, join(this.done, `auto--${claimedFile}`));
      this.bus?.emit("task.autoResolved", { taskId: id });
      return true;
    }
    return false;
  }

  // roleが一致するタスクを優先して請求。一致が無ければrole指定なしのタスク。どちらも無ければnull。
  claim(agent) {
    const files = readdirSync(this.open).filter((f) => f.endsWith(".md")).sort();
    for (const pass of [(r) => r === agent.role, (r) => r === null]) {
      for (const f of files) {
        if (!pass(readRole(join(this.open, f)))) continue;
        const src = join(this.open, f);
        const dst = join(this.claimed, `${agent.id}--${f}`);
        try {
          renameSync(src, dst);
          const id = f.replace(/\.md$/, "");
          this.bus?.emit("task.claimed", { agent: agent.id, taskId: id });
          return { id, body: readFileSync(dst, "utf8") };
        } catch {
          // 先を越された。次の候補へ。
        }
      }
    }
    return null;
  }

  finish(agent, taskId) {
    const src = join(this.claimed, `${agent.id}--${taskId}.md`);
    const dst = join(this.done, `${agent.id}--${taskId}.md`);
    try {
      renameSync(src, dst);
      this.bus?.emit("task.finished", { agent: agent.id, taskId });
      return true;
    } catch {
      return false;
    }
  }

  claimedBy(agentId) {
    const files = readdirSync(this.claimed).filter((f) => f.startsWith(`${agentId}--`) && f.endsWith(".md"));
    return files.map((f) => ({
      id: f.replace(/\.md$/, "").slice(agentId.length + 2),
      body: readFileSync(join(this.claimed, f), "utf8"),
    }));
  }

  // 担当者が消える終わり方(予算停止/エラー/継続不能)のとき、請求中をopenへ戻す。
  // 戻さないとタスクが請求者ごと凍結され、誰にも再開されない(発見器も「未解決あり」と扱う)。
  release(agentId, note = null) {
    const files = readdirSync(this.claimed).filter((f) => f.startsWith(`${agentId}--`) && f.endsWith(".md"));
    const released = [];
    for (const f of files) {
      const taskId = f.replace(/\.md$/, "").slice(agentId.length + 2);
      const src = join(this.claimed, f);
      const dst = join(this.open, `${taskId}.md`);
      try {
        if (note) appendNote(src, note);
        renameSync(src, dst);
        this.bus?.emit("task.released", { agent: agentId, taskId });
        released.push(taskId);
      } catch {
        // 先に他者が動いた場合等。次のファイルへ。
      }
    }
    return released;
  }

  snapshot() {
    const list = (dir) => readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    return { open: list(this.open), claimed: list(this.claimed), done: list(this.done) };
  }

  // UIのタスク管理パネル用。1件ごとに状態/担当/要約/ファイルパスを返す(本文は必要時のみ取得)
  list() {
    const splitRole = (raw) => {
      const nl = raw.indexOf("\n");
      const head = nl === -1 ? raw : raw.slice(0, nl);
      if (head.startsWith("role: ")) return { role: head.slice(6).trim() || null, body: raw.slice(nl + 1) };
      return { role: null, body: raw };
    };
    // 要約は最初の実質行([解放]等のシステムノートは飛ばす)
    const summarize = (body) => {
      const line = body.trim().split("\n").find((l) => l.trim() && !l.trim().startsWith("[")) ?? "(本文なし)";
      return line.trim().slice(0, 90);
    };
    const open = readdirSync(this.open).filter((f) => f.endsWith(".md")).sort().map((f) => {
      const { role, body } = splitRole(readFileSync(join(this.open, f), "utf8"));
      return { state: "open", id: f.replace(/\.md$/, ""), agent: null, role, summary: summarize(body), path: `tasks/open/${f}` };
    });
    const claimed = readdirSync(this.claimed).filter((f) => f.endsWith(".md")).sort().map((f) => {
      const { role, body } = splitRole(readFileSync(join(this.claimed, f), "utf8"));
      const base = f.replace(/\.md$/, "");
      const idx = base.indexOf("--");
      return { state: "claimed", id: base.slice(idx + 2), agent: base.slice(0, idx), role, summary: summarize(body), path: `tasks/claimed/${f}` };
    });
    const done = readdirSync(this.done).filter((f) => f.endsWith(".md")).sort().map((f) => {
      const { body } = splitRole(readFileSync(join(this.done, f), "utf8"));
      const base = f.replace(/\.md$/, "");
      const idx = base.indexOf("--");
      return { state: "done", id: base.slice(idx + 2), agent: base.slice(0, idx), role: null, summary: summarize(body), path: `tasks/done/${f}` };
    });
    return { open, claimed, done };
  }

  // 1件だけ解放(claimed→open)。UIからの個別解放用(releaseは担当者の全件)
  releaseOne(agentId, taskId, note = null) {
    const src = join(this.claimed, `${agentId}--${taskId}.md`);
    const dst = join(this.open, `${taskId}.md`);
    try {
      if (note) appendNote(src, note);
      if (existsSync(dst)) return false; // 同idのopenが既にある(手動投入等)場合は壊さない
      renameSync(src, dst);
      this.bus?.emit("task.released", { agent: agentId, taskId });
      return true;
    } catch {
      return false;
    }
  }

  // 未着手タスクを中止としてdoneへ(open→done)。削除せず履歴に残す
  cancel(taskId, note = "[中止] ユーザーがUIから中止") {
    const src = join(this.open, `${taskId}.md`);
    try {
      appendNote(src, note);
      renameSync(src, join(this.done, `you--${taskId}.md`));
      this.bus?.emit("task.cancelled", { taskId });
      return true;
    } catch {
      return false;
    }
  }

  // 完了タスクを再度openへ(done→open)。UIからの再開用
  reopen(taskId, note = "[再開] ユーザーがUIから再open") {
    const file = readdirSync(this.done).filter((f) => f.endsWith(`--${taskId}.md`)).sort().pop();
    if (!file) return false;
    const src = join(this.done, file);
    const dst = join(this.open, `${taskId}.md`);
    try {
      if (existsSync(dst)) return false;
      appendNote(src, note);
      renameSync(src, dst);
      this.bus?.emit("task.created", { taskId });
      return true;
    } catch {
      return false;
    }
  }
}

function readRole(file) {
  try {
    const head = readFileSync(file, "utf8").split("\n", 1)[0];
    const m = head.match(/^role:\s*(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function appendNote(file, note) {
  if (!note) return;
  try {
    writeFileSync(file, readFileSync(file, "utf8") + `\n\n---\n${note}\n`);
  } catch {}
}
