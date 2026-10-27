import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, type RawData } from "ws";
import { GamePackage } from "./gamePackage";

export interface ReceivedPackage {
	gamePackage: GamePackage;
	cleanup(): Promise<void>;
}

/** 浏览器每次只发送一个 1 MiB 块，写盘后确认；包体不进入 JSON/base64 或整包 Buffer。 */
export async function receivePackage(socket: WebSocket, signal?: AbortSignal): Promise<ReceivedPackage> {
	const directory = await mkdtemp(path.join(tmpdir(), "sanmei-export-package-"));
	const filename = path.join(directory, "game.smk");
	const file = await open(filename, "wx");
	let closed = false;
	const cleanup = async () => {
		if (!closed) {
			closed = true;
			await file.close();
		}
		await rm(directory, { recursive: true, force: true });
	};
	try {
		await new Promise<void>((resolve, reject) => {
			let received = 0;
			let writing = false;
			let done = false;
			const finish = (error?: Error) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				socket.off("message", onMessage);
				socket.off("close", onClose);
				signal?.removeEventListener("abort", onClose);
				if (error) reject(error);
				else resolve();
			};
			const onClose = () => finish(new Error("包体传输已取消或连接已断开"));
			const timer = setTimeout(() => finish(new Error("等待本地包体超时")), 10 * 60 * 1000);
			const onMessage = (raw: RawData, isBinary: boolean) => {
				if (isBinary) {
					const data = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
					if (writing || data.length > 1024 * 1024 || received + data.length > 16 * 1024 ** 3)
						return finish(new Error("包体传输块大小或顺序无效"));
					writing = true;
					void file
						.writeFile(data)
						.then(() => {
							writing = false;
							if (done) return;
							received += data.length;
							socket.send(JSON.stringify({ type: "package-ack", received }));
						})
						.catch(error => finish(error));
				} else {
					let message;
					try {
						message = JSON.parse(raw.toString());
					} catch {
						return;
					}
					if (message.type === "package-end") {
						if (writing || message.totalBytes !== received || received < 44) return finish(new Error("包体传输长度不一致"));
						finish();
					}
				}
			};
			socket.on("message", onMessage);
			socket.once("close", onClose);
			signal?.addEventListener("abort", onClose, { once: true });
			if (signal?.aborted || socket.readyState !== WebSocket.OPEN) return onClose();
			socket.send(JSON.stringify({ type: "package-request", chunkBytes: 1024 * 1024 }));
		});
		await file.close();
		closed = true;
		return { gamePackage: await GamePackage.open(filename, signal), cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}
