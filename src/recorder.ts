import { BrowserWindow, ipcMain, session } from "electron";
import { randomUUID } from "node:crypto";
import path from "path";
import { EncoderWindow } from "./encoder/encoderWindow";
import { dlog } from "./debugLog";
import { CapturedFrame } from "./capturedFrame";
import type { GamePackage } from "./gamePackage";
import { buildReplayClockScript } from "./replayClock";
import type { VideoFile } from "./videoFile";

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
	/** 成片帧率；逐帧模式按此帧率推进视频时间，实时模式按此帧率采样。 */
	fps: number;
	/** 等待压缩系数：仅供注入脚本使用，用于压缩回放中的各类「等待」。不影响帧/音频时间戳；默认 1。 */
	speed?: number;
	/** 码率（可选，缺省走 mediabunny 的 QUALITY_HIGH）。 */
	bitrate?: number;
	/** 阶段进度回调：stage 为 cache/load/record/encode，percent 0-100。 */
	onStage?: (stage: string, percent: number) => void;
	/** 调试日志回调。 */
	onLog?: (message: string) => void;
	/** 整体超时（毫秒），超时则失败。 */
	timeoutMs?: number;
	/** 取消信号：触发后立即中止录制并清理离屏/编码器窗口。 */
	signal?: AbortSignal;
	/** auto 优先使用 Windows/macOS 的 GPU 共享纹理；bitmap 保留兼容路径。 */
	frameTransport?: "auto" | "shared-texture" | "bitmap";
	gamePackage?: GamePackage;
	renderMode?: "realtime" | "frame";
}

/** 来自注入脚本的回报消息类型。 */
interface NotifyMessage {
	type: string;
	percent?: number;
	message?: string;
	url?: string;
	loop?: boolean;
	data?: Uint8Array;
	time?: number;
}

/** 一条音频播放事件（视频时间戳由 recorder 端统一时钟打戳）。 */
interface AudioEvent {
	/** 视频时间（秒，真实墙钟相对 recording-start）。 */
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
 * 帧来源为离屏窗口的 paint 事件（NativeImage / BGRA）。时间戳采用「recording-start 后的真实墙钟相对时间」：
 * 注入脚本可用 speed 压缩回放中的各类「等待」，但 recorder 端不对时间戳做倍速换算。
 * 音频不实时采集 PCM（倍速会变调），而是收集「播放事件 + 文件」，由编码端离线混音定位到正确时间。
 *
 * @returns 编码完成的 MP4 字节
 */
export async function recordOffscreen(opts: RecordOptions): Promise<Buffer> {
	const file = await renderToTemporaryFile(opts);
	try {
		return await file.read();
	} finally {
		await file.dispose();
	}
}

/** 正式导出直接保存磁盘上的封装结果，避免跨进程复制数 GB 的视频。 */
export async function recordOffscreenToFile(opts: RecordOptions, destination: string): Promise<number> {
	const file = await renderToTemporaryFile(opts);
	try {
		opts.signal?.throwIfAborted();
		await file.copyTo(destination);
		return file.bytes;
	} finally {
		await file.dispose();
	}
}

async function renderToTemporaryFile(opts: RecordOptions): Promise<VideoFile> {
	try {
		return await recordAttempt(opts);
	} catch (error) {
		if (opts.frameTransport && opts.frameTransport !== "auto") throw error;
		if (!(error instanceof Error) || !error.message.startsWith("共享纹理不可用：")) throw error;
		opts.onLog?.(`${error.message}；切换位图兼容模式`);
		return recordAttempt({ ...opts, frameTransport: "bitmap" });
	}
}

function recordAttempt(opts: RecordOptions): Promise<VideoFile> {
	return new Promise<VideoFile>((resolve, reject) => {
		const useSharedTexture = opts.frameTransport !== "bitmap" && (process.platform === "win32" || process.platform === "darwin");
		const pendingFrames = new Set<Promise<void>>();
		const replaySession = opts.gamePackage ? session.fromPartition("replay-export-" + randomUUID()) : undefined;
		if (replaySession && opts.gamePackage) {
			const origin = new URL(opts.url).origin;
			for (const scheme of ["http", "https"])
				replaySession.protocol.handle(scheme, request => {
					if (new URL(request.url).origin !== origin) return new Response("导出包体不允许外部网络请求", { status: 403 });
					return opts.gamePackage!.response(request);
				});
		}
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
		let lastPaintAt = 0; // 最近一次 paint 的墙钟时刻（ms），供补帧泵判断是否需要补帧
		let outputTimer: NodeJS.Timeout | null = null;
		let manualRunning = false;
		const manual = opts.renderMode === "frame";

		// —— CFR 输出泵：把「抖动/漏帧的 paint 采集节奏」与「恒定的视频帧率」彻底解耦 ——
		// 背景：Electron 离屏渲染（OSR）的 paint 事件节奏不可控（macOS 上 GPU→CPU 回读开销大，
		// 密集动画时 paint 间隔被拉长且剧烈抖动）。此前直接用「每个 paint 的墙钟时间」当帧时间戳、
		// 却把 duration 写死成 1/fps，二者不自洽 → 视频时间轴出现空洞/倒挂 → 播放卡顿、忽快忽慢。
		// 现在 paint 只更新「最近一帧」缓存，由本泵以固定 1/fps 节奏，把最近帧量化到严格均匀的
		// idx×(1/fps) 时间网格上产帧（hold-last-frame，OBS/录屏软件的标准做法）：
		// 采集再抖、再漏，输出始终是严格 CFR，且时间戳与 duration 完全一致。
		let latestFrame: CapturedFrame | null = null;
		let outIdx = 0; // 下一个待产出的 CFR 帧序号（时间戳 = outIdx / fps）
		let outStarted = false; // 是否已对齐首帧网格（首次产帧时按墙钟对齐，避免开场补一串重复帧）
		// 诊断计数：每秒比对「真实 paint/s」与「产出 output/s」，区分 macOS 上是采集漏帧还是时间轴抖动。
		let paintCount = 0;
		let lastDiagMs = 0;
		let lastDiagPaint = 0;
		let lastDiagOut = 0;

		// 单次泵 tick 最多补产的帧数上界：防御 startTime 异常或长时间挂起导致一次性灌入海量重复帧。
		const MAX_CATCHUP = effectiveFps * 2;

		const startOutputPump = () => {
			if (outputTimer) {
				return;
			}
			const slotMs = Math.max(4, Math.round(1000 / effectiveFps));
			outputTimer = setInterval(() => {
				if (!capturing || settled || !inited || !latestFrame) {
					return;
				}
				const targetIdx = Math.floor(((Date.now() - startTime) / 1000) * effectiveFps);
				if (!outStarted) {
					// 首帧：把输出序号对齐到当前墙钟槽位（首帧可能晚于 recording-start 才到达），
					// 使首帧时间戳 ≈ 真实墙钟时间，与音频事件（同样以 startTime 为零点打戳）保持音画同步。
					outIdx = Math.max(0, targetIdx);
					outStarted = true;
				}
				// 追平到目标网格：泵 tick 本身可能被延迟，这里把缺口用「最近帧」补满，确保严格 CFR 无空洞。
				let budget = MAX_CATCHUP;
				while (outIdx <= targetIdx && budget-- > 0) {
					if (!emitOutputFrame()) break;
					outIdx++;
				}
				if (budget <= 0 && outIdx <= targetIdx) {
					// 触达单 tick 上界：跳过积压的缺口并重置序号，避免雪崩式补帧（仅异常路径）。
					dlog("CFR 泵补帧超上界，跳过缺口:", targetIdx - outIdx, "帧");
					outIdx = targetIdx + 1;
				}
				// 诊断心跳：每秒一次。
				const now = Date.now();
				if (now - lastDiagMs >= 1000) {
					const dp = paintCount - lastDiagPaint;
					const dout = frameCount - lastDiagOut;
					dlog("CFR 诊断: paint/s=", dp, "output/s=", dout, "(目标", effectiveFps, ")");
					lastDiagMs = now;
					lastDiagPaint = paintCount;
					lastDiagOut = frameCount;
				}
			}, slotMs);
		};

		// 以当前「最近一帧」缓存产出一帧，时间戳严格落在 outIdx/fps 的均匀网格上。
		const emitOutputFrame = () => {
			if (!latestFrame || encoder.bufferedFrames >= 4) {
				return false;
			}
			const ts = outIdx / effectiveFps;
			lastVideoTs = ts;
			const pending = latestFrame.send(encoder, ts);
			pendingFrames.add(pending);
			void pending.catch(error => fail(error)).finally(() => pendingFrames.delete(pending));
			frameCount++;
			return true;
		};

		const startManualLoop = async () => {
			if (!manual || manualRunning || !capturing || !inited || !latestFrame) return;
			manualRunning = true;
			try {
				for (let index = 0; !settled; index++) {
					if (!offscreen || offscreen.isDestroyed()) return;
					const timestamp = index / effectiveFps;
					await offscreen.webContents.executeJavaScript(`window.__replayClock.advance(${timestamp * 1000})`);
					await new Promise<void>(resolve => setImmediate(resolve));
					if (settled || !latestFrame) return;
					lastVideoTs = timestamp;
					// 最多两帧在途，允许编码上一帧时合成下一帧，同时限制 GPU 纹理占用。
					const pending = latestFrame.send(encoder, timestamp);
					pendingFrames.add(pending);
					void pending.then(
						() => pendingFrames.delete(pending),
						error => {
							pendingFrames.delete(pending);
							fail(error);
						}
					);
					frameCount++;
					if (pendingFrames.size >= 2) await Promise.race(pendingFrames);
					if (!capturing) break;
				}
				if (!settled) finishEncoding();
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		};

		// 「补帧泵」：Electron 离屏渲染默认只在脏矩形变化时出 paint，静止画面（牌桌/角色/手牌不动）
		// 不会出帧，编码器会缺帧。故周期性检查——仅当「距上一帧已超过一个采集周期」时才 invalidate() 补一帧。
		//
		// 关键：早期实现是「无条件每周期 invalidate」，在动画进行中（游戏自身已按 60fps 出 paint）会与之叠加，
		// 把出帧率推到 ~100+fps（实测日志 38562 帧 / 383.59s ≈ 100fps），每多一帧就多一次 GPU→CPU 位图回读；
		// 密集全屏特效（GPU 已接近单帧预算上限）时，这些翻倍的 readback 与游戏渲染争抢资源，加重偶发掉帧。
		// 改为「仅在出现间隙时补帧」后，动画段不再翻倍出帧，静止段照常补满，readback 开销回落到名义帧率。
		const startRepaintPump = () => {
			if (repaintTimer) {
				return;
			}
			const interval = Math.max(4, Math.round(1000 / Math.max(1, opts.fps)));
			repaintTimer = setInterval(() => {
				if (offscreen && !offscreen.isDestroyed() && capturing) {
					// 距上一帧不足一个采集周期，说明游戏自身正在出帧，无需补帧（避免叠加导致 readback 翻倍）。
					if (Date.now() - lastPaintAt < interval) {
						return;
					}
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
			if (outputTimer) {
				clearInterval(outputTimer);
				outputTimer = null;
			}
			latestFrame?.release();
			latestFrame = null;
			opts.signal?.removeEventListener("abort", onAbort);
			ipcMain.removeListener("offscreen:notify", onNotify);
			if (offscreen && !offscreen.isDestroyed()) {
				offscreen.destroy();
			}
			offscreen = null;
			if (replaySession) {
				for (const scheme of ["http", "https"]) replaySession.protocol.unhandle(scheme);
				void replaySession.clearStorageData().catch(() => {});
			}
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

		const succeed = (file: VideoFile) => {
			if (settled) {
				void file.dispose();
				return;
			}
			settled = true;
			cleanup();
			resolve(file);
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
					const t = manual && typeof msg.time === "number" ? msg.time : Math.max(0, (Date.now() - startTime) / 1000);
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
				case "progress-cache":
					// 预热阶段（首遍完整加载、注册 SW/JIT 并缓存静态资源）的真实加载进度，
					// 来源为游戏 #loading-progress 进度条；映射为「正在缓存资源…」反馈给导出对话框。
					opts.onStage?.("cache", typeof msg.percent === "number" ? msg.percent : 0);
					break;
				case "recording-start":
					capturing = true;
					// 统一时钟基准：帧与音频事件都以此刻为 0。
					startTime = Date.now();
					opts.onStage?.("record", 0);
					// 启动「强制全屏重绘」泵：Electron 离屏渲染默认只把「脏矩形」刷进 paint 位图，
					// 静止时牌桌/角色/手牌区域不被重绘 → 捕获帧里只剩背景与刚变化的 UI（角色像「消失」），
					// 唯有觉醒等全屏特效强制整屏重绘时才完整出现。周期性 invalidate() 强制每帧整屏重绘，根治该问题。
					if (manual) {
						offscreen?.webContents.setFrameRate(useSharedTexture ? 1000 : 240);
						void startManualLoop();
						break;
					}
					startRepaintPump();
					// 启动 CFR 输出泵：以恒定 1/fps 节奏从「最近一帧」缓存产帧，与采集节奏解耦。
					lastDiagMs = startTime;
					startOutputPump();
					break;
				case "progress":
					opts.onStage?.("record", typeof msg.percent === "number" ? msg.percent : 0);
					break;
				case "over":
					capturing = false;
					if (!manual) finishEncoding();
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
				await Promise.all(pendingFrames);
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
						const res = opts.gamePackage ? opts.gamePackage.response(new Request(url)) : await fetch(url, { signal: ctrl.signal });
						if (!res.ok) throw new Error("音频资源不可用：" + url);
						const ab = await res.arrayBuffer();
						clearTimeout(to);
						audioFiles[url] = new Uint8Array(ab);
					} catch (e) {
						dlog("主进程拉取音频失败(跳过):", url, String(e));
					}
				}
				// 总时长用最后一帧时间戳（音频不应超过视频长度）。
				dlog("收尾：交付音频给编码器并 finish，视频时长=", lastVideoTs.toFixed(2), "s，总帧=", frameCount);
				encoder.setAudio(audioEvents, audioFiles, lastVideoTs + 1 / effectiveFps);
			} catch (e) {
				dlog("准备音频失败:", String(e));
			}
			encoder
				.finish()
				.then(buf => succeed(buf))
				.catch(err => fail(err instanceof Error ? err : new Error(String(err))));
		};

		const onPaint = (
			e: Electron.Event & { texture?: Electron.OffscreenSharedTexture },
			_dirty: Electron.Rectangle,
			image: Electron.NativeImage
		) => {
			if (useSharedTexture && !e.texture) {
				// invalidate() 可能额外产生无纹理的 paint；它不表示正常 GPU 帧流已经失效。
				return;
			}
			if (e.texture && timer) {
				clearTimeout(timer);
				timer = null;
			}
			if ((!capturing && !manual) || settled) {
				e.texture?.release();
				return;
			}
			// 记录出帧时刻：补帧泵据此判断「游戏是否正在自然出帧」，避免与之叠加造成 readback 翻倍。
			lastPaintAt = Date.now();
			const size = e.texture?.textureInfo.codedSize ?? image.getSize();
			if (size.width === 0 || size.height === 0) {
				e.texture?.release();
				return;
			}
			try {
				const nextFrame = e.texture ? CapturedFrame.fromTexture(e.texture) : CapturedFrame.fromBitmap(image);
				latestFrame?.release();
				latestFrame = nextFrame;
			} catch (error) {
				fail(new Error("共享纹理不可用：" + String(error)));
			}
			paintCount++;
			if (!inited) {
				if (initing) {
					return;
				}
				initing = true;
				encoder
					.init(size.width, size.height, effectiveFps, opts.bitrate)
					.then(() => {
						inited = true;
						void startManualLoop();
					})
					.catch(err => fail(err instanceof Error ? err : new Error(String(err))));
				return;
			}
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
			.then(async () => {
				offscreen = new BrowserWindow({
					show: false,
					width: opts.width,
					height: opts.height,
					webPreferences: {
						session: replaySession,
						offscreen: { useSharedTexture },
						preload: path.join(__dirname, "offscreen", "preload.js"),
						contextIsolation: true,
						nodeIntegration: false,
						backgroundThrottling: false,
					},
				});
				offscreen.webContents.setFrameRate(opts.fps);
				if (manual) {
					await offscreen.loadURL("about:blank");
					offscreen.webContents.debugger.attach("1.3");
					await offscreen.webContents.debugger.sendCommand("Page.enable");
					offscreen.webContents.debugger.on("message", (_event, method, parameters) => {
						if (method === "Runtime.exceptionThrown") opts.onLog?.("回放页异常：" + JSON.stringify(parameters.exceptionDetails));
					});
					await offscreen.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: buildReplayClockScript() });
				}
				if (useSharedTexture) {
					timer = setTimeout(() => fail(new Error("共享纹理不可用：等待 GPU 帧超时")), 15000);
				}
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
				// 进入离屏加载：首遍即开始缓存静态资源，初始即以 cache 阶段反馈，
				// 与预热阶段上报的 progress-cache 衔接，避免对话框长时间停在无意义的初始态。
				opts.onStage?.("cache", 0);
				offscreen.webContents.on("did-finish-load", () => {
					dlog("离屏 did-finish-load, 注入诊断+驱动脚本");
					// 先注入诊断脚本：拦截会永久阻塞离屏渲染器的同步 alert/confirm/prompt，
					// 捕获 window.onerror，并周期性回报 _status 关键状态用于排障。
					offscreen?.webContents
						.executeJavaScript(buildDiagnosticsScript())
						.then(() => offscreen?.webContents.executeJavaScript(opts.injectScript))
						.catch(err => fail(err instanceof Error ? err : new Error(String(err))));
				});
				return offscreen.loadURL(opts.url).catch(error => {
					// PWA 首次安装 Service Worker 时会主动重载；由后续 did-finish-load 继续布置回放。
					if (error?.code !== "ERR_ABORTED") throw error;
				});
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

		// 3'. 动画时钟探针：度量「单位真实时间内动画推进了多少」，用于量化 macOS 慢放。
		//     - rafFps：每秒 requestAnimationFrame 回调次数 ≈ 合成器实际出帧帧率；
		//     - clockRatio：document.timeline.currentTime 的推进量 / 墙钟推进量。
		//       正常应 ≈1.0；若明显 <1（如 0.3），说明动画时钟被节流 → 即「慢放」的直接证据。
		//     这些数字随心跳写入 debug 日志，使后续判断有据可依、不再靠猜。
		let rafCount = 0;
		let lastTimelineMs = 0;
		let lastWallMs = Date.now();
		try {
			const tc = w.document.timeline && w.document.timeline.currentTime;
			lastTimelineMs = typeof tc === "number" ? tc : 0;
		} catch {
			/* ignore */
		}
		const rafTick = () => {
			rafCount++;
			try {
				w.requestAnimationFrame(rafTick);
			} catch {
				/* ignore */
			}
		};
		try {
			w.requestAnimationFrame(rafTick);
		} catch {
			/* ignore */
		}

		// 3. 状态心跳：每秒回报一次，便于定位卡点。
		let ticks = 0;
		const iv = setInterval(() => {
			ticks++;
			// 动画时钟探针采样（每秒）：算出本秒的 rAF 帧率与动画时钟/墙钟比值后清零计数。
			try {
				const nowWall = Date.now();
				const tc = w.document.timeline && w.document.timeline.currentTime;
				const nowTimeline = typeof tc === "number" ? tc : lastTimelineMs;
				const wallDelta = nowWall - lastWallMs;
				const timelineDelta = nowTimeline - lastTimelineMs;
				const clockRatio = wallDelta > 0 ? +(timelineDelta / wallDelta).toFixed(3) : 0;
				report(
					`anim-probe rafFps=${rafCount} clockRatio=${clockRatio} timelineDeltaMs=${Math.round(timelineDelta)} wallDeltaMs=${wallDelta}`
				);
				rafCount = 0;
				lastWallMs = nowWall;
				lastTimelineMs = nowTimeline;
			} catch {
				/* ignore */
			}
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
						// 定位 opacity:0 来源：内联 style 还是 class。
						inlineStyle: p0.getAttribute("style") || "",
						className: p0.className,
						inlineOpacity: p0.style.opacity,
						transition: cs.transition,
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
