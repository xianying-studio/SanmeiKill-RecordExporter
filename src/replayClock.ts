/** 安装于独立回放页的主世界；启动前沿用真实时间，录制时由编码端逐帧推进。 */
function installReplayClock(settings: { epoch?: number; seed?: number }): void {
	const w = window as any;
	if (w.__replayClock) return;
	const realNow = performance.now.bind(performance);
	const realDateNow = Date.now.bind(Date);
	const NativeDate = Date;
	const timeout = window.setTimeout.bind(window);
	const clear = window.clearTimeout.bind(window);
	const raf = window.requestAnimationFrame.bind(window);
	const cancelRaf = window.cancelAnimationFrame.bind(window);
	const pauseAnimation = Animation.prototype.pause;
	const tasks = new Map<number, { at: number; delay: number; interval: number; callback: () => void; native?: number }>();
	const frames = new Map<number, { callback: FrameRequestCallback; native?: number }>();
	const animations = new WeakMap<Animation, { at: number; initial: number; rate: number; finished: boolean }>();
	const dependencies = new Set<Promise<unknown>>();
	let sequence = 0;
	let active = false;
	let base = 0;
	let epoch = 0;
	let time = 0;
	let stepping = false;
	const now = () => (active ? base + time : realNow());
	const fire = (id: number) => {
		const task = tasks.get(id);
		if (!task) return;
		if (task.interval) task.at = now() + task.interval;
		else tasks.delete(id);
		task.callback();
		if (!active && task.interval && tasks.has(id)) task.native = timeout(() => fire(id), task.interval);
	};
	const schedule = (handler: TimerHandler, delay: number | undefined, args: any[], interval: boolean) => {
		if (typeof handler !== "function") throw new Error("逐帧回放不支持字符串定时器");
		const duration = Math.max(1, Number(delay) || 0);
		const id = ++sequence;
		const task = {
			at: now() + duration,
			delay: duration,
			interval: interval ? duration : 0,
			callback: () => handler.apply(w, args),
			native: undefined as number | undefined,
		};
		tasks.set(id, task);
		if (!active) task.native = timeout(() => fire(id), duration);
		return id;
	};
	w.setTimeout = (callback: TimerHandler, delay?: number, ...args: any[]) => schedule(callback, delay, args, false);
	w.setInterval = (callback: TimerHandler, delay?: number, ...args: any[]) => schedule(callback, delay, args, true);
	w.clearTimeout = w.clearInterval = (id: number) => {
		clear(tasks.get(id)?.native);
		tasks.delete(id);
	};
	w.requestAnimationFrame = (callback: FrameRequestCallback) => {
		const id = ++sequence;
		const frame = { callback, native: undefined as number | undefined };
		frames.set(id, frame);
		if (!active)
			frame.native = raf(timestamp => {
				frames.delete(id);
				callback.call(w, timestamp);
			});
		return id;
	};
	w.cancelAnimationFrame = (id: number) => {
		const native = frames.get(id)?.native;
		if (native !== undefined) cancelRaf(native);
		frames.delete(id);
	};
	Object.defineProperty(performance, "now", { configurable: true, value: now });
	w.Date = new Proxy(NativeDate, {
		get: (target, key) => (key === "now" ? () => (active ? epoch + time : realDateNow()) : Reflect.get(target, key)),
		construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [active ? epoch + time : realDateNow()], newTarget),
		apply: () => new NativeDate(active ? epoch + time : realDateNow()).toString(),
	});

	const seekAnimations = () => {
		for (const animation of document.getAnimations()) {
			let state = animations.get(animation);
			if (!state) {
				if (animation.playState === "finished" || animation.playState === "idle" || animation.playState === "paused") continue;
				state = { at: time, initial: Number(animation.currentTime) || 0, rate: animation.playbackRate, finished: false };
				animations.set(animation, state);
				pauseAnimation.call(animation);
			}
			if (state.finished) continue;
			const position = Math.max(0, state.initial + (time - state.at) * state.rate);
			const end = Number(animation.effect?.getComputedTiming().endTime ?? Infinity);
			animation.currentTime = position;
			if (Number.isFinite(end) && position >= end && state.rate > 0) {
				state.finished = true;
				animation.finish();
			}
		}
	};
	// 消息任务让浏览器处理 Promise/网络回调，不受原生定时器最小延迟限制。
	const channel = new MessageChannel();
	let resumeHostTurn: (() => void) | undefined;
	channel.port1.onmessage = () => {
		const resolve = resumeHostTurn;
		resumeHostTurn = undefined;
		resolve?.();
	};
	const hostTurn = () =>
		new Promise<void>(resolve => {
			resumeHostTurn = resolve;
			channel.port2.postMessage(null);
		});
	w.__replayClock = {
		get active() {
			return active;
		},
		now: () => time,
		track(promise: Promise<unknown>) {
			dependencies.add(promise);
			void promise.then(
				() => dependencies.delete(promise),
				() => {}
			);
		},
		start() {
			if (active) return;
			base = realNow();
			epoch = settings.epoch ?? realDateNow();
			if (settings.seed !== undefined) {
				let seed = settings.seed || 1;
				Math.random = () => {
					seed ^= seed << 13;
					seed ^= seed >>> 17;
					seed ^= seed << 5;
					return (seed >>> 0) / 4294967296;
				};
			}
			time = 0;
			active = true;
			for (const task of tasks.values()) {
				clear(task.native);
				// 各渲染进程加载耗时不同，进入录像时统一重新计时，避免把载入时间计入片头。
				task.at = base + task.delay;
			}
			for (const frame of frames.values()) if (frame.native !== undefined) cancelRaf(frame.native);
			seekAnimations();
		},
		async advance(target: number, present = true) {
			if (!active || stepping || !Number.isFinite(target) || target < time) throw new Error("回放时钟推进顺序无效");
			stepping = true;
			try {
				let budget = 10000;
				while (true) {
					await hostTurn(); // 排空 Promise 和网络回调，允许它们登记新的游戏等待。
					while (dependencies.size) {
						const pending = [...dependencies];
						await Promise.all(pending);
						for (const promise of pending) dependencies.delete(promise);
					}
					let next: number | undefined;
					for (const [id, task] of tasks) if (task.at <= base + target && (next === undefined || task.at < tasks.get(next)!.at)) next = id;
					if (next === undefined) break;
					if (--budget <= 0) throw new Error("回放定时器在同一帧中未能收敛");
					time = Math.max(time, tasks.get(next)!.at - base);
					seekAnimations();
					fire(next);
					seekAnimations();
				}
				time = target;
				const callbacks = [...frames];
				for (const [id, frame] of callbacks) {
					if (frames.delete(id)) frame.callback.call(w, base + time);
				}
				seekAnimations();
				await hostTurn();
				seekAnimations();
				// 等待布局/合成提交；不经 capturePage 或 CPU 位图截帧。
				if (present) await new Promise<void>(resolve => raf(() => raf(() => resolve())));
				return time;
			} finally {
				stepping = false;
			}
		},
		async seekFrame(startFrame: number, fps: number) {
			if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !(fps > 0)) throw new Error("分段起点无效");
			const preroll = Math.max(0, startFrame - fps * 5);
			for (let index = 0; index < startFrame; ) {
				if (w.__exporterReplayEnded) throw new Error("录像已在分段起点之前结束");
				await this.advance((index * 1000) / fps, false);
				// 早期状态恢复仅减少动画采样，定时器仍逐个按原时间执行；起点前五秒恢复完整帧率。
				const step = index < preroll ? Math.max(1, Math.round(fps / 30)) : 1;
				index = Math.min(index + step, index < preroll ? preroll : startFrame);
			}
		},
	};
}

export function buildReplayClockScript(settings: { epoch?: number; seed?: number } = {}): string {
	return `(${installReplayClock.toString()})(${JSON.stringify(settings)});`;
}
