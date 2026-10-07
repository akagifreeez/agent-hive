// ガード付きの子(CHILD_SRC相当)を実際に走らせて死因を見る
import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "child4-"));
const child = join(dir, "child.mjs");
const log = join(dir, "err.log");
writeFileSync(child, [
  'import { installCrashGuard } from "../src/engine/crash-guard.js";',
  'const g = installCrashGuard({ logFile: process.argv[2] });',
  'Promise.reject(Object.assign(new TypeError("terminated"), { code: undefined }));',
  'setTimeout(() => { Promise.reject("文字列rejection"); }, 20);',
  'setTimeout(() => {',
  '  try { process.stdout.write("ALIVE " + g.guardCount() + "\n"); } catch {}',
  '}, 80);',
  '',
].join("\n"));
console.log("---child.mjs---");
console.log(require("node:fs").readFileSync(child, "utf8"));
execFile(process.execPath, [child, log], { timeout: 15000, cwd: process.cwd() }, (err, stdout, stderr) => {
  console.log("err=", err ? (err.code ?? "") + " " + err.message.slice(0, 200) : null);
  console.log("stdout=", JSON.stringify(stdout));
  console.log("stderr=", String(stderr).slice(0, 400));
});
