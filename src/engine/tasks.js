// タスクblackboard。workspace/tasks/{open,claimed,done} 配下のMarkdownファイルが
// 仕事そのもの。claimは「open→claimedへのrename」=同一ボリュームで原子的なので、
// 複数エージェントが同時に請求しても二重請求が起きない。
import { mkdirSync, readdirSync, renameSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export class TaskBlackboard {
  constructor(workspace) {
    this.dir = join(workspace, "tasks");
    this.open = join(this.dir, "open");
    this.claimed = join(this.dir, "claimed");
    this.done = join(this.dir, "done");
    for (const d of [this.open, this.claimed, this.done]) mkdirSync(d, { recursive: true });
  }

  seed(tasks) {
    for (const t of tasks ?? []) {
      const f = join(this.open, `${t.id}.md`);
      if (existsSync(f)) continue;
      const roleLine = t.role ? `role: ${t.role}\n` : "";
      writeFileSync(f, `${roleLine}\n${t.body ?? ""}\n`);
    }
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

  snapshot() {
    const list = (dir) => readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    return { open: list(this.open), claimed: list(this.claimed), done: list(this.done) };
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
