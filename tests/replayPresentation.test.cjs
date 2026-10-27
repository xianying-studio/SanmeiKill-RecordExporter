const { test } = require("node:test");
const assert = require("node:assert/strict");
const { installReplayPresentation } = require("../dist/replayPresentation");
function fixture() {
	const classes = new Set(["dead"]);
	const player = {
		classList: { contains: name => classes.has(name) },
		style: { transform: "translate(2px, 3px) rotateY(180deg)" },
		node: { identity: { dataset: { color: "fan" } } },
	};
	let created = 0;
	const game = {
		playBackgroundMusic() {},
		videoContent: {
			die: () => 42,
			setIdentity: (target, id) => {
				target.node.identity.dataset.color = id;
			},
		},
		playerMap: { 1: player },
	};
	const arenaClasses = new Set(["nolink"]);
	global.window = {
		game,
		lib: { config: { mode: "identity" }, translate: { fan2: "反贼", zhong2: "忠臣" } },
		ui: {
			arena: { classList: { remove: name => arenaClasses.delete(name) } },
			refresh: () => {},
			create: {
				div: () => {
					created++;
					return { style: {} };
				},
			},
		},
		_status: { video: true },
	};
	return { player, game, classes, arenaClasses, created: () => created };
}
test("录像中的中央死亡身份可见，翻面后文字反向旋转并避免重复创建", () => {
	const f = fixture();
	assert.equal(installReplayPresentation(), true);
	assert.equal(f.player.node.dieidentity.textContent, "反贼");
	assert.equal(f.player.node.dieidentity.style.opacity, "1");
	assert.equal(f.player.node.dieidentity.style.transform, "rotateY(180deg)");
	assert.equal(f.game.videoContent.die(f.player), 42);
	assert.equal(f.created(), 1);
	f.game.videoContent.setIdentity(f.player, "zhong");
	assert.equal(f.player.node.dieidentity.textContent, "忠臣");
	assert.equal(installReplayPresentation(), true);
	assert.equal(f.created(), 1);
});
test("不对存活角色创建死亡身份，铁索展示明确启用", () => {
	const f = fixture();
	f.classes.delete("dead");
	installReplayPresentation();
	assert.equal(f.player.node.dieidentity, undefined);
	assert.equal(window.lib.config.link_style2, "chain");
	assert.equal(f.arenaClasses.has("nolink"), false);
});
test("非回放页面不安装展示适配", () => {
	const f = fixture();
	window._status.video = false;
	assert.equal(installReplayPresentation(), false);
	assert.equal(f.created(), 0);
});

test("五谷丰登按录像卡牌 ID 标注选牌角色，重名卡牌不会混淆", () => {
	const f = fixture();
	const first = { link: { cardid: "card-1" } };
	const second = { link: { cardid: "card-2" } };
	const dialog = { videoId: 4, buttons: [first, second] };
	window.ui.dialogs = [dialog];
	f.game.videoContent.cardDialog = () => 17;
	f.game.videoContent.drawCard = () => 23;
	f.game.createButtonCardsetion = (name, button) => {
		button.label = name;
	};
	installReplayPresentation();
	assert.equal(f.game.videoContent.cardDialog(["五谷丰登", [], 4]), 17);
	const player = { getName: full => (full ? "泠無情" : "不应使用") };
	assert.equal(f.game.videoContent.drawCard(player, [["diamond", 2, "shan", null, "card-2"]]), 23);
	assert.equal(second.label, "泠無情");
	assert.equal(first.label, undefined);
	assert.deepEqual(dialog.buttons, [first]);
	f.game.videoContent.drawCard(player, [["diamond", 2, "shan", null, "card-2"]]);
	assert.deepEqual(dialog.buttons, [first]);
});

test("旧录像恢复坠机音乐，并尊重禁用彩蛋音乐开关", () => {
	const f = fixture();
	const audio = new EventTarget();
	Object.assign(audio, { src: "https://game.test/normal.mp3", loop: true, playbackRate: 1, pause() {} });
	window.ui.backgroundMusic = audio;
	window.lib.config.background_music = "music_random";
	window.lib.config.disable_easter_egg_music = true;
	f.game.videoContent.fullscreenpop = () => 31;
	f.game.resumeBackgroundMusic = () => {};
	global.document = { baseURI: "https://game.test/" };
	installReplayPresentation();
	assert.equal(f.game.videoContent.fullscreenpop(f.player, ["坠机"]), 31);
	assert.equal(audio.src, "https://game.test/normal.mp3");
	window.lib.config.disable_easter_egg_music = false;
	f.game.videoContent.fullscreenpop(f.player, ["坠机"]);
	assert.match(audio.src, /laoda\/zhuiji\.mp3$/);
	audio.dispatchEvent(new Event("ended"));
	assert.equal(audio.src, "https://game.test/normal.mp3");
});

test("旧录像恢复洛克曲目排队，禁用时不调度", () => {
	const f = fixture();
	window.ui.backgroundMusic = new EventTarget();
	f.game.players = [{ name: "sanmei_luoke" }];
	window.lib.config.background_music = "music_random";
	window.lib.config.disable_easter_egg_music = true;
	installReplayPresentation();
	window.__exporterStartReplayMusic();
	assert.equal(window._status.tempMusic, undefined);
	window.lib.config.disable_easter_egg_music = false;
	window.__exporterStartReplayMusic();
	assert.match(window._status.tempMusic, /luoke\/battle[123]\.mp3$/);
	window.ui.backgroundMusic.dispatchEvent(new Event("ended"));
	assert.equal(window._status.tempMusic, undefined);
});

test("禁用彩蛋时跳过切换前的暂停和 loop 状态，普通音乐持续播放", () => {
	for (const nativeHandler of [false, true]) {
		const f = fixture();
		const audio = new EventTarget();
		Object.assign(audio, {
			src: "https://game.test/normal.mp3",
			currentTime: 12,
			paused: false,
			loop: true,
			playbackRate: 1,
			pause() {
				this.paused = true;
			},
		});
		window.ui.backgroundMusic = audio;
		window.lib.config.disable_easter_egg_music = true;
		window.lib.config.background_music = "music_default";
		f.game.resumeBackgroundMusic = () => {
			audio.paused = false;
		};
		if (nativeHandler)
			f.game.videoContent.backgroundMusic = state => {
				audio.paused = state.paused;
			};
		installReplayPresentation();
		const normal = { src: audio.src, offset: 12, paused: true, loop: false, rate: 1, easterEgg: false };
		const egg = { ...normal, src: "https://game.test/extension/SanmeiKill/audio/background/laoda/zhuiji.mp3", paused: false, easterEgg: true };
		window._status.event = {
			parent: {
				video: [
					{ type: "backgroundMusic", delay: 0, content: normal },
					{ type: "backgroundMusic", delay: 0, content: egg },
				],
			},
		};
		f.game.videoContent.backgroundMusic(normal);
		window._status.event.parent.video.shift();
		f.game.videoContent.backgroundMusic(normal);
		window._status.event.parent.video.shift();
		f.game.videoContent.backgroundMusic(egg);
		assert.equal(audio.paused, false);
		assert.equal(audio.currentTime, 12);
		assert.equal(audio.loop, true);
		// 真正独立的暂停必须保留，不能因之后才发生的彩蛋而恢复播放。
		window._status.event.parent.video = [{ type: "backgroundMusic", delay: 1500, content: egg }];
		f.game.videoContent.backgroundMusic(normal);
		assert.equal(audio.paused, true);
	}
});

test("内置音乐按当前部署资源根路径重定位，自定义外部地址保持原样", () => {
	for (const nativeHandler of [false, true]) {
		const f = fixture();
		const audio = new EventTarget();
		Object.assign(audio, {
			src: "",
			paused: true,
			pause() {
				this.paused = true;
			},
		});
		window.ui.backgroundMusic = audio;
		window.lib.assetURL = "https://local.test/deploy/assets/";
		global.document = { baseURI: "https://local.test/deploy/" };
		f.game.resumeBackgroundMusic = () => {
			audio.paused = false;
		};
		if (nativeHandler)
			f.game.videoContent.backgroundMusic = state => {
				audio.src = state.src;
			};
		installReplayPresentation();
		const state = { offset: 0, paused: false, loop: false, rate: 1, easterEgg: false };
		f.game.videoContent.backgroundMusic({ ...state, src: "audio/background/music_default.mp3", builtin: true });
		assert.equal(audio.src, "https://local.test/deploy/assets/audio/background/music_default.mp3");
		f.game.videoContent.backgroundMusic({
			...state,
			src: "https://record.test/old/extension/SanmeiKill/audio/background/laoda/zhuiji.mp3",
			easterEgg: true,
		});
		assert.equal(audio.src, "https://local.test/deploy/assets/extension/SanmeiKill/audio/background/laoda/zhuiji.mp3");
		const external = "https://custom.test/extension/SanmeiKill/audio/background/custom.mp3";
		f.game.videoContent.backgroundMusic({ ...state, src: external, builtin: false });
		assert.equal(audio.src, external);
	}
});
