// state/へのエンジン書き込みを禁じるハードガードの検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-stateguard-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}
const AGENT = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };

function makeTools(ws) {
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  return createTools({ agent: AGENT, workspace: ws, mainWorkspace: ws, board, tasks, bus });
}

test("write_file: state/ 配下への書き込みは拒否される", async () => {
  const ws = mktmp();
  const tools = makeTools(ws);
  const r = await tools.execute("write_file", { path: "state/board.jsonl", content: "tampered" });
  assert.equal(r.ok, false);
  assert.match(r.text, /state/);
  assert.equal(existsSync(join(ws, "state", "board.jsonl")), false);
  rmTree(ws);
});

test("write_file: 大文字小文字を変えた STATE/ も非区別FSでは拒否される", async () => {
  const ws = mktmp();
  const tools = makeTools(ws);
  const r = await tools.execute("write_file", { path: "STATE/x.json", content: "x" });
  if (process.platform === "win32") {
    assert.equal(r.ok, false);
    assert.match(r.text, /state/i);
  } else {
    assert.equal(r.ok, true); // 区別するFSでは別パスとして扱われる
  }
  rmTree(ws);
});

test("edit_file: state/ 配下のファイルは編集できない", async () => {
  const ws = mktmp();
  const tools = makeTools(ws);
  const dir = join(ws, "state");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "threads.json");
  writeFileSync(file, '{"threads":{}}');
  const r = await tools.execute("edit_file", { path: "state/threads.json", old_text: "{}", new_text: "X" });
  assert.equal(r.ok, false);
  assert.match(r.text, /state/);
  assert.equal(readFileSync(file, "utf8"), '{"threads":{}}');
  rmTree(ws);
});

test("write_file: state/ 以外の通常パスは従来どおり書ける", async () => {
  const ws = mktmp();
  const tools = makeTools(ws);
  const r = await tools.execute("write_file", { path: "src/state-guard-ok.txt", content: "ok" });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(ws, "src", "state-guard-ok.txt"), "utf8"), "ok");
  rmTree(ws);
});

test("write_file: state/ を指すトラバーサルや相対表現も拒否される", async () => {
  const ws = mktmp();
  const tools = makeTools(ws);
  for (const p of ["./state/x.json", "src/../state/y.json", "state/sub/../z.json"]) {
    const r = await tools.execute("write_file", { path: p, content: "x" });
    assert.equal(r.ok, false, `path=${p} should be rejected`);
  }
  rmTree(ws);
});
