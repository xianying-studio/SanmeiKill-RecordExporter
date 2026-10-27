const { test, afterEach } = require("node:test");
const { MessageChannel } = require("node:worker_threads");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { buildReplayClockScript } = require("../dist/replayClock");
const { installReplayMusic } = require("../dist/replayMusic");
const { installReplayPresentation } = require("../dist/replayPresentation");
const channels = [];
afterEach(() => {
	for (const channel of channels.splice(0)) {
		channel.port1.close();
		channel.port2.close();
	}
});

function fixture(explicit = false) {
	class Media extends EventTarget {
		constructor() {
			super();
			this._src = "";
			this._loop = false;
			this._time = 0;
			this.playbackRate = 1;
			this.autoplay = true;
		}
		get src() {
			return this._src;
		}
		set src(value) {
			this._src = value;
		}
		get loop() {
			return this._loop;
		}
		set loop(value) {
			this._loop = value;
		}
		get currentTime() {
			return this._time;
		}
		set currentTime(value) {
			this._time = value;
		}
		pause() {}
		play() {
			return Promise.resolve();
		}
	}
	const audio = new Media();
	if (explicit) audio.src = "a";
	let selected = 0;
	const game = {
		playBackgroundMusic() {
			audio.src = selected++ % 2 ? "b" : "a";
		},
	};
	audio.addEventListener("ended", game.playBackgroundMusic);
	const context = {
		__exporterHasMusicEvents: explicit,
		ui: { backgroundMusic: audio },
		game,
		events: [],
		performance: { now: () => performance.now() },
		Date,
		Math: Object.create(Math),
		Animation: class {
			pause() {}
		},
		document: { getAnimations: () => [] },
		HTMLMediaElement: Media,
		AudioContext: class {
			async decodeAudioData(bytes) {
				return { duration: new Uint8Array(bytes)[0] };
			}
			async close() {}
		},
		fetch: async url => ({ ok: true, arrayBuffer: async () => new Uint8Array([url.endsWith("a") ? 4 : 3]).buffer }),
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		Event,
		URL,
		requestAnimationFrame: callback => setTimeout(() => callback(performance.now()), 0),
		cancelAnimationFrame: clearTimeout,
		MessageChannel: class extends MessageChannel {
			constructor() {
				super();
				channels.push(this);
			}
		},
	};
	context.window = context;
	vm.createContext(context);
	vm.runInContext(buildReplayClockScript(), context);
	context.__replayClock.start();
	vm.runInContext(`window.stopMusic=(${installReplayMusic.toString()})(message=>events.push({...message,t:__replayClock.now()/1000}));`, context);
	return {
		audio,
		clock: context.__replayClock,
		context,
		selected: () => selected,
		music: () => context.events.filter(event => event.type === "audio-event" && event.url),
	};
}

test("普通 BGM 在视频时间播完时切歌，离线加速不会推迟 ended", async () => {
	const f = fixture();
	await f.clock.advance(3999);
	assert.equal(f.audio.src, "a");
	await f.clock.advance(4000);
	assert.equal(f.audio.src, "b");
	assert.deepEqual(
		f.music().map(event => [event.url, event.t]),
		[
			["a", 0],
			["b", 4],
		]
	);
	f.context.stopMusic();
});

test("BGM 暂停和恢复保留播放位置，并推迟切歌时间", async () => {
	const f = fixture();
	await f.clock.advance(2000);
	f.audio.pause();
	await f.clock.advance(5000);
	assert.equal(f.audio.currentTime, 2);
	f.audio.play();
	await f.clock.advance(6999);
	assert.equal(f.audio.src, "a");
	await f.clock.advance(7000);
	assert.equal(f.audio.src, "b");
	assert.equal(f.music()[1].offset, 2);
	f.context.stopMusic();
});

test("新录像沿用记录的曲目和播放位置，不在初始化时重新随机选曲", async () => {
	const f = fixture(true);
	await f.clock.advance(500);
	assert.equal(f.music().length, 0);
	f.audio.currentTime = 2;
	f.audio.play();
	assert.equal(f.music()[0].url, "a");
	assert.equal(f.music()[0].offset, 2);
	f.context.stopMusic();
});

for (const nativeHandler of [false, true]) {
	test(`禁用洛克彩蛋后普通曲目反复续播，后续录像事件仍接管播放（${nativeHandler ? "已有处理器" : "旧包适配"}）`, async () => {
		const f = fixture(true);
		const { context, audio } = f;
		context.document.baseURI = "https://game.test/";
		context.lib = { config: { disable_easter_egg_music: true, background_music: "music_default" }, translate: {} };
		context._status = { video: true };
		context.ui.arena = { classList: { remove() {} } };
		context.game.videoContent = {};
		context.game.resumeBackgroundMusic = () => audio.play();
		if (nativeHandler)
			context.game.videoContent.backgroundMusic = state => {
				audio.removeEventListener("ended", context.game.playBackgroundMusic);
				audio.pause();
				audio.src = state.src;
				audio.currentTime = state.offset;
				audio.loop = state.loop;
				if (!state.paused) audio.play();
			};
		vm.runInContext(`(${installReplayPresentation.toString()})();`, context);
		const normal = { src: "a", offset: 0, loop: false, rate: 1, paused: false, easterEgg: false, builtin: false };
		context.game.videoContent.backgroundMusic(normal);
		await f.clock.advance(4000);
		assert.equal(f.selected(), 1, "首曲结束必须立即续播普通曲目");
		context.game.videoContent.backgroundMusic({ ...normal, src: "egg", easterEgg: true });
		assert.equal(audio.paused, false);
		await f.clock.advance(8000);
		assert.equal(f.selected(), 2, "续播监听不能是一次性的，也不能重复注册");
		assert.equal(audio.src, "b");
		assert.deepEqual(
			f
				.music()
				.filter(event => event.t > 0)
				.map(event => event.t),
			[4, 8]
		);
		await f.clock.advance(9000);
		context.game.videoContent.backgroundMusic({ ...normal, offset: 1 });
		assert.equal(audio.currentTime, 1, "后续普通音乐录像事件按记录的播放位置接管");
		await f.clock.advance(12000);
		assert.equal(f.selected(), 3);
		context.lib.config.disable_easter_egg_music = false;
		context.game.videoContent.backgroundMusic(normal);
		await f.clock.advance(16000);
		assert.equal(f.selected(), 3, "启用彩蛋后由录像事件决定换曲，不能随机续播");
		f.context.stopMusic();
	});
}
