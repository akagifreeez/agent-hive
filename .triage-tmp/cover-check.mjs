// 対照プロセスが本当に死ぬか確認(node 24のデフォルト挙動)
import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "cover-"));
const cover = join(dir, "cover.mjs");
writeFileSync(cover, [
  'process.on("unhandledRejection", () => {});',
  'Promise.reject(new TypeError("terminated"));',
  'setTimeout(() => { process.stdout.write("ALIVE\n"); }, 80);',
].join("\n"));
execFile(process.execPath, [cover], { timeout: 15000 }, (err, stdout, stderr) => {
  console.log("err=", err ? err.code : null, "stdout=", JSON.stringify(stdout));
  console.log("stderr=", String(stderr).slice(0, 200));
});
