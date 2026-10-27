const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WebSocketServer, WebSocket } = require("ws");
const { GamePackage } = require("../dist/gamePackage");
const { receivePackage } = require("../dist/packageTransfer");
const { pack } = require("./packageFixture.cjs");
async function fixture(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smk-package-test-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return path.join(dir, "game.smk");
}
test("校验包体并按索引读取完整资源、HEAD 和 Range", async t => {
	const filename = await fixture(t);
	await fs.writeFile(filename, pack({ "/index.html": Buffer.from("<h1>offline</h1>"), "/audio/test.bin": Buffer.from("0123456789") }));
	const source = await GamePackage.open(filename);
	assert.equal(await source.response(new Request("https://offline.invalid/")).text(), "<h1>offline</h1>");
	const range = source.response(new Request("https://offline.invalid/audio/test.bin", { headers: { range: "bytes=2-5" } }));
	assert.equal(range.status, 206);
	assert.equal(await range.text(), "2345");
	assert.equal(await source.response(new Request("https://offline.invalid/audio/test.bin", { headers: { range: "bytes=-3" } })).text(), "789");
	assert.equal(source.response(new Request("https://offline.invalid/audio/test.bin", { headers: { range: "bytes=100-" } })).status, 416);
	assert.equal(source.response(new Request("https://offline.invalid/audio/test.bin", { method: "HEAD" })).headers.get("content-length"), "10");
	assert.equal(source.response(new Request("https://offline.invalid/missing")).status, 404);
});
test("拒绝元数据篡改、资源损坏和截断包体", async t => {
	const filename = await fixture(t);
	const bytes = pack({ "/index.html": Buffer.from("offline") });
	const metadataBad = Buffer.from(bytes);
	metadataBad[45] ^= 1;
	await fs.writeFile(filename, metadataBad);
	await assert.rejects(GamePackage.open(filename), /元数据校验/);
	const payloadBad = Buffer.from(bytes);
	payloadBad[payloadBad.length - 1] ^= 1;
	await fs.writeFile(filename, payloadBad);
	await assert.rejects(GamePackage.open(filename), /资源校验/);
	await fs.writeFile(filename, bytes.subarray(0, bytes.length - 1));
	await assert.rejects(GamePackage.open(filename), /越界|长度/);
});
test("按块确认并接收超过 1 MiB 的 .smk，完成后清理临时文件", async t => {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise(r => server.once("listening", r));
	t.after(() => server.close());
	const bytes = pack({ "/index.html": Buffer.from("offline"), "/data.bin": Buffer.alloc(3 * 1024 * 1024 + 17, 7) });
	const received = new Promise((resolve, reject) => server.once("connection", s => receivePackage(s).then(resolve, reject)));
	const client = new WebSocket("ws://127.0.0.1:" + server.address().port);
	t.after(() => client.close());
	const sent = new Promise((resolve, reject) =>
		client.on("message", async raw => {
			try {
				const message = JSON.parse(raw.toString());
				if (message.type === "package-request" || message.type === "package-ack") {
					const offset = message.received || 0;
					if (offset === bytes.length) {
						client.send(JSON.stringify({ type: "package-end", totalBytes: offset }));
						resolve();
					} else client.send(bytes.subarray(offset, Math.min(bytes.length, offset + 1024 * 1024)));
				}
			} catch (error) {
				reject(error);
			}
		})
	);
	const result = await received;
	await sent;
	assert.equal(
		await result.gamePackage.response(new Request("https://offline.invalid/data.bin", { headers: { range: "bytes=1048576-1048580" } })).text(),
		"\x07".repeat(5)
	);
	await result.cleanup();
	await assert.rejects(fs.stat(result.gamePackage.filename), /ENOENT/);
});
module.exports = { pack };

test("取消传输后拒绝任务并清理未完成包体", async t => {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise(r => server.once("listening", r));
	t.after(() => server.close());
	const aborter = new AbortController();
	const received = new Promise((resolve, reject) =>
		server.once("connection", socket => receivePackage(socket, aborter.signal).then(resolve, reject))
	);
	const rejected = assert.rejects(received, /取消|断开/);
	const client = new WebSocket("ws://127.0.0.1:" + server.address().port);
	t.after(() => client.close());
	client.on("message", raw => {
		const message = JSON.parse(raw.toString());
		if (message.type === "package-request") client.send(Buffer.alloc(100));
		if (message.type === "package-ack") aborter.abort();
	});
	await rejected;
});
