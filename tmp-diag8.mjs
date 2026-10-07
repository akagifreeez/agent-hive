// step4+test が false。オプショナル量指定子 {0,3} の後の -?test が「npm --test」で失敗する
// 検証: 「{0,3}」が繰り返しの終端まで食い潰してバックトラックで test に届くはずだが…
const BS = String.fromCharCode(92);
const opt = "(?:--?[a-z0-9._-]+" + BS + "s+){0,3}";
const t = "-?test";
const probe = (s) => new RegExp("^" + opt + t + BS + "s").test(s) || new RegExp("^" + opt + t + "$").test(s);
console.log("eat 1 token then test, '--test ':", probe("--test "));
console.log("direct:", new RegExp("^" + t).test("--test"));          // -? は - を食い test は…「test」→OKのはず
console.log("direct2:", new RegExp("^-?test" + BS + "b").test("--test"));
// -? は「-」1個。--test の2個目の - は test の一部になれない
// → -?test は --test にマッチしない!(-test にしか合わない)
console.log("-?test vs '-test':", new RegExp("^-?test$").test("-test"));
