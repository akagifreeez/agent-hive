import fs from "fs";
const p = "test/long-run-resilience.test.js";
let src = fs.readFileSync(p, "utf8");
const bs = String.fromCharCode(92);
// 望ましい状態: 子ソースに write("ALIVE\n") と展開される = src上は ALIVE\<backslash>n …
// しかしJSテンプレートリテラルで `\n` は改行1文字になる。子ソースに改行1文字が入ると文字列リテラルが
// 分断されてSyntaxErrorだった。子ソースとして改行エスケープ(\nの2文字)を書くには src上では \n(2文字)。
// → 現在の98行 `ALIVE\n`(src 2文字)は評価後 backslash+n になり stdoutは "ALIVE\n"(改行ではなくリテラル2文字)
//   実測 stdout="ALIVE\n" — リテラル2文字が出た。つまり子は `write("ALIVE\n")` を実行した(改行ではなく\n 2文字)
// → assert は /ALIVE 2/ 等なので part一致、stdout "ALIVE\n" でも /ALIVE/ は一致する。
// 問題は対照(noGuard)側が死ぬこと。直接実行でerr=1は出た。 → 子の挙動はOK。
// 475ms で死ぬ理由をもう一度: assert.ok(noGuard.err) が false。execFileで err=null = exit 0 = 生存。
// cover が "process.on("unhandledRejection"…)" なら rejectionは握り潰されて生存=err=null が正!
// テストの意図(対照=死ぬ)は「process.onを置かない」版。現CHILD_COVERはprocess.on付き(=誤り)。
// → CHILD_COVERから process.on 行を削除する(対照は素のまま死ぬ)
const before = 'const CHILD_COVER = `' + String.fromCharCode(10) + 'process.on("unhandledRejection", () => {});';
const after = 'const CHILD_COVER = `' + String.fromCharCode(10) + '// 対照: ガード無し。process.onを置かないのでrejectionで死ぬ(exit 1)';
if (!src.includes(before)) { console.error("pattern not found"); process.exit(1); }
src = src.replace(before, after);
fs.writeFileSync(p, src);
console.log("removed process.on from CHILD_COVER");
