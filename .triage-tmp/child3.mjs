// CHILD_SRCのimport相対パスがtmpdirから解決できない — テストはどう解決しているか確認。
// テスト内CHILD_SRC: import ... from "../src/engine/crash-guard.js" で cwd=process.cwd()(worktree)でも
// 子はtmpdir配下なので "../src/..." は tmpの親 = C:\Users\...\Temp\src\... を見てしまう。
// → 解決策: importを絶対fileURLにする。テストで CHILD_SRC を動的に組み立てる(経由で実パスを埋め込む)。
import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const dir = mkdtempSync(join(tmpdir(), "child6-"));
const child = join(dir, "child.mjs");
const log = join(dir, "err.log");
const guardUrl = pathToFileURL(join(process.cwd(), "src", "engine", "crash-guard.js")).href;
writeFileSync(child, [
  'import { installCrashGuard } from "' + guardUrl + '";',
  'const g = installCrashGuard({ logFile: process.argv[2] });',
  'Promise.reject(Object.assign(new TypeError("terminated"), { code: undefined }));',
  'setTimeout(() => { Promise.reject("moji"); }, 20);',
  'setTimeout(() => {',
  '  try { process.stdout.write("ALIVE " + g.guardCount() + String.fromCharCode(10)); } catch {}',
  '}, 80);',
].join("\n"));
execFile(process.execPath, [child, log], { timeout: 15000, cwd: process.cwd() }, (err, stdout, stderr) => {
  console.log("err=", err ? err.code + " " + err.message.slice(0, 120) : null);
  console.log("stdout=", JSON.stringify(stdout));
  if (err) console.log("stderr=", String(stderr).slice(0, 300));
});
