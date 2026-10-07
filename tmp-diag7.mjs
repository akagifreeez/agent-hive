// 「npm --test」のどこで止まるか要素ごとに検証
const BS = String.fromCharCode(92);
const step1 = "(^|" + BS + "s|&|;|&&|" + BS + BS + "|" + BS + BS + "|)npm";
const step2 = step1 + BS + "s+";
const step3 = step2 + "(?:--?[a-z0-9._-]+" + BS + "s+)";
const step4 = step3 + "{0,3}";
const step5 = step4 + "-?test";
console.log("step2 on 'npm --test':", new RegExp(step2).test("npm --test"));
console.log("step3 on 'npm --test ':", new RegExp(step3).test("npm --test "));
console.log("step4+test on 'npm --test':", new RegExp(step4 + "-?test").test("npm --test"));
// --test トークン: --?[a-z0-9._-]+ は --test を食えるはず
console.log("opt on '--test ':", new RegExp("^--?[a-z0-9._-]+" + BS + "s").test("--test "));
