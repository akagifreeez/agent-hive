console.log("step1");
import { startIfNeeded } from './scripts/watchdog.mjs';
console.log("step2 imported");
const r1 = await startIfNeeded({ probe: async () => false, enabled: () => false, spawn: () => console.log('NO') });
console.log("step3 result:", r1);
