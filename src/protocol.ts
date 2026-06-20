/**
 * 协议 URL 解析。
 *
 * 网页端拉起的协议格式：
 *   sanmeikillrecordexporter://<base64(JSON.stringify({ baseurl, listenport }))>
 *
 * 其中 base64 由网页端 lib.init.encode 生成（标准 base64 of UTF-8 bytes），
 * Node 侧用 Buffer.from(b64, "base64").toString("utf-8") 即可还原。
 */

/** 自定义协议名（须与网页端 EXPORTER_PROTOCOL 一致）。 */
export const PROTOCOL = "sanmeikillrecordexporter";

/** 本地 WebSocket 监听端口允许范围（须与网页端一致）。 */
export const PORT_MIN = 10000;
export const PORT_MAX = 20000;

/** 解析后的协议载荷。 */
export interface ExportPayload {
	/** 调用方网页来源（如 https://sanmei-kill.xianying.online），用于 WS 来源校验与游戏加载。 */
	baseurl: string;
	/** 本地 WebSocket 监听端口。 */
	listenport: number;
}

/**
 * 从协议 URL 解析出载荷。校验失败返回 null。
 * @param url sanmeikillrecordexporter://<base64>
 */
export function parseProtocolUrl(url: string | undefined | null): ExportPayload | null {
	if (!url || typeof url !== "string") {
		return null;
	}
	const prefix = PROTOCOL + "://";
	if (!url.startsWith(prefix)) {
		return null;
	}
	// 取出 base64 主体（去掉协议前缀，并剥离可能的尾部斜杠/空白）。
	let b64 = url.slice(prefix.length).trim();
	// 某些平台会在协议 URL 末尾追加 "/"。
	b64 = b64.replace(/\/+$/, "");
	if (!b64) {
		return null;
	}

	let json: string;
	try {
		json = Buffer.from(b64, "base64").toString("utf-8");
	} catch {
		return null;
	}

	let obj: any;
	try {
		obj = JSON.parse(json);
	} catch {
		return null;
	}
	if (!obj || typeof obj !== "object") {
		return null;
	}

	const baseurl = obj.baseurl;
	const listenport = obj.listenport;

	if (!isValidBaseUrl(baseurl)) {
		return null;
	}
	if (!isValidPort(listenport)) {
		return null;
	}

	return { baseurl: normalizeOrigin(baseurl), listenport };
}

/** 校验端口是否为合法范围内的整数。 */
export function isValidPort(port: unknown): port is number {
	return typeof port === "number" && Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX;
}

/** 校验 baseurl 是否为合法的 http(s) URL。 */
export function isValidBaseUrl(baseurl: unknown): baseurl is string {
	if (typeof baseurl !== "string" || !baseurl) {
		return false;
	}
	try {
		const u = new URL(baseurl);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

/** 取 URL 的 origin（协议+主机+端口），用于来源比对与游戏加载。 */
export function normalizeOrigin(baseurl: string): string {
	try {
		return new URL(baseurl).origin;
	} catch {
		return baseurl;
	}
}
