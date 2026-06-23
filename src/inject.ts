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
	// 预热哨兵：第一次完整加载（含 JIT/SW 注册与资源缓存）完成后置位，再 reload 进入录制阶段，
	// 使录制阶段的二次初始化命中缓存、快且稳定，便于精确控制开场遮罩停留时长。
	const WARMED = "exporter_warmed";
	// 加载完成→淡出事件名（游戏 init/index.ts 的 loadingManager.finish 派发，标志游戏已就绪、遮罩本应淡出）。
	const LOADING_FADE_EVENT = "sanmei-kill:loading-fade-out";
	// 开场遮罩停留时长（毫秒）：展示标题、无进度条/启动按钮，停留后调用原有淡出。
	const SPLASH_HOLD_MS = 1000;
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
		// 最近一次 BGM（loop=true）的 url：用于对 BGM 的循环重设去重，避免离线混音叠成多条重叠循环。
		let lastBgmUrl = "";

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
			if (loop) {
				// BGM 是单条循环轨：同一 url 的重复设置（游戏在轨道边界重设 src 以续播）只记一次，
				// 否则离线混音会为每次重设各起一条循环源，叠成多条重叠 BGM。
				if (url === lastBgmUrl) {
					return;
				}
				lastBgmUrl = url;
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

			// 4. 触发并捕获初始 BGM。
			//    回放在 hook 安装前可能已设置 ui.backgroundMusic.src（BGM 已在播），此时 hook 的 setter 不会回放性地触发，
			//    导致首条 BGM 事件要等到曲子播完、游戏在循环边界重设 src 时才被捕获（实测约 221s 后）。
			//    因此先主动触发一次 playBackgroundMusic（其内部会设 src → 命中 hook）；若触发后 src 仍非空但未命中
			//    （例如值与原值相同、浏览器未再次派发），再直接读取当前 src 兜底补发一次。
			try {
				const bgm = w.ui && w.ui.backgroundMusic;
				const before = bgm ? bgm.src : "";
				if (w.game && typeof w.game.playBackgroundMusic === "function") {
					w.game.playBackgroundMusic();
				}
				// 兜底：playBackgroundMusic 走 db:/异步分支或未改变 src 时，直接读当前 src 补发（emitEvent 内已按 url 去重）。
				const after = bgm ? bgm.src : "";
				if (after) {
					emitEvent(after, true);
				} else if (before) {
					emitEvent(before, true);
				}
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

	// —— 录制阶段：已布置并 reload，开场遮罩→1秒→淡出→录像+BGM ——
	if (sessionStorage.getItem(PLAY_ARMED)) {
		sessionStorage.removeItem(WARMED); // 清理预热哨兵，避免污染后续
		let started = false; // 是否已开始录制（recording-start 已发）
		let total = 0;
		let stopAudio: (() => void) | null = null;
		let restoreFadeOut: (() => void) | null = null; // 恢复并执行被拦截的原淡出
		notify({ type: "splash-done" });

		// 1. 隐藏开场遮罩里的进度条/文件名/启动按钮（保留「三梅杀」标题）。
		try {
			if (!document.getElementById("exporter-splash-style")) {
				const st = document.createElement("style");
				st.id = "exporter-splash-style";
				st.textContent =
					"#loading-screen .progress-container,#loading-screen .filename,#loading-screen .start-btn{display:none !important;}";
				(document.head || document.documentElement).appendChild(st);
			}
		} catch {
			/* ignore */
		}

		// 2. 拦截游戏「加载完成→淡出」：游戏就绪时 init/index.ts 的 finish() 会派发 LOADING_FADE_EVENT，
		//    随后同步 classList.add('fade-out') 并 600ms 后 remove()。我们在事件回调里接管 #loading-screen：
		//    下一帧移除 fade-out 类、空置其 remove()，把遮罩「钉住」；保留 restoreFadeOut 以便 1 秒后再放行淡出。
		const onLoadingFade = () => {
			window.removeEventListener(LOADING_FADE_EVENT, onLoadingFade);
			const screen = document.getElementById("loading-screen");
			if (!screen) {
				// 无遮罩可钉，直接进入「开始录制+淡出」逻辑（兜底）。
				beginRecording();
				return;
			}
			const origRemove = screen.remove.bind(screen);
			// 钉住：取消即将到来的淡出与移除。
			requestAnimationFrame(() => screen.classList.remove("fade-out"));
			(screen as any).remove = () => {
				/* 暂缓移除，待 restoreFadeOut 放行 */
			};
			restoreFadeOut = () => {
				(screen as any).remove = origRemove;
				screen.classList.add("fade-out");
				setTimeout(() => {
					try {
						origRemove();
					} catch {
						/* ignore */
					}
				}, 600);
			};
			// 游戏已就绪、遮罩已钉住：此刻开始录制（录到开场遮罩+标题）。
			beginRecording();
		};
		window.addEventListener(LOADING_FADE_EVENT, onLoadingFade);

		// 3. 开始录制 + 保持 1 秒 + 淡出 + 启动录像计时与 BGM。
		function beginRecording(): void {
			if (started) {
				return;
			}
			started = true;
			// 隐藏顶部回放控制条（#system）。用 !important 规则，避免被回放初始化 show() 盖回。
			try {
				if (!document.getElementById("exporter-hide-ui-style")) {
					const st = document.createElement("style");
					st.id = "exporter-hide-ui-style";
					st.textContent = "#system{display:none !important;}";
					(document.head || document.documentElement).appendChild(st);
				}
			} catch {
				/* ignore */
			}
			// 先发 recording-start 确立 recorder 端统一时钟基准（此刻录到的是开场遮罩+标题）。
			notify({ type: "recording-start" });
			// 保持 1 秒开场，再放行淡出并启动音频采集与 BGM。
			setTimeout(() => {
				if (restoreFadeOut) {
					restoreFadeOut();
					restoreFadeOut = null;
				}
				// 淡出开始的同时启动音频采集 + 触发并补发初始 BGM，使 BGM 与露出的游戏画面同步起点。
				if (!stopAudio) {
					stopAudio = startAudioCapture();
				}
			}, SPLASH_HOLD_MS);
		}

		// 4. 兜底：若某些环境下 LOADING_FADE_EVENT 未触发，用 _status.video 作为后备触发开始录制。
		const fallbackStart = setTimeout(() => {
			if (!started) {
				window.removeEventListener(LOADING_FADE_EVENT, onLoadingFade);
				beginRecording();
			}
		}, 30000);

		// 5. 进度采集与结束判定。
		const iv = setInterval(() => {
			const s = w._status;
			if (!s) {
				return;
			}
			if (s.video) {
				const videoEvent = findVideoEvent(s);
				if (total === 0 && videoEvent) {
					total = Math.max(1, videoEvent.video.length);
				}
				s.videoDuration = 1 / SPEED;
				if (started && videoEvent && total > 0) {
					const remaining = videoEvent.video.length;
					const pct = Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
					notify({ type: "progress", percent: pct });
				}
			}
			if (started && s.over) {
				clearInterval(iv);
				clearTimeout(fallbackStart);
				sessionStorage.removeItem(PLAY_ARMED);
				// 结算画面出现后再多录 5 秒，确保玩家能看清结算画面，再结束视频；
				// 这 5 秒内不停止音频采集(stopAudio 会还原 hook、可能中断 BGM)，5 秒后再停采集并发 over。
				setTimeout(() => {
					if (stopAudio) {
						stopAudio();
						stopAudio = null;
					}
					notify({ type: "over" });
				}, 5000);
			}
		}, 150);
		return;
	}

	// —— 预热阶段：首次完整加载已就绪，置位 PLAY_ARMED 并 reload 进入录制阶段 ——
	// 预热目的：让 JIT/Service Worker 注册与资源缓存在「不录制」的这一遍完成，
	// 使下一遍（录制阶段）的初始化命中缓存、快且稳定，便于精确控制开场遮罩停留 1 秒。
	if (sessionStorage.getItem(WARMED)) {
		// 预热阶段是「冷缓存」的完整加载，是整个导出里最耗时的一段。游戏 #loading-progress 进度条
		// 在此从 0→100% 反映 SW/JIT 注册与静态资源缓存的真实进度。轮询其宽度并上报 progress-cache，
		// 同步给导出对话框的「正在缓存资源…」，避免用户长时间面对无进度反馈的界面。
		let lastCachePct = -1;
		const cachePoll = setInterval(() => {
			try {
				const bar = document.getElementById("loading-progress");
				if (bar) {
					const pct = Math.max(0, Math.min(100, parseFloat(bar.style.width) || 0));
					if (pct !== lastCachePct) {
						lastCachePct = pct;
						notify({ type: "progress-cache", percent: pct });
					}
				}
			} catch {
				/* ignore */
			}
		}, 150);
		const stopCachePoll = () => {
			clearInterval(cachePoll);
			// 预热结束、即将 reload 进入录制阶段：补一帧 100%，让缓存阶段进度条收满。
			notify({ type: "progress-cache", percent: 100 });
		};
		const armAndReload = () => {
			try {
				stopCachePoll();
				sessionStorage.setItem(PLAY_ARMED, "1");
				sessionStorage.removeItem(WARMED);
				location.reload();
			} catch (e) {
				notify({ type: "error", message: "预热后置位录制标记失败：" + e });
			}
		};
		// 游戏就绪（派发淡出事件）后即 reload 进入录制；兜底超时同样 reload，避免卡死。
		const fade = () => {
			window.removeEventListener(LOADING_FADE_EVENT, fade);
			armAndReload();
		};
		window.addEventListener(LOADING_FADE_EVENT, fade);
		setTimeout(() => {
			window.removeEventListener(LOADING_FADE_EVENT, fade);
			if (!sessionStorage.getItem(PLAY_ARMED)) {
				armAndReload();
			}
		}, 30000);
		return;
	}

	// —— 布置阶段：写录像 + 配置 + 预热标记，然后 reload ——
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
					// 先进入「预热」阶段（非录制）：本次 reload 让游戏完整加载并缓存资源，下一遍才录制。
					sessionStorage.setItem(WARMED, "1");
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
