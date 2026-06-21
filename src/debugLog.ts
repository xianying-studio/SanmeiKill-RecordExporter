import { app } from "electron";
import fs from "fs";
import path from "path";

/**
 * 简易文件日志（仅 :debug 构建启用）。
 *
 * 本工具无前台界面、由协议拉起，控制台输出用户看不到，排障困难。
 * 因此在 debug 构建下把关键生命周期与离屏窗口的 console/错误统一落到一个日志文件，
 * 便于用户复现后把文件发回定位问题。
 *
 * 是否启用由构建期写入的 dist/buildFlags.json 决定：
 * - `pnpm build:ts:debug` / `pnpm dist:*:debug`（EXPORTER_BUILD_DEBUG=1）→ debug=true，写日志；
 * - 普通生产构建 → debug=false，dlog 为空操作，不创建任何文件。
 *
 * 日志路径：<userData>/record-exporter.log（每次进程启动覆盖写）。
 */

/** 是否为 debug 构建（读取 dist/buildFlags.json，缺失或读取失败均视为关闭）。 */
const DEBUG_ENABLED: boolean = (() => {
	try {
		// buildFlags.json 与编译后的 debugLog.js 同处 dist 根目录。
		const flags = require("./buildFlags.json");
		return !!(flags && flags.debug);
	} catch {
		return false;
	}
})();

let logFile: string | null = null;
let inited = false;

function ensureInited(): void {
	if (inited) {
		return;
	}
	inited = true;
	try {
		const dir = app.getPath("userData");
		logFile = path.join(dir, "record-exporter.log");
		fs.writeFileSync(logFile, `=== record-exporter 日志 启动 ===\n`, "utf-8");
	} catch {
		logFile = null;
	}
}

/** 写一行日志（仅 debug 构建生效）。 */
export function dlog(...parts: unknown[]): void {
	if (!DEBUG_ENABLED) {
		return;
	}
	ensureInited();
	const line = parts.map(p => (typeof p === "string" ? p : safeStringify(p))).join(" ");
	console.log("[record-exporter]", line);
	if (!logFile) {
		return;
	}
	try {
		fs.appendFileSync(logFile, `[${timestamp()}] ${line}\n`, "utf-8");
	} catch {
		/* ignore */
	}
}

/** 返回日志文件路径（仅 debug 构建非空）。 */
export function getLogFilePath(): string | null {
	if (!DEBUG_ENABLED) {
		return null;
	}
	ensureInited();
	return logFile;
}

function timestamp(): string {
	const d = new Date();
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function safeStringify(v: unknown): string {
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}
