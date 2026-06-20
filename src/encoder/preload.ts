import { contextBridge, ipcRenderer } from "electron";

/**
 * 「编码器」渲染窗口的 preload（隔离世界）。
 *
 * 职责：仅做主进程与页面主世界之间的消息桥接，不参与编码本身（编码在主世界 module 中用
 * mediabunny + WebCodecs 完成，这样可经 app:// 协议正常 import ESM bundle）。
 */

contextBridge.exposeInMainWorld("encoderBridge", {
	/** 注册来自主进程的消息回调。 */
	onMessage: (cb: (msg: any) => void) => {
		ipcRenderer.on("encoder:from-main", (_e, msg) => cb(msg));
	},
	/** 向主进程发送消息（如编码完成的 MP4 字节、进度、错误）。 */
	send: (msg: any) => ipcRenderer.send("encoder:to-main", msg),
});
