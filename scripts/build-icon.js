/**
 * 由 assets/icon.svg 生成 assets/icon.png（应用图标位图）。
 *
 * 窗口图标必须是位图（PNG），SVG 不被支持，所以把矢量源文件渲染成 512×512 的透明 PNG。
 * 这里用 Electron 自己的离屏渲染完成，不额外引入图形库。
 *
 * 用法：npm run icon
 */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

const SIZE = 512;
const SVG = path.join(__dirname, "..", "assets", "icon.svg");
const OUT = path.join(__dirname, "..", "assets", "icon.png");

if (!fs.existsSync(SVG)) {
  console.error("找不到 " + SVG);
  app.exit(1);
}

// 离屏渲染走软件绘制，不需要 GPU；同时避免在部分环境下截图一直挂起
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("enable-transparent-visuals");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false, // 离屏渲染，不需要真正显示窗口
    frame: false,
    transparent: true, // 保留圆角外的透明区域
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });
  // 内容区尺寸即导出尺寸（不设的话离屏渲染会多出 2px 边框）
  win.setContentSize(SIZE, SIZE);
  win.webContents.setFrameRate(30);

  // 离屏渲染通过 paint 事件交付画面，只保留最后一帧
  let frame = null;
  win.webContents.on("paint", (event, dirty, image) => {
    if (!image.isEmpty()) frame = image;
  });

  await win.loadFile(SVG);
  // SVG 默认按固有尺寸显示，改为铺满整个绘制区域
  await win.webContents.insertCSS(
    "html,body{margin:0;padding:0;background:transparent;overflow:hidden}" +
      "svg{display:block;width:100vw;height:100vh}",
  );
  // 等绘制稳定，避免截到尚未完成的帧
  await new Promise((r) => setTimeout(r, 1200));

  if (!frame) {
    console.error("渲染失败：没有收到任何画面");
    app.exit(1);
  }
  const size = frame.getSize();
  if (size.width !== SIZE || size.height !== SIZE) {
    console.error("尺寸异常：" + size.width + "×" + size.height + "，应为 " + SIZE + "×" + SIZE);
    app.exit(1);
  }
  fs.writeFileSync(OUT, frame.toPNG());
  console.log("已生成 assets/icon.png（" + size.width + "×" + size.height + "，带透明通道）");
  app.exit(0);
});
