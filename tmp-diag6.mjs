// なぜ --test が落ちるか: (?:(?!test(?=\s|:|$))[a-z-]+\s+)* の部分で
// 「--test」は [a-z-]+ に食えるが、その後の test トークン要求が残る。文字列は終わり→バックトラック
// 負の先読み (?!test...) は「--test」の「test」部分でも発動する(testの直前が-なので先読みは立たない…が
// 実際は [a-z-]+ が「--test」全体を食い、先読みは食い始め位置で評価される→「--test」先頭は-なので?!testは通る
// すると次の要求「test(?=\s|:|$)」が残り、文字列末尾で失敗。オプショングループはマッチを手放さない
// → オプショングループに test で始まるトークンを食わせない のではなく「オプショナル部分の後の必須test」を
//   トークン境界から要求する形にする: 区切りを含めて test トークンを探索する
const BS = String.fromCharCode(92);
const head = "(^|" + BS + "s|&|;|&&|" + BS + BS + "|" + BS + BS + "|)";
// アプローチ転換: 「npm」から始まるトークン列のどこかに testトークンが最初にあるか(列は最大4トークン)
const pat = head + "npm" + BS + "s+(?:(?:--?[a-z0-9._-]+)" + BS + "s+){0,3}-?test(?::[A-Za-z0-9._-]+)?(?:" + BS + "s|$)";
const samples = [["npm test", true], ["npm --test", true], ["npm  test", true], ["npm run test:smoke", true], ["npm run test", true], ["npm run test -- x", true], ["npmtest", false], ["npm audit", false], ["npm run lint", false], ["npm test:later", false], ["echo npm test", true], ["npm install", false], ["npm test later", true]];
const re = new RegExp(pat);
console.log(samples.map(([s, w]) => re.test(s) === w ? "." : "X").join(""));
samples.forEach(([s, w]) => { if (re.test(s) !== w) console.log("  NG", JSON.stringify(s), "want", w, "got", re.test(s)); });
