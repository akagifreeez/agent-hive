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

test("監査保護(実行後検知): 変数展開/base64で迂回したstate/への書き込みも検知され警告が返る", async () => {
  const ws = mktmp();
  const tools = mkTools(ws);
  // 静的解析を迂回: base64デコード+変数展開経由でstate/へ書き込む(コマンド文字列に state を含まない)
  const r = await tools.execute("bash", { command: "d=$(echo c3RhdGU=|base64 -d); mkdir -p $d; echo tampered > $d/audit.jsonl" });
  assert.equal(r.ok, false, "state/変化は検知され拒否扱いになるべき");
  assert.match(r.text, /state. の内容が変更/);
  rmTree(ws);
});

test("監査保護(実行後検知): state/を触らないコマンドは警告なしで成功する", async () => {
  const ws = mktmp();
  const tools = mkTools(ws);
  const r2 = await tools.execute("bash", { command: "echo hi > out3.txt" });
  assert.equal(r2.ok, true);
  assert.ok(!r2.text.includes("警告"));
  rmTree(ws);
});
