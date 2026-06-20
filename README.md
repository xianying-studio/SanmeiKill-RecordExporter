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
