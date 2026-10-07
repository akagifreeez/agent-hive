const BS = String.fromCharCode(92);
const head = "(^|" + BS + "s|&|;|&&|" + BS + BS + "|" + BS + BS + "|)";
// 「--test」を opt (--?[a-z-]+) で食うと core「-?test」が残り「-?」が空「test」に…はならない(optがtestを消費済み)
// 解決: optを (?:[a-z-]+-)?test 形式ではなく「トークン列の後の test」を後読みで素通しする:
//   npm\s+ (?:(?!test\b)[a-z-]+\s+)*  testトークン
// [a-z-]+は「test」自身も食えるので (?!test) で除外。ただし run や --test は食える
const pat = head + "npm" + BS + "s+(?:(?!test(?=" + BS + "s|:|$))[a-z-]+" + BS + "s+)*(?:test(?:" + BS + ":[A-Za-z0-9._-]+)?)(?=" + BS + "s|$)";
const samples = [["npm test", true], ["npm --test", true], ["npm  test", true], ["npm run test:smoke", true], ["npm run test", true], ["npm run test -- x", true], ["npmtest", false], ["npm audit", false], ["npm run lint", false], ["npm test:later", false], ["echo npm test", true], ["echo run npm test", true]];
const re = new RegExp(pat);
console.log(samples.map(([s, w]) => re.test(s) === w ? "." : "X").join(""));
samples.forEach(([s, w]) => { if (re.test(s) !== w) console.log("  NG", JSON.stringify(s), "want", w, "got", re.test(s)); });
console.log("pat:", pat);
