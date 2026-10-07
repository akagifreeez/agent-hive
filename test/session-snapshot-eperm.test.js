// イシュー#32回帰: セッション保存/復元の堅牢性
// (1)state直下にサブディレクトリ(usage-trace/)があってもsaveがEPERMで落ちない
// (2)A保存→B固有の履歴(board/mem)作成→A復元でBの履歴が混入しない(集合一致)
// (3)保存失敗時、中途スナップショットがlistに現れない(完成済み扱いされない)
// 対象外(監査・OAuth機微・sessions自身)は保存・復元・削除のいずれも触らない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, saveSession, loadSession } from "../src/engine/sessions.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-sessions-eperm-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのロックは無視 */ }
}

test("#32: usage-traceサブディレクトリがあってもsaveが成功する", () => {
  const ws = mktmp();
  const state = join(ws, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "board__main__.jsonl"), '{"id":1}\n');
  mkdirSync(join(state, "usage-trace"), { recursive: true });
  writeFileSync(join(state, "usage-trace", "usage-trace.jsonl"), '{"turn":1}\n');
  const r = saveSession(ws, "snap-dir");
  assert.equal(r.ok, true, `save失敗: ${r.error ?? ""}`);
  // ディレクトリごと保存されている
  assert.equal(existsSync(join(state, "sessions", "snap-dir", "usage-trace", "usage-trace.jsonl")), true);
  rmTree(ws);
});

test("#32: A保存→B固有履歴作成→A復元でBの履歴が混入しない", () => {
  const ws = mktmp();
  const state = join(ws, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "board__main__.jsonl"), "A-board\n");
  writeFileSync(join(state, "mem-lead.json"), "A-mem");
  assert.equal(saveSession(ws, "point-A").ok, true);
  // Bセッションで固有の履歴を作る(新ボード・新メモリ・main追記)
  writeFileSync(join(state, "board-thread-b.jsonl"), "B-board\n");
  writeFileSync(join(state, "mem-beta.json"), "B-mem");
  writeFileSync(join(state, "board__main__.jsonl"), "A-board+B追記\n");
  assert.equal(loadSession(ws, "point-A").ok, true);
  assert.match(readFileSync(join(state, "board__main__.jsonl"), "utf8"), /^A-board\n$/, "mainはA時点へ戻る");
  assert.equal(existsSync(join(state, "board-thread-b.jsonl")), false, "B固有ボードは消える");
  assert.equal(existsSync(join(state, "mem-beta.json")), false, "B固有メモリは消える");
  rmTree(ws);
});

test("#32: 復元でもusage-trace等サブディレクトリはディレクトリとして扱う", () => {
  const ws = mktmp();
  const state = join(ws, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(state, "usage-trace"), { recursive: true });
  writeFileSync(join(state, "usage-trace", "usage-trace.jsonl"), '{"turn":1}\n');
  assert.equal(saveSession(ws, "snap-restore").ok, true);
  // 現stateのusage-traceを中身だけ変えても復元で戻る
  writeFileSync(join(state, "usage-trace", "usage-trace.jsonl"), '{"turn":99}\n');
  assert.equal(loadSession(ws, "snap-restore").ok, true);
  assert.match(readFileSync(join(state, "usage-trace", "usage-trace.jsonl"), "utf8"), /"turn":1/);
  rmTree(ws);
});

test("#32: 保存失敗時、中途スナップショットはlistに現れない(完成扱いされない)", () => {
  const ws = mktmp();
  const state = join(ws, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "board__main__.jsonl"), '{"id":1}\n');
  // name検証は保存前に行われるので、失敗経路はstate自体の不存在で起こす
  const badWs = mktmp();
  const r = saveSession(badWs, "half-done");
  assert.equal(r.ok, false);
  assert.deepEqual(listSessions(badWs), [], "失敗保存は完成済みとして列挙されない");
  rmTree(ws);
  rmTree(badWs);
});

test("#32: 対象外(監査・OAuth機微)は保存・復元・復元時削除のいずれもしない", () => {
  const ws = mktmp();
  const state = join(ws, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "board__main__.jsonl"), '{"id":1}\n');
  writeFileSync(join(state, "audit.jsonl"), '{"cmd":"x"}\n');
  writeFileSync(join(state, "models-openai.oauth.json"), '{"refresh":"secret"}');
  assert.equal(saveSession(ws, "snap-excl").ok, true);
  const snap = join(state, "sessions", "snap-excl");
  assert.equal(existsSync(join(snap, "audit.jsonl")), false, "監査台帳は保存しない");
  assert.equal(existsSync(join(snap, "models-openai.oauth.json")), false, "トークンストアは保存しない");
  // 復元時: スナップショットに無い監査・トークンは削除されず、そのまま残る
  writeFileSync(join(state, "audit.jsonl"), '{"cmd":"y"}\n');
  assert.equal(loadSession(ws, "snap-excl").ok, true);
  assert.match(readFileSync(join(state, "audit.jsonl"), "utf8"), /"cmd":"y"/, "監査台帳は復元で壊さない");
  assert.equal(existsSync(join(state, "models-openai.oauth.json")), true, "トークンストアは消さない");
  rmTree(ws);
});
