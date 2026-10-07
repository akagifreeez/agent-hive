// 一時検証スクリプト2: npmフラグ対応の正規表現を確定させる(実行後削除)
const S = String.fromCharCode(92);
const CC = "[;&|(" + "]";
// 目標: 以下を true にする
//   npm test / npm  test(複数空白) / npm run test / npm run test:xxx
//   npm --silent run test / npm --x --y --z test / npm run --x test:ok / npm --silent test
// 以下は false:
//   npmtest / npm install / npm run lint / npm run lint test / npm --version / npm run --x test
// 構造: npm の後ろに (フラグ|run詞)* が続き、test / test:xxx が来る
const body =
  "npm" + S + "s+" +
  "(?:" +
    "(?:--" + S + "S+|run)" + S + "s+" +
  ")*" +
  "(?:--)?test(?::" + S + "S+)?" +
  "(?=" + S + "s|" + "$" + ")";
const re = new RegExp("(^|" + CC + S + "s*)" + body);

const yes = [
  "npm test", "npm  test", "npm run test", "npm run test:smoke",
  "npm --silent run test", "npm --x --y --z test", "npm run --x test:ok",
  "npm --silent test", "echo npm test",
];
const no = [
  "npmtest", "npm install", "npm audit", "npm run lint", "npm run lint test",
  "npm --version", "npm run --x test", "echo npmtest",
];
let ok = true;
for (const c of yes) if (!re.test(c)) { ok = false; console.log("FAIL-should-true:", JSON.stringify(c)); }
for (const c of no) if (re.test(c)) { ok = false; console.log("FAIL-should-false:", JSON.stringify(c)); }
console.log(ok ? "NPM-RE-OK" : "NPM-RE-BAD");
console.log("source:", re.source);

// node --test 側
const re2 = new RegExp("(^|" + CC + S + "s*)node" + S + "s+--test(" + S + "s|" + "$" + ")");
const y2 = ["node --test", "node  --test tests/*.test.js", "node --test --test-force-exit test/*.test.js", "a && node --test x"];
const n2 = ["node src/server.js --test", "node --experimental-vm-modules s.js", "node file.js", "echo nodetest"];
for (const c of y2) if (!re2.test(c)) { ok = false; console.log("FAIL2-should-true:", JSON.stringify(c)); }
for (const c of n2) if (re2.test(c)) { ok = false; console.log("FAIL2-should-false:", JSON.stringify(c)); }
console.log(ok ? "ALL-OK" : "SOME-BAD");
console.log("re2:", re2.source);
