const { test, afterEach } = require("node:test");
const { MessageChannel } = require("node:worker_threads");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { buildReplayClockScript } = require("../dist/replayClock");
const channels = [];
afterEach(() => {
	for (const channel of channels.splice(0)) {
		channel.port1.close();
		channel.port2.close();
	}
});
function clockFixture() {
	class Animation {
		constructor() {
			this.currentTime = 0;
			this.playbackRate = 1;
			this.playState = "running";
			this.effect = { getComputedTiming: () => ({ endTime: 1000 }) };
		}
		pause() {
			this.playState = "paused";
		}
		finish() {
			this.playState = "finished";
		}
	}
	const animation = new Animation();
	const context = {
		performance: { now: () => performance.now() },
		Date,
		Animation,
		document: { getAnimations: () => [animation] },
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		requestAnimationFrame: cb => setTimeout(() => cb(performance.now()), 0),
		cancelAnimationFrame: clearTimeout,
		Promise,
		Map,
		WeakMap,
		Proxy,
		Reflect,
		Number,
		Math,
		Error,
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
	return { context, clock: context.__replayClock, animation };
}
test("定时器、Promise、动画帧及 Date 共用可控时间，取消的任务不执行", async () => {
	const { context, clock, animation } = clockFixture();
	clock.start();
	vm.runInContext(
		`window.events=[];setTimeout(()=>events.push('cancelled'),10);clearTimeout(1);setTimeout(()=>{events.push(['timer',Date.now()]);Promise.resolve().then(()=>setTimeout(()=>events.push('nested'),25));},200);requestAnimationFrame(t=>events.push(['raf',t]));`,
		context
	);
	const epoch = context.Date.now();
	const base = context.performance.now();
	await clock.advance(199);
	assert.equal(context.events.length, 1);
	assert.equal(context.events[0][0], "raf");
	await clock.advance(500);
	assert.equal(context.events[1][0], "timer");
	assert.equal(context.events[1][1] - epoch, 200);
	assert.equal(context.events[2], "nested");
	assert.equal(context.Date.now() - epoch, 500);
	assert.ok(Math.abs(context.performance.now() - base - 500) < 1e-6);
	assert.equal(animation.currentTime, 500);
	await clock.advance(1000);
	assert.equal(animation.playState, "finished");
	await assert.rejects(clock.advance(999), /顺序/);
});
test("interval 按视频时间触发，rAF 每次推进只触发一轮", async () => {
	const { context, clock } = clockFixture();
	vm.runInContext(
		`window.ticks=0;window.frames=0;const interval=setInterval(()=>{ticks++;if(ticks===3)clearInterval(interval)},100);function tick(){frames++;requestAnimationFrame(tick)}requestAnimationFrame(tick);`,
		context
	);
	clock.start();
	await clock.advance(500);
	assert.equal(context.ticks, 3);
	assert.equal(context.frames, 1);
	await clock.advance(600);
	assert.equal(context.ticks, 3);
	assert.equal(context.frames, 2);
});
