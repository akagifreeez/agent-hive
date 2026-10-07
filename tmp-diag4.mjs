// 「npm --test」が落ちる原因を分解して特定する
const BS = String.fromCharCode(92);
const head = "(^|" + BS + "s|&|;|&&|" + BS + BS + "|" + BS + BS + "|)";
console.log("head part:", head);
// npmの後: \s+ は「 」1個以上。--testは - を含む。--?[a-z-]+ は「--test」にマッチするはず
const opt = "(?:--?[a-z-]+" + BS + "s+)*";
const core = "-?test";
for (const s of ["npm --test", "npm run test", "npm  test"]) {
  // head直後の^が「npm」の前に立つか
  const m1 = new RegExp(head + "npm").exec(s);
  console.log(JSON.stringify(s), "head match:", m1 ? JSON.stringify([m1[0], m1[1]]) : null);
}
const full = head + "npm" + BS + "s+" + opt + core;
for (const s of ["npm --test", "npm run test"]) {
  const m = new RegExp(full).exec(s);
  console.log(JSON.stringify(s), "full:", m ? JSON.stringify(m[0]) : null);
}
