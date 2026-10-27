const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { VideoFile } = require("../dist/videoFile");

test("MP4 分块写入允许回填文件头，完成后复制并清理临时文件", async () => {
	const file = await VideoFile.create();
	try {
		await file.write(0, new Uint8Array([0, 0, 0, 0]));
		await file.write(4, new Uint8Array([5, 6, 7]));
		await file.write(0, new Uint8Array([1, 2, 3, 4]));
		await file.finish();
		assert.deepEqual(await file.read(), Buffer.from([1, 2, 3, 4, 5, 6, 7]));
		assert.equal(file.bytes, 7);
		const copy = file.path + ".copy";
		await file.copyTo(copy);
		assert.deepEqual(await fs.readFile(copy), await file.read());
	} finally {
		await file.dispose();
	}
	await assert.rejects(fs.stat(file.path), { code: "ENOENT" });
});

test("超过 2GB 的文件偏移仍逐块写入，不分配整片 ArrayBuffer", async () => {
	const file = await VideoFile.create();
	try {
		const offset = 3 * 1024 ** 3;
		await file.write(offset, new Uint8Array([1, 2, 3]));
		await file.finish();
		assert.equal((await fs.stat(file.path)).size, offset + 3);
		assert.equal(file.bytes, offset + 3);
		const handle = await fs.open(file.path, "r");
		try {
			const bytes = Buffer.alloc(3);
			await handle.read(bytes, 0, 3, offset);
			assert.deepEqual(bytes, Buffer.from([1, 2, 3]));
		} finally {
			await handle.close();
		}
	} finally {
		await file.dispose();
	}
});

test("拒绝越界位置和过大的块，并可清理未完成的输出", async () => {
	const file = await VideoFile.create();
	try {
		await assert.rejects(file.write(-1, new Uint8Array(1)), /无效/);
		await assert.rejects(file.write(0, new Uint8Array(1024 * 1024 + 1)), /无效/);
	} finally {
		await file.dispose();
	}
	await assert.rejects(fs.stat(file.path), { code: "ENOENT" });
});
