const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { buildInjectScript } = require("../dist/inject");

test("加载淡出早于录像读取完成时，时钟必须等待真实录像根事件", () => {
	const listeners = new Map();
	const timeouts = [];
	const messages = [];
	let starts = 0;
	const context = {
		JSON,
		sessionStorage: { getItem: key => (key === "exporter_play_armed" ? "1" : null), removeItem() {} },
		setTimeout: (callback, delay) => {
			timeouts.push({ callback, delay });
			return timeouts.length;
		},
		clearTimeout() {},
		setInterval: () => 1,
		clearInterval() {},
		document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
		addEventListener: (name, callback) => listeners.set(name, callback),
		removeEventListener() {},
		__replayClock: {
			active: false,
			now: () => 0,
			start() {
				starts++;
				this.active = true;
			},
		},
		__exporter: { notify: message => messages.push(message) },
	};
	context.window = context;
	vm.createContext(context);
	vm.runInContext(buildInjectScript(JSON.stringify({ time: 1, mode: "identity", video: [{ type: "init" }] }), "test", "test_", 1), context);
	listeners.get("sanmei-kill:loading-fade-out")();
	assert.equal(starts, 0);
	assert.equal(
		messages.some(message => message.type === "recording-start"),
		false
	);
	context._status = { video: true, event: { video: [{ type: "init" }] } };
	timeouts.find(item => item.delay === 10).callback();
	assert.equal(starts, 1);
	assert.equal(messages.filter(message => message.type === "recording-start").length, 1);
});
