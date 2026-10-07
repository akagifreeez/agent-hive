// exec.jsからisTestCommandをimportして、テストの期待表を直接照合する
const m = await import("./src/engine/exec.js");
const f = m.isTestCommand;
const yes = [
  "npm test", "npm test -- tests/exec.test.js", "npm  test", "npm --test",
  "npm run test", "npm run test:smoke", "npm run test -- extra",
  "npm --silent run test", "npm --x --y --z test", "npm run --x test:ok",
  "echo npm test", "node --test", "node  --test tests/*.test.js",
  "node --test --test-force-exit test/*.test.js", "a && npm test", "a; node --test x",
];
const no = [
  "npmtest", "npm install", "npm audit", "npm run lint", "npm run lint test",
  "node src/server.js --test", "node --experimental-vm-modules script.js",
  "node file.js", "git status", "echo done", "echo retest", "echo npmtest",
];
let bad = 0;
for (const c of yes) if (!f(c)) { bad++; console.log("NG yes:", JSON.stringify(c)); }
for (const c of no) if (f(c)) { bad++; console.log("NG no:", JSON.stringify(c)); }
console.log(bad === 0 ? "ALL PASS" : bad + " NG");
