// UIモック配信サーバー: http://localhost:7788/ui-mock.html
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const root2 = join(root, "..");
const docsDir = join(root2, "docs");
createServer((req, res) => {
  const p = req.url === "/" ? "/ui-mock.html" : req.url.split("?")[0];
  try {
    const f = readFileSync(join(docsDir, p));
    const mime = p.endsWith(".html") ? "text/html; charset=utf-8" : p.endsWith(".js") ? "text/javascript" : "application/octet-stream";
    res.writeHead(200, { "content-type": mime });
    res.end(f);
  } catch {
    res.writeHead(404).end();
  }
}).listen(7788, "127.0.0.1", () => console.log("mock: http://localhost:7788/ui-mock.html"));
