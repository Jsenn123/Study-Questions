/**
 * Electron 主进程入口
 *
 * 职责：创建应用窗口并加载 index.html。
 * 界面逻辑全部在渲染进程中（JS/app.js），此处不做任何业务处理。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

// 创建主窗口并加载界面文件
function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      // 预加载脚本（当前为空，见 preload.js）
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');
}

// Electron 初始化完成后创建窗口
app.whenReady().then(() => {
  createWindow();
});

// 所有窗口关闭后退出应用（macOS 下按平台惯例保留进程）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// macOS：进程仍在但窗口已全部关闭时，点击 Dock 图标重新创建窗口
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});