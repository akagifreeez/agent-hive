import fs from "fs";
const p = "test/long-run-resilience.test.js";
let src = fs.readFileSync(p, "utf8");
// CHILD_COVER内の "ALIVE\n" はテンプレートリテラル内なので "\n" は子プロセス側で "\n"(リテラル2文字)に….
// 実際: src上の文字列は backslash backslash n。テンプレートリテラル評価で backslash n(リテラル)になり、
// 子プロセスのソースでは "ALIVE\n" と書かれたことになる → 子では改行として評価され正しい…はず。
// ただし先ほどの直接検証では SyntaxError になった。原因: writeFileSyncした文字列に改行が入る?
// → cover.mjsの実体を確認するため、テストと同じ手順で書き出して中身を見る
const CHILD_COVER = `
process.on("unhandledRejection", () => {});
Promise.reject(new TypeError("terminated"));
setTimeout(() => { process.stdout.write("ALIVE\n"); }, 80);
`;
console.log(JSON.stringify(CHILD_COVER));
