import { BrowserWindow, ipcMain, MessageChannelMain, MessagePortMain, sharedTexture } from "electron";
import path from "path";
import { appUrl } from "../appProtocol";
import { randomUUID } from "node:crypto";
import { VideoFile } from "../videoFile";

/**
 * 主进程侧的「编码器窗口」封装。
 *
 * 它创建一个隐藏的普通渲染窗口，加载 app://bundle/encoder/encoder.html，
 * 在其主世界用 mediabunny + WebCodecs 把逐帧 BGRA 画面编码为 H.264 MP4。
 *
 * 主进程通过本类把离屏游戏窗口产出的帧推送给编码器，最终取回已分块写盘的 MP4。
 */
export class EncoderWindow {
	private win: BrowserWindow | null = null;
	private readyResolve: (() => void) | null = null;
	private initedResolve: (() => void) | null = null;
	private doneResolve: ((file: VideoFile) => void) | null = null;
	private videoFile: VideoFile | null = null;
	private writeChannel = "encoder:write:" + randomUUID();
	private closed = false;
	/** 同一视频保持导入顺序，不同编码进程可以同时导入纹理。 */
	private sharedTransfer = Promise.resolve();
	private failed: ((err: Error) => void) | null = null;
	private rejected = false;
	/** 帧专用通道（主进程侧端口）；帧经此 postMessage 投送到编码器主世界。 */
	private framePort: MessagePortMain | null = null;
	private frameSequence = 0;
	private pendingFrames = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

	get bufferedFrames(): number {
		return this.pendingFrames.size;
	}

	/** 编码进度回调（已编码帧数）。 */
	onProgress?: (encodedFrames: number) => void;
	/** 进入「混音 + 封装」收尾阶段的回调（此后无细粒度进度）。 */
	onMux?: () => void;
	/** 编码器渲染进程在任意阶段报错的回调（保证录制中途的错误也能上报、不被吞掉）。 */
	onError?: (err: Error) => void;
	/** 编码器渲染进程日志回调（调试用）。 */
	onLog?: (message: string) => void;

	/** 创建窗口并等待编码器就绪。 */
	async open(): Promise<void> {
		const file = await VideoFile.create();
		if (this.closed) {
			await file.dispose();
			throw new Error("编码器已取消");
		}
		this.videoFile = file;
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
		ipcMain.handle(this.writeChannel, async (event, position: number, data: Uint8Array) => {
			if (!this.win || event.sender !== this.win.webContents || !this.videoFile) throw new Error("视频写入通道已关闭");
			await this.videoFile.write(position, data);
		});

		this.win.webContents.on("console-message", (_e, _l, message) => this.onLog?.("[enc-console] " + message));
		this.win.webContents.on("did-fail-load", (_e, code, desc, url) => this.onLog?.(`[enc-fail] ${code} ${desc} ${url}`));

		ipcMain.on("encoder:to-main", this.onMessage);

		const ready = new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.failed = reject;
		});
		await Promise.all([this.win.loadURL(appUrl("encoder/encoder.html")), ready]);
		void wcId;

		// 建立帧专用通道：把 port2 transfer 给渲染进程（preload 再转入主世界），port1 留在主进程用于投帧。
		const { port1, port2 } = new MessageChannelMain();
		this.framePort = port1;
		this.win.webContents.postMessage("encoder:frame-port", null, [port2]);
		port1.start();
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
			case "frame-done": {
				const pending = this.pendingFrames.get(msg.frameId);
				this.pendingFrames.delete(msg.frameId);
				pending?.resolve();
				break;
			}
			case "mux-start":
				this.onMux?.();
				break;
			case "log":
				this.onLog?.(String(msg.message));
				break;
			case "done":
				if (this.videoFile) {
					const file = this.videoFile;
					void file.finish().then(
						() => {
							if (this.videoFile !== file) return;
							this.videoFile = null;
							this.doneResolve?.(file);
						},
						error => this.reject(error)
					);
				}
				break;
			case "error": {
				const err = new Error(String(msg.message || "编码器错误"));
				// 既上报给整体取消（onError，保证录制中途的错误也能结束流程），也兼容 open/finish 阶段的 reject。
				this.onError?.(err);
				this.reject(err);
				break;
			}
		}
	};

	private reject(err: Error): void {
		for (const pending of this.pendingFrames.values()) pending.reject(err);
		this.pendingFrames.clear();
		if (this.rejected) {
			return;
		}
		this.rejected = true;
		this.failed?.(err);
	}

	/** 初始化编码参数（尺寸、帧率、码率），等待编码器准备好接收帧。 */
	async init(width: number, height: number, fps: number, bitrate?: number, includeAudio = true): Promise<void> {
		const inited = new Promise<void>((resolve, reject) => {
			this.initedResolve = resolve;
			this.failed = reject;
		});
		this.send({ type: "init", width, height, fps, bitrate, includeAudio, writeChannel: this.writeChannel });
		await inited;
	}

	/** 推送一帧 BGRA 画面（来自离屏窗口的 paint 事件），经帧专用端口投送到编码器主世界。 */
	pushFrame(bgra: Buffer, timestampSec: number): Promise<void> {
		return this.submitFrame(frameId => {
			if (!this.framePort) throw new Error("编码器帧通道已关闭");
			this.framePort.postMessage({ bytes: bgra, timestampSec, frameId });
		});
	}

	/** 只传纹理引用；像素不经过主进程的 Buffer 和跨进程位图复制。 */
	pushSharedFrame(texture: Electron.SharedTextureImported, timestampSec: number): Promise<void> {
		return this.submitFrame(frameId => {
			const transfer = this.sharedTransfer.then(async () => {
				if (!this.win || this.win.isDestroyed()) throw new Error("编码器窗口已关闭");
				try {
					await sharedTexture.sendSharedTexture(
						{ frame: this.win.webContents.mainFrame, importedSharedTexture: texture },
						timestampSec,
						frameId
					);
				} catch (error) {
					throw new Error("共享纹理不可用：" + String(error));
				}
			});
			this.sharedTransfer = transfer.catch(() => {});
			return transfer;
		});
	}

	private submitFrame(send: (frameId: number) => void | Promise<void>): Promise<void> {
		const frameId = ++this.frameSequence;
		return new Promise<void>((resolve, reject) => {
			this.pendingFrames.set(frameId, { resolve, reject });
			Promise.resolve()
				.then(() => send(frameId))
				.catch(error => {
					this.pendingFrames.delete(frameId);
					reject(error);
				});
		});
	}

	/**
	 * 传入音频事件与文件，供编码端在 finish 时离线混音为一条 AAC 轨。
	 * @param events 播放事件（含视频时间戳、URL、是否循环）
	 * @param files URL → 原始音频字节
	 * @param totalDurationSec 视频总时长（音频不超过此长度）
	 */
	setAudio(
		events: Array<{ t: number; url: string; loop: boolean; offset?: number; rate?: number }>,
		files: Record<string, Uint8Array>,
		totalDurationSec: number
	): void {
		this.send({ type: "audio-data", events, files, totalDurationSec });
	}

	/** 通知编码结束，等待并返回已完成封装的临时 MP4 文件。 */
	async finish(): Promise<VideoFile> {
		const done = new Promise<VideoFile>((resolve, reject) => {
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
		this.closed = true;
		this.reject(new Error("编码器已关闭"));
		ipcMain.removeHandler(this.writeChannel);
		const file = this.videoFile;
		this.videoFile = null;
		void file?.dispose().catch(error => this.onLog?.("清理临时视频失败：" + String(error)));
		ipcMain.removeListener("encoder:to-main", this.onMessage);
		if (this.framePort) {
			try {
				this.framePort.close();
			} catch {
				/* ignore */
			}
			this.framePort = null;
		}
		if (this.win && !this.win.isDestroyed()) {
			this.win.destroy();
		}
		this.win = null;
	}
}
