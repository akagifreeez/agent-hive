// 一時検証スクリプト: 修正版isTestCommandのロジック確認(実行後削除)
// 文字クラス [;&|(] を含む正規表現。ここではnew RegExpで組み立てる(
// リテラル内の文字クラス閉じ忘れミスを構造的に避けるため)。
const CC = "[;&|(" + "]"; // 文字クラス: 行頭または && ; | ( の直後
const S = String.fromCharCode(92); // バックスラッシュ
const re1 = new RegExp("(^|" + CC + S + "s*)npm" + S + "s+(run" + S + "s+)?test");
const re2 = new RegExp("(^|" + CC + S + "s*)node" + S + "s+--test");
const re3 = new RegExp("(^|" + CC + S + "s*)npm" + S + "s+(--" + S + "S+" + S + "s+)*--test(" + S + "s|$)");

function isTestCommand(command) {
  const c = String(command ?? "");
  if (re1.test(c) || re2.test(c)) return true;
  return re3.test(c);
}

const yes = [
  "npm test", "npm  test", "npm run test", "npm run test:smoke",
  "npm --silent run test", "npm --x --y --z test", "npm run --x test:ok",
  "echo npm test", "node --test", "node  --test tests/*.test.js",
  "node --test --test-force-exit test/*.test.js", "a && npm test", "a; node --test x",
];
const no = [
  "npmtest", "npm install", "npm audit", "npm run lint", "npm run lint test",
  "node src/server.js --test", "node --experimental-vm-modules s.js",
  "node file.js", "git status", "echo done", "echo retest", "echo npmtest",
];
let ok = true;
for (const c of yes) if (!isTestCommand(c)) { ok = false; console.log("FAIL-should-true:", JSON.stringify(c)); }
for (const c of no) if (isTestCommand(c)) { ok = false; console.log("FAIL-should-false:", JSON.stringify(c)); }
console.log(ok ? "FN-LOGIC-OK" : "FN-LOGIC-BAD");
console.log("re1:", re1.source);
console.log("re2:", re2.source);
console.log("re3:", re3.source);
