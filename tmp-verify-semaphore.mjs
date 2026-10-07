import { isTestCommand } from './src/engine/test-semaphore.js';
const yes = ['npm test','npm  test','npm run test','npm run test:smoke','npm --silent run test','npm --x --y --z test','npm run --x test:ok','npm --silent test','a && npm test','npm --test','npm --silent --test','node --test','node --test --test-force-exit test/*.test.js'];
const no = ['npmtest','npm install','npm audit','npm run lint','npm run lint test','npm --version','npm run --x test','echo npmtest','node src/server.js --test','node file.js'];
let ok = true;
for (const c of yes) if (!isTestCommand(c)) { ok = false; console.log('FAIL-should-true:', JSON.stringify(c)); }
for (const c of no) if (isTestCommand(c)) { ok = false; console.log('FAIL-should-false:', JSON.stringify(c)); }
console.log(ok ? 'IS-TEST-COMMAND-OK' : 'IS-TEST-COMMAND-BAD');
