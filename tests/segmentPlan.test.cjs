const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planSegments, estimateReplaySeconds } = require("../dist/segmentPlan");

test("分段边界是相邻整数帧，最后一段不根据估算时长截断", () => {
	const segments = planSegments(845.78, 120, 4);
	assert.equal(segments[0].startFrame, 0);
	for (let index = 1; index < segments.length; index++) assert.equal(segments[index].startFrame, segments[index - 1].endFrame);
	assert.equal(segments.at(-1).endFrame, undefined);
	assert.ok(segments.every(segment => Number.isSafeInteger(segment.startFrame)));
});

test("负值与非法并行度不会生成空帧或无限任务", () => {
	for (const args of [
		[-1, 120, 4],
		[30, 0, 4],
		[30, 120, 0],
		[30, 120, 99],
	])
		assert.throws(() => planSegments(...args));
	assert.equal(estimateReplaySeconds({ video: [{ delay: 5000 }, { delay: -1 }] }), 15);
});
