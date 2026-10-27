const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planAudioClips } = require("../dist/audioTimeline");

test("彩蛋插播会切断原 BGM，结束恢复曲目时不重叠播放", () => {
	const clips = planAudioClips(
		[
			{ t: 0, url: "normal", loop: true },
			{ t: 2, url: "effect", loop: false },
			{ t: 5, url: "", loop: true },
			{ t: 5, url: "easter-egg", loop: true },
			{ t: 9, url: "normal", loop: true, offset: 1.5 },
		],
		20
	);
	assert.deepEqual(
		clips.map(({ url, t, end, offset }) => [url, t, end, offset]),
		[
			["normal", 0, 5, undefined],
			["effect", 2, 20, undefined],
			["easter-egg", 5, 9, undefined],
			["normal", 9, 20, 1.5],
		]
	);
});

test("同一时刻的换曲重设不会叠出重复音乐，关闭 BGM 后保持静音", () => {
	const clips = planAudioClips(
		[
			{ t: 0, url: "a", loop: true },
			{ t: 0, url: "a", loop: true },
			{ t: 4, url: "", loop: true },
		],
		10
	);
	assert.equal(clips.length, 1);
	assert.equal(clips[0].end, 4);
});
