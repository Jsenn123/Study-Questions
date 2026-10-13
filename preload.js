/**
 * 预加载脚本
 *
 * 本应用是纯前端应用（直接双击 index.html 也能正常运行），绝大部分功能都不需要
 * 主进程参与。只有「让原生窗口按钮跟随亮/暗主题变色」这一项必须由主进程完成，
 * 因此这里只暴露这一个接口，其余一概不开放。
 *
 * 页面侧通过 window.desktop 是否存在来判断当前是否运行在 Electron 中
 * （见 JS/app.js 的 applyTheme、initDesktopChrome），在浏览器中打开时自动跳过。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  // 运行平台（"win32" / "darwin" / "linux"），用于适配 macOS 的红绿灯按钮留白
  platform: process.platform,
  // 通知主进程切换窗口按钮配色，参数为 "light" | "dark"
  setTitleBarTheme: function (theme) {
    ipcRenderer.send("titlebar-theme", theme === "dark" ? "dark" : "light");
  },
});
