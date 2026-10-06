import { readFileSync, writeFileSync } from "node:fs";
const p = "test/model-policy-conflict-wiring.test.js";
const lines = readFileSync(p, "utf8").split("\n");
const out = [];
let done = false;
for (const l of lines) {
  if (!done && l.includes('const c1 = await alpha.execute("claim_next_task", {});')) {
    out.push('    tasks.create({ id: "cw1", role: "impl", body: "work" });');
    done = true;
  }
  out.push(l);
}
writeFileSync(p, out.join("\n"));
process.stdout.write("inserted:" + done + "\n");
