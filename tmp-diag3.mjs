const HEAD = "(^|" + String.fromCharCode(92) + "s|&|;|&&|" + String.fromCharCode(92, 92) + "|" + String.fromCharCode(92, 92) + "|)";
const variants = [
  ["B1", HEAD + "npm" + String.fromCharCode(92) + "s+(?:--?[a-z-]+" + String.fromCharCode(92) + "s+)*-?test(?:" + String.fromCharCode(92) + ":[^" + String.fromCharCode(92) + "s]+" + String.fromCharCode(92) + "s*|(?=" + String.fromCharCode(92) + "s|$))"],
  ["B2", HEAD + "npm" + String.fromCharCode(92) + "s+(?:--?[a-z-]+" + String.fromCharCode(92) + "s+)*-?test(?:" + String.fromCharCode(92) + "S*$|(?=" + String.fromCharCode(92) + "s))"],
];
const samples = [["npm test", true], ["npm --test", true], ["npm  test", true], ["npm run test:smoke", true], ["npm run test", true], ["npm run test -- x", true], ["npmtest", false], ["npm audit", false], ["npm run lint", false], ["npm test:later", false], ["echo npm test", true]];
for (const [name, pat] of variants) {
  const re = new RegExp(pat);
  const marks = samples.map(([s, w]) => re.test(s) === w ? "." : "X").join("");
  console.log(name, marks);
  samples.forEach(([s, w]) => { if (re.test(s) !== w) console.log("  NG", JSON.stringify(s), "want", w); });
}
