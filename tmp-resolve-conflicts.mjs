import { readFileSync, writeFileSync } from "node:fs";
const stripCR = (s) => s.replace(/\r$/, "");
function resolve(file, side) {
  const lines = readFileSync(file, "utf8").split("\n");
  const out = [];
  let state = 0;
  let blocks = 0;
  for (const raw of lines) {
    const l = stripCR(raw);
    if (l.startsWith("<<<<<<<")) { state = 1; blocks++; continue; }
    if (l.startsWith("=======") && state === 1) { state = 2; continue; }
    if (l.startsWith(">>>>>>>") && state === 2) { state = 0; continue; }
    if (state === 0) out.push(raw);
    else if (side === "head" && state === 1) out.push(raw);
    else if (side === "main" && state === 2) out.push(raw);
  }
  writeFileSync(file, out.join("\n"));
  console.log(file, "blocks=" + blocks, "markers_left=" + out.filter((x) => /^[<>=]{7}/.test(stripCR(x))).length);
}
resolve("src/ui/server.js", "head");
resolve("test/usage-aggregate.test.js", "main");
