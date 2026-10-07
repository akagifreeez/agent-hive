const block = String.fromCharCode(10) + "✖ chat: x (97ms)" + String.fromCharCode(10) + "  Error: ストリームが途切れました(stall)";
const re = new RegExp("^" + String.fromCharCode(92) + "s{0,4}([A-Za-z_$][" + String.fromCharCode(92) + "w$]*(?:" + String.fromCharCode(92) + "s*" + String.fromCharCode(92) + "[[A-Z_]+" + String.fromCharCode(92) + "])?)", "m");
console.log(re.exec(block)?.slice(1, 3));
// 素朴に行ベースで探す
for (const line of block.split(String.fromCharCode(10))) {
  const m = line.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*(?:Error|Exception))\s*(?:\[[A-Z_]+\])?:?\s*(.*)$/);
  if (m) { console.log("LINE MATCH:", JSON.stringify(m.slice(1, 3))); break; }
}
