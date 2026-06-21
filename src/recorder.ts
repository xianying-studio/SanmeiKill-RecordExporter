import { BrowserWindow, ipcMain } from "electron";
import path from "path";
import { EncoderWindow } from "./encoder/encoderWindow";
import { dlog } from "./debugLog";

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
	ch0?: Float32Array;
	ch1?: Float32Array;
	frames?: number;
}

/** WebSocket 断开时的取消原因（中止录制并清理后台残留窗口）。 */
const ABORT_REASON = "已取消：WebSocket 连接已断开";

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

		const onAbort = () => fail(new Error(ABORT_REASON));

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
			if (msg?.type === "debug") {
				dlog("[离屏]", msg.message || "");
				return;
			}
			if (msg?.type === "audio") {
				if (msg.ch0 && msg.ch1 && msg.frames) {
					encoder.pushAudio(msg.ch0, msg.ch1, msg.frames);
				}
				return;
			}
			dlog("notify <-", msg?.type, msg?.percent !== undefined ? msg.percent : "", msg?.message || "");
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
				fail(new Error(ABORT_REASON));
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
				// 静音离屏窗口：录制为纯画面，游戏 BGM/音效不应外放打扰用户。
				// setAudioMuted 仅静音本 webContents，不影响系统其他声音，也不影响截帧。
				offscreen.webContents.setAudioMuted(true);
				offscreen.webContents.on("paint", onPaint);
				offscreen.webContents.on("render-process-gone", (_e, details) => {
					dlog("离屏渲染进程退出:", details.reason, details.exitCode);
					fail(new Error("离屏渲染进程退出：" + details.reason));
				});
				offscreen.webContents.on("unresponsive", () => dlog("离屏窗口无响应(可能被同步 alert 阻塞)"));
				offscreen.webContents.on("console-message", (_e, level, message, line, sourceId) => {
					dlog(`[页面console l${level}] ${message} @${sourceId}:${line}`);
				});
				offscreen.webContents.on("did-fail-load", (_e, code, desc, url) => dlog(`[页面 did-fail-load] ${code} ${desc} ${url}`));
				offscreen.webContents.on("did-start-navigation", (_e, url, _ih, isMain) => {
					if (isMain) {
						dlog("离屏导航:", url);
					}
				});
				opts.onStage?.("load", 0);
				offscreen.webContents.on("did-finish-load", () => {
					dlog("离屏 did-finish-load, 注入诊断+驱动脚本");
					// 先注入诊断脚本：拦截会永久阻塞离屏渲染器的同步 alert/confirm/prompt，
					// 捕获 window.onerror，并周期性回报 _status 关键状态用于排障。
					offscreen?.webContents
						.executeJavaScript(buildDiagnosticsScript())
						.then(() => offscreen?.webContents.executeJavaScript(opts.injectScript))
						.catch(err => fail(err instanceof Error ? err : new Error(String(err))));
				});
				return offscreen.loadURL(opts.url);
			})
			.catch(err => fail(err instanceof Error ? err : new Error(String(err))));
	});
}

/**
 * 离屏页诊断脚本：在游戏脚本执行前注入到主世界。
 *
 * 目的（均为排查「卡在 100%」类问题）：
 * 1. 拦截 alert/confirm/prompt —— 这些同步对话在不可见离屏渲染器中会永久阻塞 JS 主线程，
 *    表现就是「卡住不动」。改为经 __exporter.notify 上报，绝不阻塞。
 * 2. 捕获 window.onerror / unhandledrejection，上报错误信息。
 * 3. 每秒回报一次 _status 关键状态（是否暴露全局、是否进入播放、事件链概况），
 *    据此判断到底卡在「全局未暴露」还是「未进入播放」还是「播放未结束」。
 */
function buildDiagnosticsScript(): string {
	function body(): void {
		const w = window as any;
		const notify = (m: any) => {
			try {
				w.__exporter && w.__exporter.notify(m);
			} catch {
				/* ignore */
			}
		};
		const report = (message: string) => notify({ type: "debug", message });

		// 1. 拦截同步对话框（离屏阻塞元凶）。
		try {
			w.alert = (msg: any) => report("拦截 alert: " + String(msg));
			w.confirm = (msg: any) => {
				report("拦截 confirm: " + String(msg));
				return true;
			};
			w.prompt = (msg: any) => {
				report("拦截 prompt: " + String(msg));
				return null;
			};
		} catch {
			/* ignore */
		}

		// 2. 错误捕获。
		w.addEventListener("error", (e: any) => {
			report("window error: " + (e && e.message ? e.message : String(e)) + " @" + (e && e.filename) + ":" + (e && e.lineno));
		});
		w.addEventListener("unhandledrejection", (e: any) => {
			let r: any = e && e.reason;
			report("unhandledrejection: " + (r && r.message ? r.message : String(r)));
		});

		// 3. 状态心跳：每秒回报一次，便于定位卡点。
		let ticks = 0;
		const iv = setInterval(() => {
			ticks++;
			const s = w._status;
			const info: any = {
				t: ticks,
				hasStatus: !!s,
				hasGame: !!w.game,
				hasLib: !!w.lib,
				inSplash: !!w.inSplash,
			};
			if (s) {
				info.video = !!s.video;
				info.over = !!s.over;
				info.paused = !!s.paused;
				info.hasEvent = !!s.event;
				info.eventName = s.event && s.event.name;
			}
			report("heartbeat " + JSON.stringify(info));
			if (ticks >= 60) {
				clearInterval(iv);
			}
		}, 1000);
	}
	return `(${body.toString()})();`;
}
