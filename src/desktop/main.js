// agent-hiveのElectron殻(v4)。
// サーバー(依存ゼロのlocalhost UI+シナリオ実行)はそのまま使い、
// デスクトップアプリとしての窓・トレイ常駐・ネイティブ通知だけを足す。
import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, dialog } from "electron";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { OpenAIModel } from "../model/openai.js";
import { startUi } from "../ui/server.js";
import { Bus } from "../engine/board.js";
import { wireConsoleLog } from "../log.js";

const SMOKE = process.argv.includes("--smoke");
let win = null;
let tray = null;
let quitting = false;

// 二重起動防止: 既に動いていればそちらへフォーカスして抜ける
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(bootstrap).catch((err) => {
    console.error("[agent-hive desktop] 起動エラー:", err);
    dialog.showErrorBox("agent-hive", `起動に失敗しました:\n${err.message}`);
    app.exit(1);
  });
}

async function bootstrap() {
  const config = loadConfig();
  const bus = new Bus();
  wireConsoleLog(bus);
  const modelFactory = () => new OpenAIModel(config.model);

  // smokeモードではシナリオを走らせず、サーバーの立ち上がりだけを確認する
  await startUi({ config, modelFactory, bus, autoStart: !SMOKE });

  if (SMOKE) {
    const resultFile = process.env.HIVE_SMOKE_FILE ?? "smoke-result.txt";
    try {
      const res = await fetch(`http://localhost:${config.ui.port}/api/state`);
      const ok = res.ok;
      writeFileSync(resultFile, ok ? "SMOKE OK\n" : `SMOKE FAIL (HTTP ${res.status})\n`);
      app.exit(ok ? 0 : 1);
    } catch (err) {
      writeFileSync(resultFile, `SMOKE FAIL (${err.message})\n`);
      app.exit(1);
    }
    return;
  }

  bus.on("scenario.finished", () =>
    notify("シナリオ完了", `「${config.scenario.name}」が終了しました。ボードを確認してください。`));
  bus.on("permission.request", (p) =>
    notify(`承認要求 #${p.id}`, `コマンドの承認待ち: ${p.command.slice(0, 80)}`));

  win = new BrowserWindow({
    width: 1440,
    height: 920,
    title: "agent-hive",
    backgroundColor: "#14171c",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  await win.loadURL(`http://localhost:${config.ui.port}`);

  // 閉じてもトレイに常駐(管理ソフト)。終了はトレイメニューから。
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  tray = new Tray(makeTrayIcon());
  tray.setToolTip("agent-hive — 常駐エージェントハーネス");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "ボードを表示", click: () => { win.show(); win.focus(); } },
    { type: "separator" },
    { label: "終了", click: () => { quitting = true; app.quit(); } },
  ]));
}

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { /* トレイ常駐するため何もしない(smokeはapp.exitで抜ける) */ });

function notify(title, body, port) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `agent-hive: ${title}`, body });
  n.on("click", () => {
    if (win) { win.show(); win.focus(); }
  });
  n.show();
}

// 単色アンバーのトレイアイコン(BGRAビットマップをその場で生成。画像ファイル不要)
function makeTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0x79; // B
    buf[i * 4 + 1] = 0xd4; // G
    buf[i * 4 + 2] = 0xff; // R
    buf[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
