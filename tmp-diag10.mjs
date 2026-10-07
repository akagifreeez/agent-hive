// npm side の残り失敗を分解: 「npm run test」
const BS = String.fromCharCode(92);
const head = "(^|" + BS + "s|&|;|&&|" + BS + BS + "|" + BS + BS + "|)";
const opt = "(?:(?:--?[a-z0-9._-]+)" + BS + "s+){0,3}";
const t = "(?:test(?::[A-Za-z0-9._-]+)?|--test)";
const full = head + "npm" + BS + "s+" + opt + t + "(?:" + BS + "s|$)";
const re = new RegExp(full);
console.log("npm run test:", re.test("npm run test"));
// runは前置トークン (--?[a-z0-9._-]+) に合う? runは - 無し!
console.log("run as opt token:", new RegExp("^--?[a-z0-9._-]+" + BS + "s").test("run "));
