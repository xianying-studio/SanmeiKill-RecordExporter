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
