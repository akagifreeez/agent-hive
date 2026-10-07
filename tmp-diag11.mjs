// 前置トークンを --? ではなく [a-z0-9._-]+ (-- の有無含む) にする。
// ただしそれだと「test」自身も前置になり得る→ 量指定子で test を前置に食わせないため
// 最初に test トークンを試すオーダを変えるだけでは正規表現は手前から…実は
// {0,3} は最長マッチ優先だがバックトラックで後続の test を要求する。
// 前置トークン定義から test を除外すれば食い潰しは起きない: (?!test[:\s$])[a-z0-9._-]+
const BS = String.fromCharCode(92);
const head = "(^|" + BS + "s|&|;|&&|" + BS + BS + "|" + BS + BS + "|)";
const NT = "(?!test(?::[A-Za-z0-9._-]+)?(?=" + BS + "s|$))";
const pat = head + "npm" + BS + "s+(?:" + NT + "(?:--)?[a-z0-9._-]+" + BS + "s+){0,3}(?:test(?::[A-Za-z0-9._-]+)?|--test)(?:" + BS + "s|$)";
const samples = [["npm test", true], ["npm --test", true], ["npm  test", true], ["npm run test:smoke", true], ["npm run test", true], ["npm run test -- x", true], ["npmtest", false], ["npm audit", false], ["npm run lint", false], ["npm test:later", false], ["echo npm test", true], ["npm install", false], ["npm test later", true], ["echo npm test:later", false]];
const re = new RegExp(pat);
console.log(samples.map(([s, w]) => re.test(s) === w ? "." : "X").join(""));
samples.forEach(([s, w]) => { if (re.test(s) !== w) console.log("  NG", JSON.stringify(s), "want", w, "got", re.test(s)); });
