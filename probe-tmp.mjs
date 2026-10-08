try {
  const m = await import("./scripts/watchdog.mjs");
  console.log("KEYS=" + Object.keys(m).join("|"));
} catch (e) {
  console.log("ERR=" + e.message);
}
