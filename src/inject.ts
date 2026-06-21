/**
 * 注入到离屏游戏页（主世界）的驱动脚本构建器。
 *
 * 关键背景（两点）：
 * 1. 三梅杀在「非开发者模式」下不会把 lib/game/ui/_status 暴露到 window；仅当配置 dev=true 时，
 *    初始化阶段才会调用 cheat.i() 暴露这些全局。
 * 2. 初始化时若没有「待播放录像」标记，会停在开屏（splash）等待用户点击「启」选择模式，
 *    离屏环境无人点击会永久卡住，初始化无法走到 cheat.i()。
 *
 * 因此本脚本不调用需要全局的 game.playVideo，而是直接复刻其底层副作用：
 *   - 向 IndexedDB 写入录像记录（video 存储，keyPath: time）；
 *   - 向 IndexedDB 写入 config：mode=录像模式、dev=true、video_default_play_speed=1x；
 *   - 设置 localStorage[`${prefix}playback`]=time —— 触发初始化时直接 importMode 跳过开屏，
 *     并由模式自身的播放逻辑从 IndexedDB 读取录像并自动播放；
 *   - 设置 sessionStorage["sanmei-kill-user-started"]=true —— 跳过 reload 后的「启动!」开屏门禁，
 *     否则离屏环境无人点击会永久卡在「正在加载游戏… 100%」。
 * 然后 reload。reload 后初始化跳过开屏、暴露全局、自动播放录像。
 *
 * 脚本每次页面加载后都会被重新注入，用 sessionStorage 哨兵区分「布置阶段」与「录制阶段」。
 */
function injectBody(linkJson: string, dbName: string, configPrefix: string): void {
	const w = window as any;
	const PLAY_ARMED = "exporter_play_armed";

	function notify(m: any): void {
		try {
			w.__exporter && w.__exporter.notify(m);
		} catch {
			/* ignore */
		}
	}

	// 沿事件父链查找「录像根事件」（其 video 为待播放步骤数组）。
	// 播放过程中 _status.event 往往是某个子事件，直接读 _status.event.video 多数时刻为 undefined，
	// 因此用父链回溯定位录像数组，作为进度来源。
	// MAX_EVENT_CHAIN_DEPTH 仅为防御性上限：正常事件链远浅于此，200 足以覆盖且能避免异常链导致死循环。
	const MAX_EVENT_CHAIN_DEPTH = 200;
	function findVideoEvent(status: any): any {
		let e = status && status.event;
		for (let i = 0; e && i < MAX_EVENT_CHAIN_DEPTH; i++) {
			if (Array.isArray(e.video)) {
				return e;
			}
			e = e.parent;
		}
		return null;
	}

	/** 采集音频用的固定采样率（与编码器侧一致，AAC 友好）。 */
	const AUDIO_SAMPLE_RATE = 48000;

	/**
	 * 启动音频采集：把游戏所有 <audio> 的输出汇入一个 AudioContext，
	 * 经 ScriptProcessor 取出 PCM 上报给主进程（再由编码器窗口编成 AAC 轨）。
	 *
	 * 关键点：
	 * - 游戏不使用 Web Audio，所有声音都是挂在 ui.window 下的 <audio> 元素
	 *   （BGM 为单例 ui.backgroundMusic，音效为每次新建、播完即删）。
	 * - 把每个 <audio> 经 createMediaElementSource 接到采集图后，该元素就只走我们的图、
	 *   不再走默认输出，从而天然不外放（叠加离屏 setAudioMuted 双保险）。
	 * - 采集节点不把输入回写到输出（输出写静音），故设备端无声。
	 * - 回放默认不自动放 BGM，这里手动触发一次 game.playBackgroundMusic()。
	 *
	 * @returns 停止采集的清理函数
	 */
	function startAudioCapture(): () => void {
		let ac: AudioContext | null = null;
		let processor: ScriptProcessorNode | null = null;
		const connected: WeakSet<HTMLMediaElement> = new WeakSet();
		let origAppendChild: ((node: any) => any) | null = null;
		let winEl: HTMLElement | null = null;

		try {
			const AC = w.AudioContext || w.webkitAudioContext;
			if (!AC) {
				notify({ type: "debug", message: "无 AudioContext，跳过音频采集" });
				return () => void 0;
			}
			ac = new AC({ sampleRate: AUDIO_SAMPLE_RATE });
			if (ac && ac.state === "suspended") {
				ac.resume().catch(() => void 0);
			}

			// 采集节点：2 入 2 出；输出写静音以避免外放。
			processor = ac!.createScriptProcessor(4096, 2, 2);
			processor.onaudioprocess = (e: AudioProcessingEvent) => {
				const inBuf = e.inputBuffer;
				const out = e.outputBuffer;
				const frames = inBuf.length;
				const inL = inBuf.numberOfChannels > 0 ? inBuf.getChannelData(0) : new Float32Array(frames);
				const inR = inBuf.numberOfChannels > 1 ? inBuf.getChannelData(1) : inL;
				// 复制后上报（底层缓冲会被复用，不能直接传引用）。
				const ch0 = new Float32Array(inL);
				const ch1 = new Float32Array(inR);
				notify({ type: "audio", ch0, ch1, frames });
				// 输出静音。
				for (let c = 0; c < out.numberOfChannels; c++) {
					out.getChannelData(c).fill(0);
				}
			};
			processor.connect(ac!.destination);

			const connectEl = (el: HTMLMediaElement) => {
				if (!ac || !processor || connected.has(el)) {
					return;
				}
				try {
					const src = ac.createMediaElementSource(el);
					src.connect(processor); // 不连 ac.destination，故不外放
					connected.add(el);
				} catch (err) {
					// 某元素已被接入别的图等异常：忽略，避免影响录制。
					notify({ type: "debug", message: "connect <audio> 失败: " + err });
				}
			};

			winEl = (w.ui && w.ui.window) || document.body;
			// 接管已存在的 <audio>（含 BGM 单例）。
			if (winEl) {
				winEl.querySelectorAll("audio").forEach((el: HTMLMediaElement) => connectEl(el));
				// patch appendChild，覆盖后续动态创建的音效元素。
				origAppendChild = winEl.appendChild.bind(winEl);
				winEl.appendChild = function (node: any) {
					const ret = origAppendChild!(node);
					try {
						if (node && node.tagName === "AUDIO") {
							connectEl(node as HTMLMediaElement);
						}
					} catch {
						/* ignore */
					}
					return ret;
				} as typeof winEl.appendChild;
			}

			// 触发 BGM（回放默认不放背景音乐）。
			try {
				w.game && typeof w.game.playBackgroundMusic === "function" && w.game.playBackgroundMusic();
			} catch {
				/* ignore */
			}

			notify({ type: "debug", message: "音频采集已启动" });
		} catch (err) {
			notify({ type: "debug", message: "启动音频采集失败: " + err });
		}

		return () => {
			try {
				if (winEl && origAppendChild) {
					winEl.appendChild = origAppendChild as typeof winEl.appendChild;
				}
			} catch {
				/* ignore */
			}
			try {
				processor && processor.disconnect();
			} catch {
				/* ignore */
			}
			try {
				ac && ac.close();
			} catch {
				/* ignore */
			}
		};
	}

	// —— 录制阶段：已布置并 reload，等待播放开始→采集进度→结束 ——
	if (sessionStorage.getItem(PLAY_ARMED)) {
		let started = false;
		let total = 0;
		let stopAudio: (() => void) | null = null;
		notify({ type: "splash-done" });
		const iv = setInterval(() => {
			const s = w._status;
			if (!s) {
				return;
			}
			// 播放开始的判定以 _status.video 为主信号：它在 game.playVideoContent 中被置为 true，
			// 且整段播放期间保持为真，比「当前事件恰为录像根事件」更稳定（后者会因子事件入栈而频繁错过）。
			if (s.video) {
				const videoEvent = findVideoEvent(s);
				// 录像数组首次可见时一次性锁定总步数作为进度分母：
				// 数组随播放只减不增，故「首见长度」即为最大值，total 此后不再变更，进度保持单调。
				if (total === 0 && videoEvent) {
					total = Math.max(1, videoEvent.video.length);
				}
				if (!started) {
					started = true;
					s.videoDuration = 1;
					try {
						if (w.ui && w.ui.system) {
							w.ui.system.style.display = "none";
						}
					} catch {
						/* ignore */
					}
					// 启动音频采集并触发 BGM（回放默认不放背景音乐）。
					stopAudio = startAudioCapture();
					notify({ type: "recording-start" });
				} else {
					s.videoDuration = 1;
					if (videoEvent && total > 0) {
						const remaining = videoEvent.video.length;
						const pct = Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
						notify({ type: "progress", percent: pct });
					}
				}
			}
			if (started && s.over) {
				clearInterval(iv);
				sessionStorage.removeItem(PLAY_ARMED);
				if (stopAudio) {
					stopAudio();
					stopAudio = null;
				}
				// 给最后一帧留出渲染时间再结束。
				setTimeout(() => notify({ type: "over" }), 500);
			}
		}, 150);
		return;
	}

	// —— 布置阶段：写录像 + 配置 + playback 标记，然后 reload ——
	let link: any;
	try {
		link = JSON.parse(linkJson);
	} catch {
		notify({ type: "error", message: "录像数据解析失败" });
		return;
	}
	if (!link || link.time === undefined || !link.mode || !link.video) {
		notify({ type: "error", message: "录像数据不完整" });
		return;
	}

	// 写入事务必须用到的对象存储；缺一不可，否则 transaction 抛 NotFoundError。
	const REQUIRED_STORES = ["video", "config"];
	// 与游戏一致的完整对象存储集合，补建时一并建好以免后续游戏逻辑缺存储。
	const ALL_STORES = ["video", "image", "audio", "config", "data"];

	function ensureStores(db: IDBDatabase): void {
		for (const name of ALL_STORES) {
			if (!db.objectStoreNames.contains(name)) {
				if (name === "video") {
					db.createObjectStore("video", { keyPath: "time" });
				} else {
					db.createObjectStore(name);
				}
			}
		}
	}

	function writeAndReload(db: IDBDatabase): void {
		try {
			const tx = db.transaction(["video", "config"], "readwrite");
			const videoStore = tx.objectStore("video");
			const configStore = tx.objectStore("config");
			videoStore.put(link);
			configStore.put(link.mode, "mode");
			configStore.put(true, "dev");
			configStore.put("1x", "video_default_play_speed");
			tx.oncomplete = () => {
				try {
					localStorage.setItem(configPrefix + "playbackmode", link.mode);
					localStorage.setItem(configPrefix + "playback", String(link.time));
					sessionStorage.setItem(PLAY_ARMED, "1");
					// 关键：跳过 reload 后的「启动!」开屏门禁，否则离屏环境无人点击会永久卡在
					// 「正在加载游戏… 100%」（JIT entry.ts 的 passStartGate 与 core entry.ts 均看此标记）。
					sessionStorage.setItem("sanmei-kill-user-started", "true");
					// 顺带跳过 JIT 首次激活 Service Worker 的额外 reload，省一次离屏重载。
					sessionStorage.setItem("isJITReloaded", "true");
					db.close();
					location.reload();
				} catch (e) {
					notify({ type: "error", message: "设置播放标记失败：" + e });
					try {
						db.close();
					} catch {
						/* ignore */
					}
				}
			};
			tx.onerror = () => {
				try {
					db.close();
				} catch {
					/* ignore */
				}
				notify({ type: "error", message: "写入录像/配置失败" });
			};
		} catch (e) {
			try {
				db.close();
			} catch {
				/* ignore */
			}
			notify({ type: "error", message: "IndexedDB 事务失败：" + e });
		}
	}

	try {
		// 不指定版本号打开，先读取游戏库的真实当前版本。
		// 硬编码版本号是不可靠的：若游戏库版本更高会触发 VersionError；
		// 若版本相同却缺少对象存储则 onupgradeneeded 不触发，事务抛 NotFoundError。
		const probe = indexedDB.open(dbName);
		probe.onupgradeneeded = () => ensureStores(probe.result);
		probe.onsuccess = () => {
			const db = probe.result;
			const needUpgrade = REQUIRED_STORES.some(name => !db.objectStoreNames.contains(name));
			if (!needUpgrade) {
				writeAndReload(db);
				return;
			}
			// 缺少必要对象存储：以「当前版本 + 1」重新打开并补建，
			// 这样无论游戏库当前处于哪个版本都能安全升级。
			const nextVersion = db.version + 1;
			db.close();
			const upgrade = indexedDB.open(dbName, nextVersion);
			upgrade.onupgradeneeded = () => ensureStores(upgrade.result);
			upgrade.onsuccess = () => writeAndReload(upgrade.result);
			upgrade.onblocked = () => notify({ type: "error", message: "游戏数据库被占用，升级被阻塞" });
			upgrade.onerror = () => notify({ type: "error", message: "升级游戏数据库失败：" + (upgrade.error || "") });
		};
		probe.onerror = () => notify({ type: "error", message: "打开游戏数据库失败" });
	} catch (e) {
		notify({ type: "error", message: "IndexedDB 不可用：" + e });
	}
}

/**
 * 构建可经 webContents.executeJavaScript 注入的脚本字符串。
 * @param linkJson 录像记录的 JSON 字符串（由 base64 payload 解码而来）
 * @param dbName 游戏 IndexedDB 数据库名（如 noname_0.9_data）
 * @param configPrefix 游戏配置前缀（如 noname_0.9_）
 */
export function buildInjectScript(linkJson: string, dbName: string, configPrefix: string): string {
	return `(${injectBody.toString()})(${JSON.stringify(linkJson)}, ${JSON.stringify(dbName)}, ${JSON.stringify(configPrefix)});`;
}
