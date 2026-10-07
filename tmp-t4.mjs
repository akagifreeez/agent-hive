console.log("A");
import("node:fs").then(m=>console.log("fs ok", typeof m.readFileSync));
