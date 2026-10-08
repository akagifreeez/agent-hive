import fs from "fs";
const p = "test/long-run-resilience.test.js";
let src = fs.readFileSync(p, "utf8");
if (!src.includes("node:url")) {
  src = src.replace('import { join } from "node:path";', 'import { join } from "node:path";\nimport { pathToFileURL } from "node:url";');
  fs.writeFileSync(p, src);
  console.log("import added");
} else console.log("already imported");
