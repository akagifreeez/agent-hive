// パッチ3: ui/server.js — /api/routing GET/POST を追加(設定UIスイッチの永続化)
// 挿入位置は /api/workspace GET の直後(管理系エンドポイントの集まり)。
import { readFileSync, writeFileSync } from "node:fs";

const p = "src/ui/server.js";
let src = readFileSync(p, "utf8");
if (src.includes("\r\n")) src = src.split("\r\n").join("\n");

function mustReplace(oldText, newText, label) {
  if (!src.includes(oldText)) {
    console.error("PATCH3 FAIL: 見つかりません: " + label);
    process.exit(1);
  }
  src = src.replace(oldText, newText);
}

const anchor = '      if (url.pathname === "/api/workspace" && req.method === "GET") {';
const apiBlock = [
  '      if (url.pathname === "/api/routing" && req.method === "GET") {',
  '        // モデルルーティングの実効状態。実行中configから取り直す(起動後のlocal.json反映を含む)',
  '        const m = modelStateInfo(config);',
  '        return json(res, { enabled: Boolean(m.routing?.enabled), appliedAt: m.routing?.enabled != null ? "config" : null, reflectTiming: "restart" });',
  '      }',
  '      if (url.pathname === "/api/routing" && req.method === "POST") {',
  '        // モデルルーティングのON/OFF。hive.local.jsonのmodels.routing.enabledへ永続化する',
  '        // (configとの優先順位: local > config。反映はhiveの再起動後 = モデル実体はラウンド開始時に組立)',
  '        let body = "";',
  '        req.on("data", (d) => (body += d));',
  '        req.on("end", () => {',
  '          try {',
  '            const enabled = JSON.parse(body || "{}").enabled;',
  '            if (typeof enabled !== "boolean") throw new Error("enabledはbooleanで指定してください");',
  '            const localPath = resolve(dataDir(), "hive.local.json");',
  '            let local = {};',
  '            if (existsSync(localPath)) {',
  '              try { local = JSON.parse(readFileSync(localPath, "utf8")); } catch { /* 壊れていれば新規作成 */ }',
  '            }',
  '            local.models = { ...(local.models ?? {}), routing: { ...(local.models?.routing ?? {}), enabled } };',
  '            writeFileSync(localPath, JSON.stringify(local, null, 1));',
  '            json(res, { ok: true, enabled, note: "保存しました。hiveの再起動で反映されます" });',
  '          } catch (err) {',
  '            json(res, { error: err.message }, 400);',
  '          }',
  '        });',
  '        return;',
  '      }',
  '',
].join("\n");

mustReplace(anchor, apiBlock + anchor, "/api/routing block");

// resolve/existsSync/readFileSync/writeFileSync のimport有無を確認(無ければ追加)
if (!/^import \{[^}]*resolve[^}]*\} from "node:path"/m.test(src)) {
  console.error("PATCH3 WARN: node:path のresolve importが見つかりません(既存で使われているはず。要確認)");
}
writeFileSync(p, src, "utf8");
console.log("PATCH3 OK: server.js へ /api/routing を追加");
