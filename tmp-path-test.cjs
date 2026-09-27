const { resolve, sep } = require("path");
const root = resolve(".");
const cases = [
  ["..\\..\\x.txt", "backslash traversal"],
  ["a\\..\\..\\b.txt", "mixed backslash dotdot"],
  ["..\\x", "single backslash dotdot"],
];
for (const [p, label] of cases) {
  const full = resolve(root, p);
  const escapes = !(full === root || full.startsWith(root + sep));
  console.log(label, JSON.stringify(p), "->", full, "escapes:", escapes);
}