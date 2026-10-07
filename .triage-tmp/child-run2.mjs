import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "child5-"));
const child = join(dir, "child.mjs");
const log = join(dir, "err.log");
writeFileSync(child, [
  'import { installCrashGuard } from "../src/engine/crash-guard.js";',
  'const g = installCrashGuard({ logFile: process.argv[2] });',
  'Promise.reject(Object.assign(new TypeError("terminated"), { code: undefined }));',
  'setTimeout(() => { Promise.reject("moji"); }, 20);',
  'setTimeout(() => {',
  '  try { process.stdout.write("ALIVE " + g.guardCount() + String.fromCharCode(10)); } catch {}',
  '}, 80);',
  '',
].join("\n"));
execFile(process.execPath, [child, log], { timeout: 15000, cwd: process.cwd() }, (err, stdout, stderr) => {
  console.log("err=", err ? (err.code ?? "") + " " + err.message.slice(0, 300) : null);
  console.log("stdout=", JSON.stringify(stdout));
  console.log("stderr=", String(stderr).slice(0, 500));
});
