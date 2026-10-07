import { isTestCommand } from "./src/engine/exec.js";
const cases = ["npm --test", "npm run test:smoke", "npm run test", "npm test:later", "npm test"];
for (const c of cases) console.log(JSON.stringify(c), "->", isTestCommand(c));
