# 三梅杀录像导出工具（SanmeiKill Record Exporter）

被网页端《三梅杀》通过 `sanmeikillrecordexporter://` 协议拉起的独立桌面工具，用于在**后台离屏**把录像录制并导出为 **MP4** 视频。支持 **Windows / macOS**。

## 工作方式

1. 网页端点击录像「存」→「导出为视频（通用）」时，拉起
   `sanmeikillrecordexporter://<base64({ baseurl, listenport })>`。
2. 本工具解析 payload，在 `127.0.0.1:<listenport>` 启动本地 WebSocket 服务
   （仅允许 `baseurl` 来源连接）。
3. 弹出系统保存对话框，选择导出路径与文件名。
4. 离屏（offscreen，无可见界面）加载 `baseurl` 的游戏 → 过开屏加载 → 进入录像界面
   → 经 WebSocket 接收录像数据 → 原速播放 → 截帧编码为 H.264 → 封装为 MP4 写入磁盘。
5. 全程通过 WebSocket 向网页端实时汇报进度。

## 说明

- 本工具**仅供协议拉起使用**；直接双击打开会提示「请通过三梅杀唤起」并退出。
- 安装时不创建桌面/开始菜单快捷方式。

## 开发

```bash
pnpm install
pnpm start          # 编译 TS 并以 electron 运行
pnpm dist:win       # 打包 Windows 安装包
pnpm dist:mac       # 打包 macOS 安装包
pnpm lint
```

## 实现要点

- **离屏录制**：用 `BrowserWindow({ show:false, webPreferences:{ offscreen:true } })` 加载游戏，
  通过 `webContents` 的 `paint` 事件取帧（BGRA）。
- **跳过开屏并暴露全局**：游戏在生产模式下不暴露 `lib/game/_status`，且初始化会停在开屏等待
  用户选择模式。本工具注入脚本通过向 IndexedDB 写入录像记录、`dev=true` 与 `mode`，并设置
  `localStorage[noname_0.9_playback]`，使游戏初始化时直接进入录像播放、跳过开屏，同时由 `dev`
  触发 `cheat.i()` 暴露全局，再原速播放。
- **MP4 编码**：单独的隐藏「编码器」窗口经自定义 `app://` 协议加载 `mediabunny` 的 ESM bundle
  （`file://` 下 `.mjs` 的 MIME 不被识别为模块，故必须用自定义协议），用 `CanvasSource`（H.264/avc）
  + `Mp4OutputFormat` 编码逐帧画面并封装为 MP4。

## 待补（发布前）

- **应用图标**：当前使用 Electron 默认图标。发布前请在 `assets/` 放置 `icon.ico`（Windows）与
  `icon.icns`（macOS），并在 `package.json` 的 `build.win.icon` / `build.mac.icon` 指回。
- **下载页地址**：网页端 `videoExport.js` 的 `DOWNLOAD_URL` 仍为占位，需替换为本工具的真实下载页。

