import { BrowserWindow, ipcMain } from "electron";
import path from "path";
import { appUrl } from "../appProtocol";

/**
 * 主进程侧的「编码器窗口」封装。
 *
 * 它创建一个隐藏的普通渲染窗口，加载 app://bundle/encoder/encoder.html，
 * 在其主世界用 mediabunny + WebCodecs 把逐帧 BGRA 画面编码为 H.264 MP4。
 *
 * 主进程通过本类把离屏游戏窗口产出的帧推送给编码器，最终取回 MP4 字节。
 */
export class EncoderWindow {
	private win: BrowserWindow | null = null;
	private readyResolve: (() => void) | null = null;
	private initedResolve: (() => void) | null = null;
	private doneResolve: ((buf: Buffer) => void) | null = null;
	private failed: ((err: Error) => void) | null = null;
	private rejected = false;

	/** 编码进度回调（已编码帧数）。 */
	onProgress?: (encodedFrames: number) => void;
	/** 编码器渲染进程日志回调（调试用）。 */
	onLog?: (message: string) => void;

	/** 创建窗口并等待编码器就绪。 */
	async open(): Promise<void> {
		this.win = new BrowserWindow({
			show: false,
			webPreferences: {
				preload: path.join(__dirname, "preload.js"),
				contextIsolation: true,
				nodeIntegration: false,
				backgroundThrottling: false,
			},
		});
		const wcId = this.win.webContents.id;

		this.win.webContents.on("console-message", (_e, _l, message) => this.onLog?.("[enc-console] " + message));
		this.win.webContents.on("did-fail-load", (_e, code, desc, url) => this.onLog?.(`[enc-fail] ${code} ${desc} ${url}`));

		ipcMain.on("encoder:to-main", this.onMessage);

		const ready = new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.failed = reject;
		});
		await this.win.loadURL(appUrl("encoder/encoder.html"));
		void wcId;
		await ready;
	}

	private onMessage = (event: Electron.IpcMainEvent, msg: any): void => {
		if (!this.win || event.sender !== this.win.webContents) {
			return;
		}
		switch (msg?.type) {
			case "ready":
				this.readyResolve?.();
				break;
			case "inited":
				this.initedResolve?.();
				break;
			case "progress":
				this.onProgress?.(msg.encodedFrames || 0);
				break;
			case "log":
				this.onLog?.(String(msg.message));
				break;
			case "done":
				this.doneResolve?.(Buffer.from(msg.buffer));
				break;
			case "error":
				this.reject(new Error(String(msg.message || "编码器错误")));
				break;
		}
	};

	private reject(err: Error): void {
		if (this.rejected) {
			return;
		}
		this.rejected = true;
		this.failed?.(err);
	}

	/** 初始化编码参数（尺寸、帧率、码率），等待编码器准备好接收帧。 */
	async init(width: number, height: number, fps: number, bitrate?: number): Promise<void> {
		const inited = new Promise<void>(resolve => {
			this.initedResolve = resolve;
		});
		this.send({ type: "init", width, height, fps, bitrate });
		await inited;
	}

	/** 推送一帧 BGRA 画面（来自离屏窗口的 paint 事件）。 */
	pushFrame(bgra: Buffer, timestampSec: number): void {
		this.send({ type: "frame", buffer: bgra, timestampSec });
	}

	/** 推送一块 PCM 音频（来自离屏窗口的 Web Audio 采集）。 */
	pushAudio(ch0: Float32Array, ch1: Float32Array, frames: number): void {
		this.send({ type: "audio", ch0, ch1, frames });
	}

	/** 通知编码结束，等待并返回最终 MP4 字节。 */
	async finish(): Promise<Buffer> {
		const done = new Promise<Buffer>((resolve, reject) => {
			this.doneResolve = resolve;
			this.failed = reject;
		});
		this.send({ type: "finish" });
		return done;
	}

	private send(msg: any): void {
		if (this.win && !this.win.isDestroyed()) {
			this.win.webContents.send("encoder:from-main", msg);
		}
	}

	/** 销毁窗口并解绑监听。 */
	close(): void {
		ipcMain.removeListener("encoder:to-main", this.onMessage);
		if (this.win && !this.win.isDestroyed()) {
			this.win.destroy();
		}
		this.win = null;
	}
}
