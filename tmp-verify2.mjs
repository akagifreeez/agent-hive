import { isTestCommand } from './src/engine/test-semaphore.js';
console.log('npm test =>', isTestCommand('npm test'));
console.log('node --test =>', isTestCommand('node --test'));
const c = String('npm test');
const opt = "(?:\s+-{1,2}[^\s]+)*";
console.log('opt literal:', JSON.stringify(opt));
