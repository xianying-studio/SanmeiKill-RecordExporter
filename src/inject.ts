/**
 * 注入到离屏游戏页（主世界）的驱动脚本构建器。
 *
 * 设计：脚本在每次页面加载/重载后都会被注入并执行，通过 sessionStorage 哨兵区分两个阶段。
 *
 * 阶段一（首次加载）：
 *   - 等待游戏核心就绪（lib/game/lib.db 可用）；
 *   - 把录像记录写入 IndexedDB 的 "video" 存储（keyPath: time）；
 *   - 设为原速播放（video_default_play_speed=1x）；
 *   - 调用 game.playVideo(time, mode) —— 内部会 reload 进入播放。
 *
 * 阶段二（reload 后，哨兵已置位）：
 *   - 轮询等待播放真正开始（_status.video 且 _status.event.video 就绪）；
 *   - 强制原速（_status.videoDuration=1）、隐藏播放控制条；
 *   - 回报 recording-start / progress；
 *   - _status.over 时回报 over。
 *
 * 与主进程的通信通过 preload 暴露的 window.__exporter.notify。
 */
function injectBody(linkJson: string): void {
	// 下面整段在游戏页主世界中执行；不能使用任何打包期变量，仅依赖运行时全局。
	const w = window as any;
	const SENTINEL = "exporter_playback_armed";

	function notify(m: any): void {
		try {
			w.__exporter && w.__exporter.notify(m);
		} catch {
			/* ignore */
		}
	}

	function coreReady(): boolean {
		return !!(w.lib && w.game && w.lib.init && w.lib.db && w.lib.configprefix !== undefined);
	}

	function waitFor(cond: () => boolean, ok: () => void, timeoutMs: number, onTimeout: () => void): void {
		const start = Date.now();
		const iv = setInterval(() => {
			let ready = false;
			try {
				ready = cond();
			} catch {
				ready = false;
			}
			if (ready) {
				clearInterval(iv);
				ok();
			} else if (Date.now() - start > timeoutMs) {
				clearInterval(iv);
				onTimeout();
			}
		}, 150);
	}

	// —— 阶段二：已布置，等待播放并录制 ——
	if (sessionStorage.getItem(SENTINEL)) {
		let started = false;
		let total = 0;
		const iv = setInterval(() => {
			const s = w._status;
			if (!s) {
				return;
			}
			if (s.video && s.event && Array.isArray(s.event.video)) {
				if (!started) {
					started = true;
					total = s.event.video.length || 1;
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
				sessionStorage.removeItem(SENTINEL);
				// 给最后一帧留出渲染时间再结束。
				setTimeout(() => notify({ type: "over" }), 500);
			}
		}, 150);
		return;
	}

	// —— 阶段一：布置播放 ——
	waitFor(
		coreReady,
		() => {
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
				const store = w.lib.db.transaction(["video"], "readwrite").objectStore("video");
				const req = store.put(link);
				req.onsuccess = () => {
					try {
						notify({ type: "splash-done" });
						sessionStorage.setItem(SENTINEL, "1");
						w.game.saveConfig("video_default_play_speed", "1x");
						w.game.playVideo(String(link.time), link.mode);
					} catch (e) {
						notify({ type: "error", message: "启动播放失败：" + e });
					}
				};
				req.onerror = () => notify({ type: "error", message: "写入录像失败" });
			} catch (e) {
				notify({ type: "error", message: "IndexedDB 不可用：" + e });
			}
		},
		60000,
		() => notify({ type: "error", message: "游戏加载超时" })
	);
}

/**
 * 构建可经 webContents.executeJavaScript 注入的脚本字符串。
 * @param linkJson 录像记录的 JSON 字符串（由 base64 payload 解码而来）
 */
export function buildInjectScript(linkJson: string): string {
	// 以 JSON.stringify 将录像 JSON 安全嵌入为 JS 字符串字面量。
	return `(${injectBody.toString()})(${JSON.stringify(linkJson)});`;
}
