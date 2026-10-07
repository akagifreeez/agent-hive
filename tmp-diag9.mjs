const BS = String.fromCharCode(92);
const head = "(^|" + BS + "s|&|;|&&|" + BS + BS + "|" + BS + BS + "|)";
// 確定版: npmの後0〜3個の前置トークン(オプション/run/exec等)の後に testトークン。
// testトークンは test / test:xxx / --test を許す。後続は空白か行末。
const pat = head + "npm" + BS + "s+(?:(?:--?[a-z0-9._-]+)" + BS + "s+){0,3}(?:test(?::[A-Za-z0-9._-]+)?|--test)(?:" + BS + "s|$)";
const nodePat = head + "node" + BS + "s+(?:--[^" + BS + "s]+" + BS + "s+)*--test(?:" + BS + "s|$)";
const samples = [["npm test", true], ["npm --test", true], ["npm  test", true], ["npm run test:smoke", true], ["npm run test", true], ["npm run test -- x", true], ["npmtest", false], ["npm audit", false], ["npm run lint", false], ["npm test:later", false], ["echo npm test", true], ["npm install", false], ["npm test later", true]];
const re = new RegExp(pat);
console.log("npm:", samples.map(([s, w]) => re.test(s) === w ? "." : "X").join(""));
samples.forEach(([s, w]) => { if (re.test(s) !== w) console.log("  NG", JSON.stringify(s), "want", w, "got", re.test(s)); });
const ns = [["node --test tests/*.test.js", true], ["node --test", true], ["node --test --test-force-exit test/a.test.js", true], ["node src/server.js --test", false], ["node --experimental-vm-modules script.js", false], ["node file.js", false], ["node  --test x", true]];
const nre = new RegExp(nodePat);
console.log("node:", ns.map(([s, w]) => nre.test(s) === w ? "." : "X").join(""));
ns.forEach(([s, w]) => { if (nre.test(s) !== w) console.log("  NG", JSON.stringify(s), "want", w, "got", nre.test(s)); });
