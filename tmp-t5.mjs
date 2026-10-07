console.log("A");
import("./src/engine/tasks.js").then(m=>console.log("tasks ok", typeof m.TaskBlackboard));
