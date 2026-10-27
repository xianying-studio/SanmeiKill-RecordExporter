const { test, afterEach } = require("node:test");
const { MessageChannel } = require("node:worker_threads");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { buildReplayClockScript } = require("../dist/replayClock");
const { installReplayMusic } = require("../dist/replayMusic");
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
		fetch: async url => ({ ok: true, arrayBuffer: async () => new Uint8Array([url === "a" ? 4 : 3]).buffer }),
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		Event,
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
	return { audio, clock: context.__replayClock, context, music: () => context.events.filter(event => event.type === "audio-event" && event.url) };
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
