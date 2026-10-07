const head = String.fromCharCode(40) + String.fromCharCode(94, 124, 92) + "s|&|;|&&|" + String.fromCharCode(92, 92) + "|" + String.fromCharCode(92) + String.fromCharCode(92) + "|)" + String.fromCharCode(41);
// 上の組み立ては紛らわしいので素直に生成する
const HEAD = "(^|" + String.fromCharCode(92) + "s|&|;|&&|" + String.fromCharCode(92) + String.fromCharCode(92) + "|" + String.fromCharCode(92) + String.fromCharCode(92) + "|)";
console.log("HEAD =", HEAD);
const re1 = new RegExp(HEAD + "npm" + String.fromCharCode(92) + "s+test");
console.log("simple npm test:", re1.test("npm test"));
