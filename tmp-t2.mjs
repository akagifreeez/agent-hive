console.log("A");
import("./scripts/watchdog.mjs").then(m=>console.log("imported", typeof m.startIfNeeded));
