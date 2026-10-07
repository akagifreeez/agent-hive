console.log("A");
import("./scripts/watchdog.mjs").then(m=>console.log("wd ok", typeof m.startIfNeeded)).catch(e=>console.log("ERR", e && e.message));
console.log("B");
