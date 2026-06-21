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
	/** 采样帧率（离屏 paint 的 setFrameRate；倍速下应尽量高，Electron offscreen 上限 240）。 */
	fps: number;
	/** 录制倍速：游戏以此倍速回放，帧/音频时间戳 ×speed 还原为正常速度。默认 1。 */
	speed?: number;
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
	url?: string;
	loop?: boolean;
	data?: Uint8Array;
}

/** 一条音频播放事件（视频时间戳由 recorder 端统一时钟打戳）。 */
interface AudioEvent {
	/** 视频时间（秒，已 ×speed 还原）。 */
	t: number;
	/** 音频文件 URL（与 audioFiles 的 key 对应）。 */
	url: string;
	/** 是否循环（BGM 为 true）。 */
	loop: boolean;
}

/** WebSocket 断开时的取消原因（中止录制并清理后台残留窗口）。 */
const ABORT_REASON = "已取消：WebSocket 连接已断开";

/**
 * 离屏加载页面、注入驱动脚本播放录像、按墙钟时间戳逐帧编码为 MP4。
 *
 * 帧来源为离屏窗口的 paint 事件（NativeImage / BGRA）。时间戳采用「墙钟相对时间 × speed」：
 * 游戏以 speed 倍速回放（真实耗时缩短为 1/speed），帧时间戳 ×speed 后还原为正常速度的视频。
 * 音频不实时采集 PCM（倍速会变调），而是收集「播放事件 + 文件」，由编码端离线混音定位到正确时间。
 *
 * @returns 编码完成的 MP4 字节
 */
export function recordOffscreen(opts: RecordOptions): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const speed = opts.speed && opts.speed >= 1 ? opts.speed : 1;
		// 时间戳按真实墙钟（不做 ×speed 还原）：游戏只压缩了「等待」、动画保持自然速度，
		// 故录制墙钟时间本身即为正确的视频时间线。speed 仅由注入脚本用于压缩等待，与时间戳无关。
		void speed;
		// 视频名义帧率 = 采集帧率（时间戳即真实墙钟时间；此值仅作容器帧率/帧时长提示）。
		const effectiveFps = Math.max(1, Math.round(opts.fps));
		const encoder = new EncoderWindow();
		encoder.onLog = m => opts.onLog?.("[encoder] " + m);

		let offscreen: BrowserWindow | null = null;
		let settled = false;
		let capturing = false;
		let inited = false;
		let initing = false;
		let encoding = false; // 是否进入编码收尾阶段（录制结束后排空帧队列 + 混音 + 封装）
		let startTime = 0; // recording-start 收到时的墙钟基准（ms）
		let frameCount = 0;
		let timer: NodeJS.Timeout | null = null;
		let repaintTimer: NodeJS.Timeout | null = null;

		// 以采集帧率周期性强制离屏窗口整屏重绘，使每帧都把完整画面（含静止的牌桌/角色/手牌）刷进 paint 位图。
		const startRepaintPump = () => {
			if (repaintTimer) {
				return;
			}
			const interval = Math.max(4, Math.round(1000 / Math.max(1, opts.fps)));
			repaintTimer = setInterval(() => {
				if (offscreen && !offscreen.isDestroyed() && capturing) {
					try {
						offscreen.webContents.invalidate();
					} catch {
						/* ignore */
					}
				}
			}, interval);
		};

		// 音频事件 + 文件（录制结束时一并交给编码端离线混音）。
		const audioEvents: AudioEvent[] = [];
		const audioFiles: Record<string, Uint8Array> = {};
		let lastVideoTs = 0; // 最近一帧的视频时间戳，作为音频总时长上界

		// 编码进度：录制阶段帧边采边编，此回调在录制中也会触发（此时仅记日志）；
		// 进入编码收尾阶段后，用「已编码帧 / 总帧数」换算为 encode 阶段百分比上报，驱动进度条。
		encoder.onProgress = frames => {
			opts.onLog?.(`encoded ${frames} frames`);
			if (encoding && frameCount > 0) {
				const pct = Math.min(99, Math.round((frames / frameCount) * 100));
				opts.onStage?.("encode", pct);
			}
		};
		// 进入「混音 + 封装」收尾阶段：无细粒度进度，钉在 99% 表示仍在收尾（避免长时间停在某个中间值像卡死）。
		encoder.onMux = () => opts.onStage?.("encode", 99);

		const cleanup = () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (repaintTimer) {
				clearInterval(repaintTimer);
				repaintTimer = null;
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

		// 编码器任意阶段报错（含录制中途）：记录并结束流程，避免被吞掉导致静默卡死。
		encoder.onError = err => {
			dlog("编码器报错:", err && err.message ? err.message : String(err));
			fail(err instanceof Error ? err : new Error(String(err)));
		};

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
			// 收集音频文件原始字节（按 URL 去重，离屏端已去重，这里再兜底）。
			if (msg?.type === "audio-file") {
				if (msg.url && msg.data) {
					audioFiles[msg.url] = msg.data;
				}
				return;
			}
			// 收集音频播放事件：用 recorder 统一时钟打戳（真实墙钟时间），与帧同源。
			if (msg?.type === "audio-event") {
				if (msg.url && startTime > 0) {
					const t = Math.max(0, (Date.now() - startTime) / 1000);
					audioEvents.push({ t, url: msg.url, loop: !!msg.loop });
					dlog("audio-event t=", t.toFixed(2), "loop=", !!msg.loop, "url=", String(msg.url).slice(-48));
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
					// 统一时钟基准：帧与音频事件都以此刻为 0。
					startTime = Date.now();
					opts.onStage?.("record", 0);
					// 启动「强制全屏重绘」泵：Electron 离屏渲染默认只把「脏矩形」刷进 paint 位图，
					// 静止时牌桌/角色/手牌区域不被重绘 → 捕获帧里只剩背景与刚变化的 UI（角色像「消失」），
					// 唯有觉醒等全屏特效强制整屏重绘时才完整出现。周期性 invalidate() 强制每帧整屏重绘，根治该问题。
					startRepaintPump();
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
			encoding = true;
			opts.onStage?.("encode", 0);
			// 先补齐仅有 URL（HTTP）但离屏端未送来字节的音频文件，再做离线混音。
			void prepareAudioAndFinish();
		};

		// 拉取所有事件引用但尚无字节的音频文件（HTTP 同源由离屏 fetch；此处兜底拉取漏网的）。
		// 注意：blob: URL 仅在渲染进程作用域内有效，主进程无法 fetch，必须跳过；
		// 且每个 fetch 加超时，避免任一请求挂起拖死整个收尾流程（历史卡死点）。
		const prepareAudioAndFinish = async () => {
			try {
				const needed = new Set<string>();
				for (const ev of audioEvents) {
					if (!audioFiles[ev.url] && !ev.url.startsWith("blob:")) {
						needed.add(ev.url);
					}
				}
				dlog("收尾：待补拉音频文件数=", needed.size, "已有=", Object.keys(audioFiles).length, "事件数=", audioEvents.length);
				for (const url of needed) {
					try {
						const ctrl = new AbortController();
						const to = setTimeout(() => ctrl.abort(), 5000);
						const res = await fetch(url, { signal: ctrl.signal });
						const ab = await res.arrayBuffer();
						clearTimeout(to);
						audioFiles[url] = new Uint8Array(ab);
					} catch (e) {
						dlog("主进程拉取音频失败(跳过):", url, String(e));
					}
				}
				// 总时长用最后一帧时间戳（音频不应超过视频长度）。
				dlog("收尾：交付音频给编码器并 finish，视频时长=", lastVideoTs.toFixed(2), "s，总帧=", frameCount);
				encoder.setAudio(audioEvents, audioFiles, lastVideoTs);
			} catch (e) {
				dlog("准备音频失败:", String(e));
			}
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
				encoder
					.init(size.width, size.height, effectiveFps, opts.bitrate)
					.then(() => {
						inited = true;
					})
					.catch(err => fail(err instanceof Error ? err : new Error(String(err))));
				return;
			}
			// 时间戳：真实墙钟相对 recording-start（秒）。游戏只压缩等待、动画自然速度，故墙钟即正确视频时间线。
			const ts = (Date.now() - startTime) / 1000;
			lastVideoTs = ts;
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

		// 拒绝任务超时，防止导出到一半被中断
		// const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
		// timer = setTimeout(() => fail(new Error("录制超时")), timeoutMs);

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
			// 诊断「8人身份局角色/手牌不显示」：上报玩家节点的真实运行时状态，
			// 据此区分「节点不存在 / 在视口外 / 透明不可见 / 存在且可见(则为 paint 丢层)」。
			try {
				const players = document.querySelectorAll("#arena .player");
				info.playerCount = players.length;
				const arena = document.querySelector("#arena") as HTMLElement | null;
				if (arena) {
					const ar = arena.getBoundingClientRect();
					const acs = getComputedStyle(arena);
					info.arena = {
						rect: [Math.round(ar.left), Math.round(ar.top), Math.round(ar.width), Math.round(ar.height)],
						transform: acs.transform,
						opacity: acs.opacity,
						display: acs.display,
						filter: acs.filter,
					};
				}
				const p0 = players[0] as HTMLElement | undefined;
				if (p0) {
					const r = p0.getBoundingClientRect();
					const cs = getComputedStyle(p0);
					info.player0 = {
						rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
						inViewport: r.left < window.innerWidth && r.top < window.innerHeight && r.right > 0 && r.bottom > 0,
						opacity: cs.opacity,
						visibility: cs.visibility,
						display: cs.display,
						transform: cs.transform,
						willChange: cs.willChange,
						zIndex: cs.zIndex,
					};
				}
			} catch (err) {
				info.probeErr = String(err);
			}
			report("heartbeat " + JSON.stringify(info));
			if (ticks >= 600) {
				clearInterval(iv);
			}
		}, 1000);
	}
	return `(${body.toString()})();`;
}
