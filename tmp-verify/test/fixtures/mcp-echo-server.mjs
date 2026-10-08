// MCPテスト用のエコーサーバー(新しい行区切りJSON-RPC)
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      send({ id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "echo", version: "1.0" } } });
    } else if (msg.method === "notifications/initialized") {
      // 応答なし
    } else if (msg.method === "tools/list") {
      send({
        id: msg.id,
        result: {
          tools: [{
            name: "echo",
            description: "受け取ったテキストをそのまま返す",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          }],
        },
      });
    } else if (msg.method === "tools/call") {
      send({ id: msg.id, result: { content: [{ type: "text", text: "echo: " + JSON.stringify(msg.params.arguments ?? {}) }] } });
    } else if (typeof msg.id === "number") {
      send({ id: msg.id, result: {} });
    }
  }
});
function send(m) {
  process.stdout.write(JSON.stringify(m) + "\n");
}
