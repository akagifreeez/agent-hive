import fs from "fs";
const p = "test/long-run-resilience.test.js";
let src = fs.readFileSync(p, "utf8");
// CHILD_COVERとCHILD_SRCの "\n" はテンプレートリテラル評価でリテラル改行になる(実害確認済み)。
// 子プロセスのソース文字列としては \"ALIVE\n\"(エスケープ済み)であるべき。
// 修正: テンプレートリテラル内の ALIVE まわりの \n を \\n に置換(評価後が \n になる)
const bs = String.fromCharCode(92);
src = src.split('write("' + "ALIVE " + bs + bs + 'n")').join('write("ALIVE ' + bs + bs + bs + bs + 'n")');
src = src.split('write("ALIVE' + bs + bs + 'n")').join('write("ALIVE' + bs + bs + bs + bs + 'n")');
// CHILD_SRC/CHILD_COVER/3つ目のテスト子src に同型が2箇所ずつある(91, 98, 138行目)
fs.writeFileSync(p, src);
console.log("patched ALIVE newlines");
