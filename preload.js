/**
 * 预加载脚本
 *
 * 本项目为纯前端应用，渲染进程无需访问任何 Node/Electron 能力，
 * 因此暂不向 window 暴露 API，仅在页面加载完成后打印一条日志。
 */
window.addEventListener('DOMContentLoaded', () => {
  console.log('页面已加载');
});