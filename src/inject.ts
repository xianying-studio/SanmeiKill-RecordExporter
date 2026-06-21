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
 *     并由模式自身的播放逻辑从 IndexedDB 读取录像并自动播放。
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

	// —— 录制阶段：已布置并 reload，等待播放开始→采集进度→结束 ——
	if (sessionStorage.getItem(PLAY_ARMED)) {
		let started = false;
		let total = 0;
		notify({ type: "splash-done" });
		const iv = setInterval(() => {
			const s = w._status;
			if (!s) {
				return;
			}
			if (s.video && s.event && Array.isArray(s.event.video)) {
				if (!started) {
					started = true;
					total = Math.max(1, s.event.video.length);
					s.videoDuration = 1;
					try {
						if (w.ui && w.ui.system) {
							w.ui.system.style.display = "none";
						}
					} catch {
						/* ignore */
					}
					notify({ type: "recording-start" });
				} else {
					s.videoDuration = 1;
					const remaining = s.event.video.length;
					const pct = Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
					notify({ type: "progress", percent: pct });
				}
			}
			if (started && s.over) {
				clearInterval(iv);
				sessionStorage.removeItem(PLAY_ARMED);
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

	try {
		const req = indexedDB.open(dbName, 4);
		// 注入脚本在游戏 boot 之前运行：若数据库尚未由游戏创建，open 会得到一个空库。
		// 必须与游戏一致地建好对象存储，否则后续事务会抛 NotFoundError（object store not found）。
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains("video")) {
				db.createObjectStore("video", { keyPath: "time" });
			}
			if (!db.objectStoreNames.contains("image")) {
				db.createObjectStore("image");
			}
			if (!db.objectStoreNames.contains("audio")) {
				db.createObjectStore("audio");
			}
			if (!db.objectStoreNames.contains("config")) {
				db.createObjectStore("config");
			}
			if (!db.objectStoreNames.contains("data")) {
				db.createObjectStore("data");
			}
		};
		req.onsuccess = () => {
			const db = req.result;
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
						location.reload();
					} catch (e) {
						notify({ type: "error", message: "设置播放标记失败：" + e });
					}
				};
				tx.onerror = () => notify({ type: "error", message: "写入录像/配置失败" });
			} catch (e) {
				notify({ type: "error", message: "IndexedDB 事务失败：" + e });
			}
		};
		req.onerror = () => notify({ type: "error", message: "打开游戏数据库失败" });
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
