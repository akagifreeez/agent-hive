// テストと同じ手順でcover.mjsを書き出して実行し、errの有無を確認
import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "cover2-"));
const coverPath = join(dir, "cover.mjs");
const CHILD_COVER = `
process.on("unhandledRejection", () => {});
Promise.reject(new TypeError("terminated"));
setTimeout(() => { process.stdout.write("ALIVE\n"); }, 80);
`;
writeFileSync(coverPath, CHILD_COVER);
console.log("---cover.mjs---");
console.log(readFileSync(coverPath, "utf8"));
execFile(process.execPath, [coverPath], { timeout: 15000, cwd: process.cwd() }, (err, stdout) => {
  console.log("err=", err ? (err.code ?? err.message.slice(0, 100)) : null, "stdout=", JSON.stringify(stdout));
});
