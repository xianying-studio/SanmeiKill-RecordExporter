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
function injectBody(linkJson: string, dbName: string, configPrefix: string, speed: number): void {
	const w = window as any;
	const PLAY_ARMED = "exporter_play_armed";
	// 「等待压缩」系数：仅压缩回放中的各类「等待」（步间空隙 + 录像 delay 步 + videoContent 内部 game.delay），
	// 动画时长（写死在样式表里）保持自然速度。时间戳按真实墙钟，不做 ×倍数还原，故无慢动作。
	const SPEED = speed >= 1 ? speed : 1;

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

	/**
	 * 启动音频「事件」采集与倍速控制。
	 *
	 * 不再实时采集 PCM（倍速回放下 PCM 会变调不可用），改为记录「在什么时间点播放了哪个音频文件」：
	 * - 游戏所有声音都是挂在 ui.window 下的 <audio> 元素（音效每次新建，BGM 为单例 ui.backgroundMusic）。
	 * - hook ui.window.appendChild 捕获音效元素的 src；hook ui.backgroundMusic.src setter 捕获 BGM。
	 * - 播放发生时立即发 audio-event（不带时间戳，由 recorder 端用统一时钟打戳，× SPEED 还原视频时间）。
	 * - 每个唯一 URL 只 fetch 一次原始二进制（含 blob:，在同源离屏窗口里可取）发 audio-file，编码端据此离线混音。
	 * - 压缩等待：_status.videoDuration=1/SPEED（步间空隙 content.js:4564）+ lib.config.duration/=SPEED
	 *   （录像内 delay 步 content.js:4534 与 videoContent 内部 game.delay：time*duration）；动画时长保持自然速度。
	 * - 触发一次 game.playBackgroundMusic()（回放默认不放 BGM）。
	 *
	 * @returns 停止采集/还原 hook 的清理函数
	 */
	function startAudioCapture(): () => void {
		const sentFiles: Set<string> = new Set();
		let origAppendChild: ((node: any) => any) | null = null;
		let winEl: HTMLElement | null = null;
		let bgmDescRestored = false;
		let origDuration: number | null = null;

		// 把一段音频文件的原始字节去重发往主进程（编码端离线混音用）。
		function sendFile(url: string): void {
			if (!url || sentFiles.has(url)) {
				return;
			}
			sentFiles.add(url);
			// 同源 / blob: 均可在离屏窗口内 fetch；拿到 ArrayBuffer 经 __exporter 通道上报。
			fetch(url)
				.then(r => r.arrayBuffer())
				.then(buf => notify({ type: "audio-file", url, data: new Uint8Array(buf) }))
				.catch(err => notify({ type: "debug", message: "fetch 音频失败 " + url + ": " + err }));
		}

		// 记录一次播放事件（recorder 端按收到时刻打时间戳）。
		function emitEvent(url: string, loop: boolean): void {
			if (!url) {
				return;
			}
			sendFile(url);
			notify({ type: "audio-event", url, loop });
		}

		try {
			// 1. 压缩等待（不动画）：
			//    - videoDuration 控制步间空隙（content.js:4564 走 time2 路径，仅受 videoDuration 影响）；
			//    - lib.config.duration 控制录像内 delay 步与 videoContent 内部 game.delay（game.delay: time*duration）。
			//    两者同除以 SPEED → 所有「等待」整体加速 SPEED 倍；动画时长（样式表固定）保持自然速度。
			try {
				if (w._status) {
					w._status.videoDuration = 1 / SPEED;
				}
				if (w.lib && w.lib.config && typeof w.lib.config.duration === "number") {
					const d = w.lib.config.duration as number;
					origDuration = d;
					w.lib.config.duration = d / SPEED;
				}
			} catch {
				/* ignore */
			}

			// 2. 接管音效 <audio>：hook appendChild。
			winEl = (w.ui && w.ui.window) || document.body;
			if (winEl) {
				// 已存在的音效元素（一般为空，BGM 单独处理）。
				winEl.querySelectorAll("audio").forEach((el: any) => {
					if (el !== (w.ui && w.ui.backgroundMusic) && el.src) {
						emitEvent(el.src, false);
					}
				});
				origAppendChild = winEl.appendChild.bind(winEl);
				winEl.appendChild = function (node: any) {
					const ret = origAppendChild!(node);
					try {
						if (node && node.tagName === "AUDIO" && node !== (w.ui && w.ui.backgroundMusic) && node.src) {
							emitEvent(node.src, false);
						}
					} catch {
						/* ignore */
					}
					return ret;
				} as typeof winEl.appendChild;
			}

			// 3. 接管 BGM：hook ui.backgroundMusic.src setter（BGM 循环，loop=true）。
			try {
				const bgm = w.ui && w.ui.backgroundMusic;
				if (bgm) {
					const proto = Object.getPrototypeOf(bgm);
					const desc = Object.getOwnPropertyDescriptor(proto, "src") || Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
					if (desc && desc.set && desc.get) {
						const origSet = desc.set;
						const origGet = desc.get;
						Object.defineProperty(bgm, "src", {
							configurable: true,
							get() {
								return origGet.call(this);
							},
							set(v: string) {
								origSet.call(this, v);
								try {
									if (v) {
										emitEvent(this.src || v, true);
									}
								} catch {
									/* ignore */
								}
							},
						});
						bgmDescRestored = true;
					}
				}
			} catch (err) {
				notify({ type: "debug", message: "hook BGM 失败: " + err });
			}

			// 4. 触发 BGM（回放默认不放背景音乐）。
			try {
				w.game && typeof w.game.playBackgroundMusic === "function" && w.game.playBackgroundMusic();
			} catch {
				/* ignore */
			}

			notify({ type: "debug", message: "音频事件采集已启动, SPEED=" + SPEED });
		} catch (err) {
			notify({ type: "debug", message: "启动音频事件采集失败: " + err });
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
				if (bgmDescRestored) {
					const bgm = w.ui && w.ui.backgroundMusic;
					if (bgm) {
						delete bgm.src; // 删除实例级覆盖，回落到原型 setter
					}
				}
			} catch {
				/* ignore */
			}
			try {
				if (origDuration !== null && w.lib && w.lib.config) {
					w.lib.config.duration = origDuration;
				}
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
					s.videoDuration = 1 / SPEED;
					try {
						if (w.ui && w.ui.system) {
							w.ui.system.style.display = "none";
						}
					} catch {
						/* ignore */
					}
					// 启动音频事件采集 + 倍速 + 触发 BGM。
					stopAudio = startAudioCapture();
					notify({ type: "recording-start" });
				} else {
					s.videoDuration = 1 / SPEED;
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
 * @param speed 录制倍速（游戏以此倍速回放，recorder 端 ×speed 还原为正常速度）
 */
export function buildInjectScript(linkJson: string, dbName: string, configPrefix: string, speed: number): string {
	return `(${injectBody.toString()})(${JSON.stringify(linkJson)}, ${JSON.stringify(dbName)}, ${JSON.stringify(configPrefix)}, ${JSON.stringify(speed)});`;
}
