// createWorktree破壊経路の再現(ワークスペース内で実施、作業後に削除)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
const here = dirname(pathToFileURL(import.meta.url).href).replace(/\/g, "/");
const { createWorktree } = await import(here + "/src/engine/worktree.js");
const { runCommand } = await import(here + "/src/engine/exec.js");

const ws = mkdtempSync(join(tmpdir(), "hive-cw-"));
const root = `${ws}-wt`;
await runCommand({ command: "git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init", cwd: ws, outputLimit: 500 });
const p1 = await createWorktree({ mainWorkspace: ws, worktreeRoot: root, agentId: "x-alpha" });
writeFileSync(join(p1, "half-done.txt"), "crashed\n");
await runCommand({ command: `git add -A && git -c user.name=t -c user.email=t@t commit -q -m "wip-crash"`, cwd: p1, outputLimit: 500 });
const before = await runCommand({ command: "git log --all --oneline", cwd: ws, outputLimit: 500 });
console.log("before has wip-crash:", /wip-crash/.test(before.text));
await createWorktree({ mainWorkspace: ws, worktreeRoot: root, agentId: "x-alpha" });
const after = await runCommand({ command: "git log --all --oneline", cwd: ws, outputLimit: 500 });
console.log("after has wip-crash:", /wip-crash/.test(after.text), after.text.includes("wip-crash") ? "" : "(消失=破壊)");
try { rmSync(ws, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); } catch {}
