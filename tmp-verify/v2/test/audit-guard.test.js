// 監査領域(state/)保護: bash経由での監査台帳改ざんをgatedBashが拒否すること
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-audit-guard-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

function mkTools(ws) {
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "guard-1", displayName: "ガ", role: "impl", personaText: "# G" };
  return createTools({ agent, workspace: ws, mainWorkspace: ws, board: null, tasks, bus });
}

test("監査保護: state/audit.jsonl へのリダイレクト書き込みは拒否される", async () => {
  const ws = mktmp();
  const tools = mkTools(ws);
  const r = await tools.execute("bash", { command: "echo -n '' > state/audit.jsonl" });
  assert.equal(r.ok, false);
  assert.match(r.text, /監査領域/);
  rmTree(ws);
});

test("監査保護: tee/cp/mv/rm による state/ への操作も拒否される", async () => {
  const ws = mktmp();
  const tools = mkTools(ws);
  for (const cmd of [
    "echo x | tee state/audit.jsonl",
    "cp /tmp/x state/audit.jsonl",
    "mv state/audit.jsonl /tmp/x",
    "rm state/audit.jsonl",
    "truncate -s 0 state/audit.jsonl",
  ]) {
    const r = await tools.execute("bash", { command: cmd });
    assert.equal(r.ok, false, `拒否されるべき: ${cmd}`);
    assert.match(r.text, /監査領域/);
  }
  rmTree(ws);
});

test("監査保護: state/ を読むだけ・無関係なコマンドは許可される", async () => {
  const ws = mktmp();
  const tools = mkTools(ws);
  const r1 = await tools.execute("bash", { command: "mkdir -p state && ls state/" });
  assert.equal(r1.ok, true, "読み取り系は拒否しない");
  const r2 = await tools.execute("bash", { command: "echo hello > out.txt" });
  assert.equal(r2.ok, true);
  assert.ok(existsSync(join(ws, "out.txt")));
  rmTree(ws);
});

test("監査保護: 拒否されても監査台帳自体は記録され続ける", async () => {
  const ws = mktmp();
  const tools = mkTools(ws);
  await tools.execute("bash", { command: "echo x > state/audit.jsonl" });
  const entries = readFileSync(join(ws, "state", "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sh = entries.find((e) => e.tool === "bash");
  assert.ok(sh, "拒否された実行も台帳に残る");
  assert.equal(sh.ok, false);
  rmTree(ws);
});

test("監査保護: 変数展開経由の state/ 書き込みは事後検知で警告される", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "guard-2", displayName: "ガ2", role: "impl", personaText: "# G" };
  const tools = createTools({ agent, workspace: ws, mainWorkspace: ws, board: null, tasks, bus });
  const denials = [];
  bus.on("permission.denied", (e) => denials.push(e));
  const r = await tools.execute("bash", { command: 'd=state; mkdir -p $d; echo tampered > $d/evil.jsonl' });
  assert.equal(r.ok, false, "state/ 変更は検知されて拒否扱いになる");
  assert.match(r.text, /state\/ 配下を変更/);
  assert.match(r.text, /state\/evil\.jsonl/);
  assert.equal(denials.length, 1);
  assert.ok(denials[0].stateChanged.some((p) => p.includes("evil.jsonl")));
  rmTree(ws);
});

test("監査保護: base64デコード経由の state/ 書き込みも事後検知される", async () => {
  const ws = mktmp();
  const tools = mkTools(ws);
  const payload = Buffer.from("tampered").toString("base64");
  const r = await tools.execute("bash", { command: `mkdir -p state && echo ${payload} | base64 -d | tee state/audit.jsonl` });
  // tee は事前チェックで拒否される(state/ 参照+書き込みコマンドの組合せ)
  assert.equal(r.ok, false);
  assert.match(r.text, /拒否されました/);
  rmTree(ws);
});

test("監査保護: state/ に触れない通常コマンドは事後検知で警告されない", async () => {
  const ws = mktmp();
  const tools = mkTools(ws);
  const r = await tools.execute("bash", { command: "echo fine > out2.txt && mkdir -p sub && echo x > sub/a.txt" });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.text, /監査領域/);
  rmTree(ws);
});
