import { WebSocketServer, WebSocket } from "ws";

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
 * @param port 监听端口
 * @param allowedOrigin 允许的来源（如 https://sanmei-kill.xianying.online）
 * @param handlers 回调
 * @returns 关闭服务的函数
 */
export function startWsServer(port: number, allowedOrigin: string, handlers: WsServerHandlers): () => void {
	const wss = new WebSocketServer({
		host: "127.0.0.1",
		port,
		// 握手校验：仅放行来源匹配的连接。
		verifyClient: (info, cb) => {
			const origin = info.origin || info.req.headers.origin;
			if (origin === allowedOrigin) {
				cb(true);
			} else {
				console.warn("[record-exporter] 拒绝来源不匹配的连接：", origin, "≠", allowedOrigin);
				cb(false, 403, "Forbidden origin");
			}
		},
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

	wss.on("error", err => {
		console.error("[record-exporter] WebSocket 服务错误：", err);
	});

	return () => {
		try {
			wss.close();
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
