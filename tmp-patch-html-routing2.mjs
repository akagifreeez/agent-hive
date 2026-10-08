// パッチ5: index.html — ルーティングスイッチのJS配線(openSettings初期化+トグルハンドラ)
import { readFileSync, writeFileSync } from "node:fs";

const p = "src/ui/public/index.html";
let src = readFileSync(p, "utf8");
if (src.includes("\r\n")) src = src.split("\r\n").join("\n");

function mustReplace(oldText, newText, label) {
  if (!src.includes(oldText)) {
    console.error("PATCH5 FAIL: 見つかりません: " + label);
    process.exit(1);
  }
  src = src.replace(oldText, newText);
}

// --- (A) openSettings()内の初期化: 現在の実効状態を /api/routing から取得して反映 ---
mustReplace(
  'function openSettings() {\n  // 現在値: UIから変更済みならその値、未変更ならサーバーが配る実値(live)/config値\n  $("set-perm").value = lastState?.live?.permMode ?? "normal";',
  [
    'function openSettings() {',
    '  // 現在値: UIから変更済みならその値、未変更ならサーバーが配る実値(live)/config値',
    '  $("set-perm").value = lastState?.live?.permMode ?? "normal";',
    '  syncRoutingSwitch(); // モデルルーティングの実効状態(ON/OFF+反映タイミング)をサーバーから取り直す',
  ].join("\n"),
  "openSettings hook",
);

// --- (B) トグルハンドラと状態取得関数を追加(set-permのchangeハンドラ近くではなく、openSettings定義の直後にまとめて置く) ---
mustReplace(
  '// 作業先チップ(ヘッダ左)とモデル未接続警告バー(composer上)。どちらもlastStateから描画する',
  [
    '// モデルルーティングスイッチ: 実効状態の表示とON/OFFの保存(/api/routing)。',
    '// 保存先はhive.local.jsonのmodels.routing.enabled(configより優先)。反映はhiveの再起動後',
    '// (モデル実体はラウンド開始時に組立られるため)。既存の設定カードには触れない。',
    'async function syncRoutingSwitch() {',
    '  try {',
    '    const r = await (await hfetch("/api/routing")).json();',
    '    $("set-routing").checked = Boolean(r.enabled);',
    '    $("set-routing-note").textContent = r.enabled ? "ON(重い呼出は高性能モデルへ)。反映: 現在の設定(再起動で確定)" : "OFF(全て既定モデル)。変更の反映: hiveの再起動後";',
    '  } catch { $("set-routing-note").textContent = "状態の取得に失敗しました"; }',
    '}',
    '$("set-routing").addEventListener("change", async () => {',
    '  const enabled = $("set-routing").checked;',
    '  try {',
    '    const r = await (await hfetch("/api/routing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) })).json();',
    '    if (r.error) { toast("モデルルーティング: " + r.error, "warn"); syncRoutingSwitch(); return; }',
    '    toast("モデルルーティングを " + (r.enabled ? "ON" : "OFF") + " にしました(再起動後に有効)", "ok");',
    '    syncRoutingSwitch();',
    '  } catch { toast("保存に失敗しました", "warn"); syncRoutingSwitch(); }',
    '});',
    '',
    '// 作業先チップ(ヘッダ左)とモデル未接続警告バー(composer上)。どちらもlastStateから描画する',
  ].join("\n"),
  "toggle handler",
);

writeFileSync(p, src, "utf8");
console.log("PATCH5 OK: index.html へJS配線を追加");
