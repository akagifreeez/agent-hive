// safePath/safeWritePath の symlink 脱出ガード検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-symlink-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}
const AGENT = { id: "alpha", displayName: "アルファ", role: "impl", personaText: "# A" };

// Windowsではsymlink作成に特権が要るため、ディレクトリにはjunctionを、
// ファイルには作成を試みて失敗したらテストをスキップする
function linkOrSkip(target, linkPath, isDir) {
  try {
    symlinkSync(target, linkPath, isDir ? "junction" : "file");
  } catch (err) {
    if (err.code === "EPERM") return false;
    throw err;
  }
  return true;
}

function makeTools(ws) {
  const bus = new Bus();
  const board = new Bus();
  const tasks = new TaskBlackboard(ws, bus);
  return createTools({ agent: AGENT, workspace: ws, mainWorkspace: ws, board, tasks, bus });
}

test("read_file: symlinkでworkspace外のファイルは読めない", async () => {
  const ws = mktmp();
  const outside = mktmp();
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "outside-data");
  if (!linkOrSkip(secret, join(ws, "leak.txt"), false)) { console.log("# skip: symlink作成権限なし"); rmTree(ws); rmTree(outside); return; }
  const tools = makeTools(ws);
  const r = await tools.execute("read_file", { path: "leak.txt" });
  assert.equal(r.ok, false);
  assert.match(r.text, /symlink|ワークスペース外/);
  rmTree(ws); rmTree(outside);
});

test("write_file: symlinkディレクトリ経由のworkspace外書き込みは拒否される", async () => {
  const ws = mktmp();
  const outside = mktmp();
  mkdirSync(join(outside, "target"));
  if (!linkOrSkip(join(outside, "target"), join(ws, "esc"), true)) { console.log("# skip: symlink作成権限なし"); rmTree(ws); rmTree(outside); return; }
  const tools = makeTools(ws);
  const r = await tools.execute("write_file", { path: "esc/evil.txt", content: "x" });
  assert.equal(r.ok, false);
  assert.match(r.text, /symlink|ワークスペース外/);
  assert.equal(existsSync(join(outside, "target", "evil.txt")), false);
  rmTree(ws); rmTree(outside);
});

test("edit_file: symlink経由のworkspace外ファイルは編集できない", async () => {
  const ws = mktmp();
  const outside = mktmp();
  const victim = join(outside, "victim.txt");
  writeFileSync(victim, "original");
  if (!linkOrSkip(victim, join(ws, "v.txt"), false)) { console.log("# skip: symlink作成権限なし"); rmTree(ws); rmTree(outside); return; }
  const tools = makeTools(ws);
  const r = await tools.execute("edit_file", { path: "v.txt", old_text: "original", new_text: "hacked" });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(victim, "utf8"), "original");
  rmTree(ws); rmTree(outside);
});

test("workspace内のsymlink(内部参照)は従来どおり扱える", async () => {
  const ws = mktmp();
  mkdirSync(join(ws, "real"));
  writeFileSync(join(ws, "real", "a.txt"), "inside");
  if (!linkOrSkip(join(ws, "real", "a.txt"), join(ws, "link.txt"), false)) { console.log("# skip: symlink作成権限なし"); rmTree(ws); return; }
  const tools = makeTools(ws);
  const r = await tools.execute("read_file", { path: "link.txt" });
  assert.equal(r.ok, true);
  assert.match(r.text, /inside/);
  rmTree(ws);
});

test("write_file: 未存在パスの新規作成(親は実在)は拒否されない", async () => {
  const ws = mktmp();
  const tools = makeTools(ws);
  const r = await tools.execute("write_file", { path: "src/new/nested.txt", content: "ok" });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(ws, "src", "new", "nested.txt"), "utf8"), "ok");
  rmTree(ws);
});
