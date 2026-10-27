/** 安装于独立回放页的主世界；启动前沿用真实时间，录制时由编码端逐帧推进。 */
function installReplayClock(): void {
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
	const tasks = new Map<number, { at: number; interval: number; callback: () => void; native?: number }>();
	const frames = new Map<number, { callback: FrameRequestCallback; native?: number }>();
	const animations = new WeakMap<Animation, { at: number; initial: number; rate: number; finished: boolean }>();
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
	const hostTurn = () => new Promise<void>(resolve => timeout(resolve, 0));
	w.__replayClock = {
		get active() {
			return active;
		},
		now: () => time,
		start() {
			if (active) return;
			base = realNow();
			epoch = realDateNow();
			time = 0;
			active = true;
			for (const task of tasks.values()) {
				clear(task.native);
				task.at = Math.max(base, task.at);
			}
			for (const frame of frames.values()) if (frame.native !== undefined) cancelRaf(frame.native);
			seekAnimations();
		},
		async advance(target: number) {
			if (!active || stepping || !Number.isFinite(target) || target < time) throw new Error("回放时钟推进顺序无效");
			stepping = true;
			try {
				let budget = 10000;
				while (true) {
					await hostTurn(); // 排空 Promise 和网络回调，允许它们登记新的游戏等待。
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
				await new Promise<void>(resolve => raf(() => raf(() => resolve())));
				return time;
			} finally {
				stepping = false;
			}
		},
	};
}

export function buildReplayClockScript(): string {
	return `(${installReplayClock.toString()})();`;
}
