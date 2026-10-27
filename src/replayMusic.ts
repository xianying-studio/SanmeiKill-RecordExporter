/** 自包含，注入游戏主世界；音乐的结束、暂停与恢复使用视频时间。 */
export function installReplayMusic(notify: (message: any) => void): () => void {
	const w = window as any;
	const audio = w.ui?.backgroundMusic as HTMLAudioElement | undefined;
	if (!audio) return () => {};
	const clock = w.__replayClock;
	const virtual = !!clock?.active;
	const capture = !w.__exporterSkipAudioCapture;
	const original = new Map<string, PropertyDescriptor | undefined>();
	for (const name of ["src", "currentTime", "paused", "play", "pause", "loop"]) original.set(name, Object.getOwnPropertyDescriptor(audio, name));
	const proto = HTMLMediaElement.prototype;
	const source = Object.getOwnPropertyDescriptor(proto, "src")!;
	const looping = Object.getOwnPropertyDescriptor(proto, "loop")!;
	const nativePause = audio.pause.bind(audio);
	const nativePlay = audio.play.bind(audio);
	const autoplay = audio.autoplay;
	const durationCache = new Map<string, Promise<number>>();
	let context: AudioContext | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let url = source.get!.call(audio) || "";
	let offset = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
	let start = 0;
	let running = false;
	let duration = Infinity;
	let generation = 0;
	let disposed = false;
	const now = () => (virtual ? clock.now() / 1000 : performance.now() / 1000);
	const position = () => {
		const value = offset + (running ? (now() - start) * audio.playbackRate : 0);
		return audio.loop && Number.isFinite(duration) ? value % duration : value;
	};
	const emit = (stop = false) => {
		if (capture) notify({ type: "audio-event", url: stop ? "" : url, loop: true, offset: stop ? 0 : position(), rate: audio.playbackRate });
	};
	const stopTimer = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const getDuration = (src: string) => {
		let result = durationCache.get(src);
		if (!result) {
			result = fetch(src)
				.then(response => {
					if (!response.ok) throw new Error("BGM 资源不可用：" + src);
					return response.arrayBuffer();
				})
				.then(async bytes => {
					if (capture) notify({ type: "audio-file", url: src, data: new Uint8Array(bytes) });
					context ||= new AudioContext();
					return (await context.decodeAudioData(bytes.slice(0))).duration;
				});
			durationCache.set(src, result);
		}
		return result;
	};
	const scheduleEnd = () => {
		stopTimer();
		if (!virtual || !url || !running) return;
		const current = ++generation;
		const loading = getDuration(url).then(seconds => {
			if (disposed || current !== generation || !running) return;
			duration = seconds;
			if (audio.loop) return;
			const remaining = Math.max(0, (duration - position()) / Math.max(0.01, audio.playbackRate));
			timer = setTimeout(() => {
				if (disposed || current !== generation || !running) return;
				offset = duration;
				running = false;
				emit(true);
				audio.dispatchEvent(new Event("ended"));
			}, remaining * 1000);
		});
		clock.track(loading);
	};
	if (virtual) {
		nativePause();
		audio.autoplay = false;
		Object.defineProperty(audio, "paused", { configurable: true, get: () => !running });
		Object.defineProperty(audio, "currentTime", {
			configurable: true,
			get: position,
			set(value: number) {
				offset = Math.max(0, Number(value) || 0);
				start = now();
				if (running) emit();
				scheduleEnd();
			},
		});
		Object.defineProperty(audio, "loop", {
			configurable: true,
			get: () => looping.get!.call(audio),
			set(value: boolean) {
				offset = position();
				start = now();
				looping.set!.call(audio, value);
				scheduleEnd();
			},
		});
	}
	Object.defineProperty(audio, "src", {
		configurable: true,
		get: () => source.get!.call(audio),
		set(value: string) {
			generation++;
			stopTimer();
			source.set!.call(audio, value);
			url = value ? source.get!.call(audio) : "";
			offset = 0;
			start = now();
			duration = Infinity;
			running = !!url;
			if (virtual) nativePause();
			emit(!url);
			scheduleEnd();
		},
	});
	audio.pause = () => {
		if (running) {
			offset = position();
			running = false;
			emit(true);
		}
		generation++;
		stopTimer();
		nativePause();
	};
	audio.play = () => {
		if (!running && url) {
			start = now();
			running = true;
			emit();
			scheduleEnd();
		}
		return virtual ? Promise.resolve() : nativePlay();
	};
	if (!w.__exporterHasMusicEvents) {
		w.game.playBackgroundMusic();
		const initialSource = audio.src;
		if (!running && initialSource) audio.src = initialSource;
	}
	w.__exporterStartReplayMusic?.();
	return () => {
		disposed = true;
		stopTimer();
		for (const [name, descriptor] of original) {
			if (descriptor) Object.defineProperty(audio, name, descriptor);
			else delete (audio as any)[name];
		}
		audio.autoplay = autoplay;
		void context?.close();
	};
}
