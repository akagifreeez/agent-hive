import { readFileSync, writeFileSync } from "node:fs";
const p = "src/engine/chat.js";
const lines = readFileSync(p, "utf8").split("\n");
// コンストラクタ終端: '  }' が2連続している箇所(96-97行目。unsubscribe終端の後にコンストラクタ終端)
// 96='  }'(unsubscribe終端), 97='  }'(コンストラクタ終端) → 97行目を97〜99(空行+コメント+コメント)と交換
// 具体的には: 97行目の'  }'を削り、unsubscribeブロック終端('  }'の後)へ移動させる
// 現状: ...[95]    this._subscriptions = []; [96]  } [97]  } [98](空) [99]  // 購読解除... 
// 期待: [95]this._subscriptions = []; [96]  }(ctor終端) [97](空) [98]// 購読解除... [99]// runner.js... [100]unsubscribe() {...}
const i95 = lines.findIndex((l) => l.includes("this._subscriptions = [];"));
if (i95 < 0) { console.error("anchor not found"); process.exit(1); }
// 検証: i95+1 = '  }', i95+2 = '  }', i95+3 = '', i95+4 = コメント
const okShape = lines[i95 + 1] === "  }" && lines[i95 + 2] === "  }" && lines[i95 + 3] === "" && (lines[i95 + 4] ?? "").includes("購読解除");
if (!okShape) { console.error("unexpected shape", JSON.stringify(lines.slice(i95, i95 + 6))); process.exit(1); }
// [i95+1..i95+4]のコメント2行+メソッドを [i95+1]の'  }'の後へ: 
// 1) '  }'(2個目) を削除
lines.splice(i95 + 2, 1);
// 2) unsubscribeブロック(空行+コメント2+メソッド10行)を再構成して i95+1 の後に挿入
const block = [
  "",
  "  // 購読解除: 閉じたスレッドのHostがboard/taskイベントで再び動かないようにする(イシュー#29)。",
  "  // runner.jsのcloseThreadから呼ばれる。二重呼び出しは安全(no-op)。",
  "  unsubscribe() {",
  "    if (this._unsubscribed) return;",
  "    this._unsubscribed = true;",
  "    for (const off of this._subscriptions ?? []) {",
  "      try { off?.(); } catch { /* 解除失敗は無視(既に外れている) */ }",
  "    }",
  "    this._subscriptions = [];",
  "  }",
];
// 現在 i95+1 が '  }'(unsubscribe終端だった行=コンストラクタ終端) → その後の空行+コメント2行+旧メソッド10行は i95+2 以降に残っている
// それらを削除してから、blockを挿入
lines.splice(i95 + 2, 13); // 空1+コメント2+メソッド10 = 13行
lines.splice(i95 + 2, 0, ...block);
writeFileSync(p, lines.join("\n"));
console.log("restructured: ctor end at", i95 + 1, ", unsubscribe block inserted after");
