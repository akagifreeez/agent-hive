import fs from "fs";
const p = "test/long-run-resilience.test.js";
let src = fs.readFileSync(p, "utf8");
const bs = String.fromCharCode(92);
// テンプレートリテラル内の "\n"(backslash x2 + n)は評価後 "¥n"の1文字ではなく
// backslash+n の2文字…ではない。JSでは `\n` → backslash + n(2文字)が子ソースに書かれ、
// 子では "\n"(改行)として評価される。つまり現状(98行: \n)は正しいはず。
// 実害があったのは .replace チェーンで \n → \\n にしてしまった98行を直した現在形。
// カバーファイルを実際に書き出して動かして確かめる。
const CHILD_COVER = src.match(/const CHILD_COVER = `([\s\S]*?)`;/)[1];
import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "cover3-"));
const coverPath = join(dir, "cover.mjs");
writeFileSync(coverPath, CHILD_COVER);
console.log(JSON.stringify(CHILD_COVER));
execFile(process.execPath, [coverPath], { timeout: 15000, cwd: process.cwd() }, (err, stdout) => {
  console.log("err=", err ? (err.code ?? err.message.slice(0, 80)) : null, "stdout=", JSON.stringify(stdout));
});
