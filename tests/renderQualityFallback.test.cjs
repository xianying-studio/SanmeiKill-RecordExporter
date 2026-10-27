const { test } = require("node:test");
const assert = require("node:assert/strict");
const { renderWithQualityFallback } = require("../dist/renderQualityFallback");

test("默认 2K 120 FPS 成功时不重复导出", async () => {
	const attempts = [];
	const result = await renderWithQualityFallback(async quality => {
		const { fps } = quality;
		attempts.push(quality);
		return Buffer.from("video");
	});
	assert.equal(result.toString(), "video");
	assert.deepEqual(attempts, [{ width: 2560, height: 1440, fps: 120 }]);
});

test("2K 120 FPS 失败并清理后，只以 1080p 60 FPS 重试", async () => {
	const events = [];
	const failure = new Error("120 FPS 编码失败");
	const result = await renderWithQualityFallback(
		async quality => {
			const { fps } = quality;
			events.push(quality);
			if (fps === 120) {
				try {
					throw failure;
				} finally {
					events.push("清理120");
				}
			}
			return Buffer.from("60 FPS video");
		},
		{
			onFallback: error => {
				assert.equal(error, failure);
				events.push("回退");
			},
		}
	);
	assert.equal(result.toString(), "60 FPS video");
	assert.deepEqual(events, [{ width: 2560, height: 1440, fps: 120 }, "清理120", "回退", { width: 1920, height: 1080, fps: 60 }]);
});

test("60 FPS 再次失败时透传错误，不继续重试", async () => {
	const attempts = [];
	const fallbackError = new Error("60 FPS 编码也失败");
	await assert.rejects(
		renderWithQualityFallback(async quality => {
			const { fps } = quality;
			attempts.push(quality);
			throw fps === 120 ? new Error("120 FPS 失败") : fallbackError;
		}),
		error => error === fallbackError
	);
	assert.deepEqual(attempts, [
		{ width: 2560, height: 1440, fps: 120 },
		{ width: 1920, height: 1080, fps: 60 },
	]);
});

test("开始前取消时不运行，120 FPS 过程中取消时不回退", async () => {
	const before = new AbortController();
	before.abort();
	await assert.rejects(
		renderWithQualityFallback(async () => assert.fail("取消后不应导出"), { signal: before.signal }),
		{ name: "AbortError" }
	);
	const during = new AbortController();
	const attempts = [];
	await assert.rejects(
		renderWithQualityFallback(
			async quality => {
				const { fps } = quality;
				attempts.push(quality);
				during.abort();
				throw new Error("用户取消");
			},
			{ signal: during.signal }
		),
		/用户取消/
	);
	assert.deepEqual(attempts, [{ width: 2560, height: 1440, fps: 120 }]);
});

test("无取消信号的 AbortError 也不会重试", async () => {
	let attempts = 0;
	await assert.rejects(
		renderWithQualityFallback(async () => {
			attempts++;
			throw new DOMException("已取消", "AbortError");
		}),
		{ name: "AbortError" }
	);
	assert.equal(attempts, 1);
});
