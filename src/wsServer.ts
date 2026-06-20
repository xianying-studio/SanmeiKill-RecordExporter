import { WebSocketServer, WebSocket } from "ws";
import http from "http";

/** 网页端 → 工具：发送录像数据，启动导出。 */
export interface VideoMessage {
	type: "video";
	/** base64(JSON.stringify(录像记录对象))，与网页端 lib.init.encode 一致。 */
	payload: string;
	/** 建议的导出文件名（不含扩展名）。 */
	filename?: string;
}

/** 工具 → 网页端：进度。 */
export interface ProgressMessage {
	type: "progress";
	/** 阶段标识：save/cache/load/record/encode。 */
	stage: string;
	/** 进度百分比 0-100。 */
	percent: number;
}

/** 工具 → 网页端：完成。 */
export interface DoneMessage {
	type: "done";
}

/** 工具 → 网页端：出错。 */
export interface ErrorMessage {
	type: "error";
	message: string;
}

export type OutboundMessage = ProgressMessage | DoneMessage | ErrorMessage;

/** WS 服务回调。 */
export interface WsServerHandlers {
	/** 收到网页端发来的录像数据。 */
	onVideo: (msg: VideoMessage, conn: ExporterConnection) => void;
	/** 客户端断开。 */
	onClose?: () => void;
}

/**
 * 一个已建立的导出连接的对外接口（向网页端汇报进度/完成/错误）。
 */
export interface ExporterConnection {
	progress(stage: string, percent: number): void;
	done(): void;
	error(message: string): void;
	close(): void;
}

/**
 * 在 127.0.0.1:<port> 启动本地 WebSocket 服务，仅允许来源等于 allowedOrigin 的连接。
 *
 * 安全要点：
 * - host 绑定 127.0.0.1，不监听外部网卡。
 * - 握手阶段校验 Origin 头必须等于 allowedOrigin（payload 中的 baseurl），
 *   防止任意网页连接本地端口窃取/触发导出。
 *
 * 浏览器兼容要点（Private Network Access，PNA）：
 * - 现代 Chromium（Chrome/Edge）在 HTTPS 公网页面访问 127.0.0.1 这类本地地址时，
 *   会先发一个 CORS 式 preflight（OPTIONS，带 Access-Control-Request-Private-Network: true）。
 *   本地服务必须回 `Access-Control-Allow-Private-Network: true` 才允许后续 WebSocket 握手。
 * - 因此这里使用显式的 http.Server：对 OPTIONS preflight 应答 PNA 头；对 upgrade 做 Origin 校验后升级；
 *   并额外在 101 握手响应里也带上 PNA 头，兼容不同 Chromium 版本的实现差异。
 *
 * @param port 监听端口
 * @param allowedOrigin 允许的来源（如 https://sanmei-kill.xianying.online）
 * @param handlers 回调
 * @returns 关闭服务的函数
 */
export function startWsServer(port: number, allowedOrigin: string, handlers: WsServerHandlers): () => void {
	const wss = new WebSocketServer({ noServer: true });

	// 给 101 握手响应也加上 PNA 头（覆盖「不走独立 OPTIONS、直接在升级响应要求 PNA」的实现）。
	wss.on("headers", headers => {
		headers.push("Access-Control-Allow-Private-Network: true");
	});

	const server = http.createServer((req, res) => {
		const origin = req.headers.origin;
		// PNA preflight：浏览器在真正的 WebSocket 握手前发 OPTIONS 探测。
		if (req.method === "OPTIONS") {
			if (origin === allowedOrigin) {
				res.writeHead(204, {
					"Access-Control-Allow-Origin": origin,
					"Access-Control-Allow-Private-Network": "true",
					"Access-Control-Allow-Methods": "GET, OPTIONS",
					"Access-Control-Allow-Headers": (req.headers["access-control-request-headers"] as string) || "*",
					Vary: "Origin",
				});
				res.end();
			} else {
				console.warn("[record-exporter] 拒绝来源不匹配的 preflight：", origin, "≠", allowedOrigin);
				res.writeHead(403);
				res.end("Forbidden origin");
			}
			return;
		}
		// 其余普通 HTTP 请求：本服务只用于 WebSocket 升级。
		res.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Upgrade Required");
	});

	// 升级阶段：仅放行来源匹配的连接。
	server.on("upgrade", (req, socket, head) => {
		const origin = req.headers.origin;
		if (origin !== allowedOrigin) {
			console.warn("[record-exporter] 拒绝来源不匹配的连接：", origin, "≠", allowedOrigin);
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, ws => {
			wss.emit("connection", ws, req);
		});
	});

	wss.on("connection", (socket: WebSocket) => {
		const conn = makeConnection(socket);
		socket.on("message", (data: Buffer | string) => {
			let msg: any;
			try {
				msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
			} catch {
				return;
			}
			if (msg && msg.type === "video" && typeof msg.payload === "string") {
				handlers.onVideo(msg as VideoMessage, conn);
			}
		});
		socket.on("close", () => {
			handlers.onClose?.();
		});
	});

	server.on("error", err => {
		console.error("[record-exporter] 本地服务错误：", err);
	});

	server.listen(port, "127.0.0.1");

	return () => {
		try {
			wss.close();
		} catch {}
		try {
			server.close();
		} catch {}
	};
}

/** 把底层 socket 包装为对外的汇报接口。 */
function makeConnection(socket: WebSocket): ExporterConnection {
	const send = (obj: OutboundMessage) => {
		if (socket.readyState === WebSocket.OPEN) {
			try {
				socket.send(JSON.stringify(obj));
			} catch {}
		}
	};
	return {
		progress: (stage, percent) => send({ type: "progress", stage, percent }),
		done: () => send({ type: "done" }),
		error: message => send({ type: "error", message }),
		close: () => {
			try {
				socket.close();
			} catch {}
		},
	};
}
