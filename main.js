/**
 * Electron 主进程入口
 *
 * 职责：创建应用窗口并加载 index.html。
 * 界面逻辑全部在渲染进程中（JS/app.js），此处不做任何业务处理。
 *
 * 窗口采用无边框 + 原生窗口按钮覆盖（titleBarStyle/titleBarOverlay）：
 * 标题栏由页面自行绘制（见 index.html 的 .titlebar），右上角的最小化 / 最大化 /
 * 关闭仍由系统绘制，因此既不是系统标题栏那么呆板，又保留了原生窗口的观感与行为。
 * 页面切换主题时通过 IPC 同步窗口按钮的配色（见 preload.js）。
 */
const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const fs = require("fs");

const INDEX = path.join(__dirname, "index.html");
// 应用图标（窗口左上角 / 任务栏）。源文件是 assets/icon.svg，由 `npm run icon` 生成位图
const ICON = path.join(__dirname, "assets", "icon.png");

// 标题栏配色，须与 css/style.css 中的 --bg-card / --text-secondary 保持一致
const TITLEBAR_HEIGHT = 40;
const TITLEBAR_COLOR = {
  light: { color: "#ffffff", symbolColor: "#5b6472" },
  dark: { color: "#151a21", symbolColor: "#9aa5b1" },
};
// 窗口底色，与 CSS 的 --bg-primary 一致，避免加载与缩放时闪白
const WINDOW_BG = { light: "#f5f6f8", dark: "#0e1116" };

let win = null;

// ---- 窗口尺寸/位置记忆 ----

function statePath() {
  return path.join(app.getPath("userData"), "win-state.json");
}
// 读取上次的窗口位置与尺寸；首次启动或文件损坏时返回 null（使用默认值）
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (
      s &&
      Number.isFinite(s.width) &&
      Number.isFinite(s.height) &&
      Number.isFinite(s.x) &&
      Number.isFinite(s.y)
    ) {
      return s;
    }
  } catch (e) {
    /* 首次启动没有该文件，属正常情况 */
  }
  return null;
}
// 记录当前窗口位置与尺寸；最小化 / 全屏状态下的 bounds 无意义，跳过
function saveWindowState() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen())
    return;
  try {
    fs.writeFileSync(statePath(), JSON.stringify(win.getNormalBounds()));
  } catch (e) {}
}

// ---- 窗口创建 ----

function createWindow() {
  const saved = loadWindowState();

  win = new BrowserWindow({
    width: saved ? saved.width : 1100,
    height: saved ? saved.height : 760,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    // 低于该尺寸时双栏布局会挤在一起，故设下限（此时 CSS 会切换为单栏）
    minWidth: 720,
    minHeight: 560,
    icon: ICON,
    backgroundColor: WINDOW_BG.light,
    // 等首帧渲染完成再显示，避免看到未套用样式的白页
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: Object.assign({ height: TITLEBAR_HEIGHT }, TITLEBAR_COLOR.light),
    webPreferences: {
      // 预加载脚本，仅用于向页面暴露窗口按钮配色接口（见 preload.js）
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadFile(INDEX);

  // 无菜单后保留 F12 / Ctrl+Shift+I 打开开发者工具，便于排查问题
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const isInspect =
      input.key === "F12" ||
      (input.control && input.shift && input.key.toLowerCase() === "i");
    if (isInspect) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  win.on("resize", saveWindowState);
  win.on("move", saveWindowState);
  win.on("closed", () => {
    win = null;
  });
}

// ---- 与渲染进程的协作 ----

// 页面切换主题时同步原生窗口按钮与窗口底色（调用方见 JS/app.js 的 applyTheme）
ipcMain.on("titlebar-theme", (event, theme) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return;
  const dark = theme === "dark";
  const color = dark ? TITLEBAR_COLOR.dark : TITLEBAR_COLOR.light;
  try {
    // macOS 不支持 titleBarOverlay，此处会抛错，忽略即可
    target.setTitleBarOverlay(Object.assign({ height: TITLEBAR_HEIGHT }, color));
  } catch (e) {}
  try {
    target.setBackgroundColor(dark ? WINDOW_BG.dark : WINDOW_BG.light);
  } catch (e) {}
});

// ---- 生命周期 ----

// 去掉默认菜单（文件/编辑/视图/窗口/帮助），更接近原生应用而非浏览器
Menu.setApplicationMenu(null);

// Windows 下让任务栏把本应用与自己的窗口归为一组（也是固定到任务栏后图标正确的必要条件），
// 取值须与 package.json 的 build.appId 一致
app.setAppUserModelId("com.jsenn123.study-questions");

// Electron 初始化完成后创建窗口
app.whenReady().then(() => {
  createWindow();
});

// 所有窗口关闭后退出应用（macOS 下按平台惯例保留进程）
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// macOS：进程仍在但窗口已全部关闭时，点击 Dock 图标重新创建窗口
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
