import { contextBridge, ipcRenderer } from "electron";

/**
 * 离屏「游戏窗口」的 preload（隔离世界，但把接口暴露到主世界 window）。
 *
 * 注入到游戏页的驱动脚本（在主世界执行）通过 window.__exporter.notify(msg)
 * 把状态（开屏结束、播放开始、进度、播放结束、错误）回报给主进程。
 */
contextBridge.exposeInMainWorld("__exporter", {
	notify: (msg: any) => ipcRenderer.send("offscreen:notify", msg),
});
