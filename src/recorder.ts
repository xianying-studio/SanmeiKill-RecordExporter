import { BrowserWindow, ipcMain } from "electron";
import path from "path";
import { EncoderWindow } from "./encoder/encoderWindow";

/** 录制参数。 */
export interface RecordOptions {
	/** 离屏加载的页面 URL（正式场景为游戏 baseurl）。 */
	url: string;
	/** 注入到页面主世界、驱动播放并回报状态的脚本。 */
	injectScript: string;
	/** 录制画面宽（离屏窗口逻辑尺寸）。 */
	width: number;
	/** 录制画面高。 */
	height: number;
	/** 采样帧率。 */
	fps: number;
	/** 码率（可选，缺省走 mediabunny 的 QUALITY_HIGH）。 */
	bitrate?: number;
	/** 阶段进度回调：stage 为 load/record/encode，percent 0-100。 */
	onStage?: (stage: string, percent: number) => void;
	/** 调试日志回调。 */
	onLog?: (message: string) => void;
	/** 整体超时（毫秒），超时则失败。 */
	timeoutMs?: number;
	/** 取消信号：触发后立即中止录制并清理离屏/编码器窗口。 */
	signal?: AbortSignal;
}

/** 来自注入脚本的回报消息类型。 */
interface NotifyMessage {
	type: string;
	percent?: number;
	message?: string;
}

/**
 * 离屏加载页面、注入驱动脚本播放录像、按墙钟时间戳逐帧编码为 MP4。
 *
 * 帧来源为离屏窗口的 paint 事件（NativeImage / BGRA）。时间戳采用墙钟相对时间，
 * 因此无论 paint 实际节奏如何，最终视频时长都与「原速播放」的真实时长一致。
 *
 * @returns 编码完成的 MP4 字节
 */
export function recordOffscreen(opts: RecordOptions): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const encoder = new EncoderWindow();
		encoder.onProgress = frames => opts.onLog?.(`encoded ${frames} frames`);
		encoder.onLog = m => opts.onLog?.("[encoder] " + m);

		let offscreen: BrowserWindow | null = null;
		let settled = false;
		let capturing = false;
		let inited = false;
		let initing = false;
		let startTime = 0;
		let frameCount = 0;
		let timer: NodeJS.Timeout | null = null;

		const cleanup = () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			opts.signal?.removeEventListener("abort", onAbort);
			ipcMain.removeListener("offscreen:notify", onNotify);
			if (offscreen && !offscreen.isDestroyed()) {
				offscreen.destroy();
			}
			offscreen = null;
			encoder.close();
		};

		const fail = (err: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(err);
		};

		const onAbort = () => fail(new Error("已取消：WebSocket 连接已断开"));

		const succeed = (buf: Buffer) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve(buf);
		};

		const onNotify = (event: Electron.IpcMainEvent, msg: NotifyMessage) => {
			if (!offscreen || event.sender !== offscreen.webContents) {
				return;
			}
			switch (msg?.type) {
				case "splash-done":
					opts.onStage?.("load", 100);
					break;
				case "recording-start":
					capturing = true;
					opts.onStage?.("record", 0);
					break;
				case "progress":
					opts.onStage?.("record", typeof msg.percent === "number" ? msg.percent : 0);
					break;
				case "over":
					capturing = false;
					finishEncoding();
					break;
				case "error":
					fail(new Error("注入脚本错误：" + (msg.message || "未知")));
					break;
			}
		};

		const finishEncoding = () => {
			opts.onStage?.("encode", 0);
			encoder
				.finish()
				.then(buf => succeed(buf))
				.catch(err => fail(err instanceof Error ? err : new Error(String(err))));
		};

		const onPaint = (_e: Electron.Event, _dirty: Electron.Rectangle, image: Electron.NativeImage) => {
			if (!capturing || settled) {
				return;
			}
			const size = image.getSize();
			if (size.width === 0 || size.height === 0) {
				return;
			}
			if (!inited) {
				if (initing) {
					return;
				}
				initing = true;
				startTime = Date.now();
				encoder
					.init(size.width, size.height, opts.fps, opts.bitrate)
					.then(() => {
						inited = true;
					})
					.catch(err => fail(err instanceof Error ? err : new Error(String(err))));
				return;
			}
			const ts = (Date.now() - startTime) / 1000;
			encoder.pushFrame(image.getBitmap(), ts);
			frameCount++;
		};

		ipcMain.on("offscreen:notify", onNotify);

		if (opts.signal) {
			if (opts.signal.aborted) {
				fail(new Error("已取消：WebSocket 连接已断开"));
				return;
			}
			opts.signal.addEventListener("abort", onAbort);
		}

		const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
		timer = setTimeout(() => fail(new Error("录制超时")), timeoutMs);

		encoder
			.open()
			.then(() => {
				offscreen = new BrowserWindow({
					show: false,
					width: opts.width,
					height: opts.height,
					webPreferences: {
						offscreen: true,
						preload: path.join(__dirname, "offscreen", "preload.js"),
						contextIsolation: true,
						nodeIntegration: false,
						backgroundThrottling: false,
					},
				});
				offscreen.webContents.setFrameRate(opts.fps);
				offscreen.webContents.on("paint", onPaint);
				offscreen.webContents.on("render-process-gone", (_e, details) => fail(new Error("离屏渲染进程退出：" + details.reason)));
				opts.onStage?.("load", 0);
				offscreen.webContents.on("did-finish-load", () => {
					offscreen?.webContents.executeJavaScript(opts.injectScript).catch(err => fail(err instanceof Error ? err : new Error(String(err))));
				});
				return offscreen.loadURL(opts.url);
			})
			.catch(err => fail(err instanceof Error ? err : new Error(String(err))));
	});
}
