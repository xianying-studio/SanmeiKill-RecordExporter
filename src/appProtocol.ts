import { app, protocol, type ProtocolResponse } from "electron";
import fs from "fs";
import path from "path";

/**
 * 自定义 app:// 协议。
 *
 * 用途：为「编码器」渲染窗口提供本地静态资源（encoder.html 与 mediabunny 的 ESM 单文件 bundle）。
 *
 * 为什么不用 file://：
 * - Chromium 对 `<script type="module">` 严格校验 MIME，file:// 下 .mjs 常被识别为
 *   application/octet-stream 而被拒绝加载（实测「Failed to fetch dynamically imported module」）。
 * - 自定义 standard+secure 协议可由 protocol.handle 返回带正确 content-type 的响应，模块正常加载。
 */

/** app 协议名。 */
export const APP_SCHEME = "app";

/** app 协议的 host（仅作占位，统一为 bundle）。 */
const APP_HOST = "bundle";

/** 资源根目录：编译产物 dist 目录（encoder.html、vendor/mediabunny.mjs 等均在此）。 */
function resourceRoot(): string {
	// 测试场景可用 EXPORTER_RESOURCE_ROOT 覆盖。
	if (process.env.EXPORTER_RESOURCE_ROOT) {
		return process.env.EXPORTER_RESOURCE_ROOT;
	}
	// 打包后 app.getAppPath() 指向 asar 内应用根；dist 为 tsc 输出目录。
	return path.join(app.getAppPath(), "dist");
}

const MIME: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".json": "application/json",
	".css": "text/css",
	".map": "application/json",
};

/** 在 app ready 之前调用：声明 app 协议为标准、安全协议。 */
export function registerAppScheme(): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: APP_SCHEME,
			privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
		},
	]);
}

/** 在 app ready 之后调用：挂载 app 协议的文件处理器。 */
export function handleAppScheme(): void {
	protocol.handle(APP_SCHEME, async request => {
		const url = new URL(request.url);
		// 仅服务约定 host，避免越权读取。
		if (url.hostname !== APP_HOST) {
			return new Response("forbidden host", { status: 403 });
		}
		// 规整路径，禁止越界（.. 穿越）。
		const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
		const root = resourceRoot();
		const filePath = path.join(root, rel);
		if (!filePath.startsWith(root)) {
			return new Response("forbidden path", { status: 403 });
		}
		try {
			const data = await fs.promises.readFile(filePath);
			const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
			if (process.env.EXPORTER_DEBUG) {
				console.log("[app://]", rel, "->", data.length, type);
			}
			return new Response(new Uint8Array(data), { headers: { "content-type": type, "cache-control": "no-store" } });
		} catch {
			if (process.env.EXPORTER_DEBUG) {
				console.log("[app://] 404", rel, "(", filePath, ")");
			}
			return new Response("not found: " + rel, { status: 404 });
		}
	});
}

/** 构造 app 协议下的资源 URL。 */
export function appUrl(relPath: string): string {
	return `${APP_SCHEME}://${APP_HOST}/${relPath.replace(/^\/+/, "")}`;
}
