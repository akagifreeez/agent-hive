console.log("A");
process.on("exit",()=>console.log("exit-handler"));
import("./scripts/watchdog.mjs").then(m=>console.log("imported")).catch(e=>console.log("err",e.message));
