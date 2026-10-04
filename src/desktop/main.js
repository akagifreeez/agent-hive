// agent-hiveのElectron殻(v4)。
// サーバー(依存ゼロのlocalhost UI+シナリオ実行)はそのまま使い、
// デスクトップアプリとしての窓・トレイ常駐・ネイティブ通知だけを足す。
import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, dialog } from "electron";
import { writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { loadConfig, dataDir } from "../config.js";
import { createModelFactory } from "../model/factory.js";
import { startUi } from "../ui/server.js";
import { chatUiHandlers } from "../ui/chat-wiring.js";
import { runChat } from "../runner.js";
import { Bus } from "../engine/board.js";
import { wireConsoleLog } from "../log.js";

const SMOKE = process.argv.includes("--smoke");
const SCENARIO = process.argv.includes("--scenario"); // 既定はchatモード(v5)。--scenarioで従来のバッチ実行
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
  // 梱包実行時は書き込み可能な場所(userData)をデータ基準にする。設定JSON/personasは同梱物で読む
  if (app.isPackaged && !process.env.HIVE_DATA) {
    process.env.HIVE_DATA = app.getPath("userData");
  }
  const config = loadConfig();
  const bus = new Bus();
  wireConsoleLog(bus);

  // smokeモード: chat配線とサーバーの立ち上がりだけ確認し、窓も出さず終了する
  if (SMOKE) {
    // runChatがthread.opened等を発火する前にUIが聞き始めている必要があるため、startUiを先に立てる
    let smokeController = null;
    await startUi({ config, bus, autoStart: false, onSay: (text, thread) => smokeController?.say(text, thread) });
    smokeController = await runChat({ config, bus });
    const resultFile = process.env.HIVE_SMOKE_FILE ?? "smoke-result.txt";
    try {
      // Electronのfetchはシステムプロキシの影響でlocalhostでも滞留することがあるためnodeのhttpで疎通する
      const ok = await new Promise((resolve) => {
        const req = http.get({ host: "localhost", port: config.ui.port, path: "/api/state", timeout: 5000 }, (r) => resolve(r.statusCode === 200));
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
      });
      writeFileSync(resultFile, ok ? "SMOKE OK\n" : "SMOKE FAIL (HTTP)\n");
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
  bus.on("merge.completed", (p) =>
    notify(`マージ: ${p.taskId}`, (p.summary ?? "").trim() || `${p.agent} がタスクをマージしました。`));
  bus.on("thread.opened", (p) =>
    notify(`スレッド開始: ${p.name}`, p.goal ?? ""));

  if (SCENARIO) {
    await startUi({ config, modelFactory: createModelFactory(config), bus, autoStart: true });
  } else {
    // 既定: メインチャット常駐モード(v6: リーダー+サブスレッド)
    // thread.openedの取りこぼし防止のため、UIの待ち受けを先に立ててからrunChatする
    let controller = null;
    await startUi({
      config, bus, autoStart: false,
      ...chatUiHandlers(() => controller),
    });
    controller = await runChat({ config, bus });
  }

  win = new BrowserWindow({
    width: 1440,
    height: 920,
    title: "agent-hive",
    backgroundColor: "#14171c",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, webviewTag: true },
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
    { label: "ワークスペースを変更...", click: async () => {
      const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "ワークスペースを選択" });
      if (r.canceled || !r.filePaths[0]) return;
      writeFileSync(join(dataDir(), "hive.local.json"), JSON.stringify({ workspace: r.filePaths[0], worktrees: { dir: join(r.filePaths[0], "wt") } }, null, 1));
      app.relaunch();
      app.quit();
    } },
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
