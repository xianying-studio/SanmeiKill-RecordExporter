import { app, dialog } from "electron";
import path from "path";
import { PROTOCOL, parseProtocolUrl, type ExportPayload } from "./protocol";

/**
 * 三梅杀录像导出工具 —— 主进程入口。
 *
 * 设计要点：
 * - 本工具无前台界面：被网页端通过 sanmeikillrecordexporter://<base64> 协议拉起，
 *   在后台离屏（offscreen）加载游戏、播放录像并录制为 MP4，全程不向用户展示游戏画面。
 * - 唯一可见的系统级交互是「保存对话框」（选择导出路径与文件名）。
 * - 本工具仅供协议拉起使用：若用户直接打开（双击），弹原生提示并退出。
 *
 * 当前进度：单实例锁 + 协议注册 + 协议 URL 解析 + 「直接打开」拦截。
 * WebSocket 服务 / 离屏录制等在后续微任务实现。
 */

/** 是否已收到任何有效的协议拉起（用于判断「直接打开」并提示退出）。 */
let receivedProtocolUrl = false;

// —— 单实例锁 ——
// 通过协议二次拉起时，应复用已运行实例（Windows 经 second-instance 传 argv）。
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
	app.quit();
}

// 注册为该协议的默认处理程序（开发期 process.defaultApp 下需带 execPath/argv 参数）。
if (process.defaultApp) {
	if (process.argv.length >= 2) {
		app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
	}
} else {
	app.setAsDefaultProtocolClient(PROTOCOL);
}

/**
 * 处理一个协议 URL（sanmeikillrecordexporter://<base64>）。
 * 解析成功则启动导出流程；解析失败则忽略（视为无效拉起）。
 * @param url 协议 URL
 */
function handleProtocolUrl(url: string | undefined | null): void {
	const payload = parseProtocolUrl(url);
	if (!payload) {
		if (url) {
			console.warn("[record-exporter] 无效的协议拉起，已忽略：", url);
		}
		return;
	}
	receivedProtocolUrl = true;
	startExport(payload);
}

/**
 * 启动一次导出流程。
 * 后续微任务：起 WS（来源校验）→ 弹保存对话框 → 离屏加载游戏 → 录制 → 写盘 → 汇报进度。
 * @param payload 协议载荷
 */
function startExport(payload: ExportPayload): void {
	// TODO（后续微任务）：启动 WebSocket 服务与离屏录制流程。
	console.log("[record-exporter] 启动导出：", payload);
}

/**
 * 从命令行参数数组中提取协议 URL（Windows 下协议 URL 以参数形式传入）。
 * @param argv 进程参数数组
 */
function getProtocolUrlFromArgv(argv: string[]): string | undefined {
	return argv.find(arg => arg.startsWith(PROTOCOL + "://"));
}

/** 提示「请通过三梅杀唤起」并退出。 */
function warnDirectLaunchAndQuit(): void {
	dialog.showMessageBoxSync({
		type: "info",
		title: "三梅杀录像导出工具",
		message: "请通过三梅杀的「导出录像」功能唤起本应用使用。",
		buttons: ["确定"],
	});
	app.quit();
}

// Windows：二次实例启动（含协议拉起）时，主实例通过 second-instance 接收 argv。
app.on("second-instance", (_event, argv) => {
	handleProtocolUrl(getProtocolUrlFromArgv(argv));
});

// macOS：通过协议 URL 启动时，主实例通过 open-url 接收 URL（可能在 whenReady 后异步到达）。
app.on("open-url", (event, urlStr) => {
	event.preventDefault();
	handleProtocolUrl(urlStr);
});

app.whenReady().then(() => {
	// 首次启动即可能携带协议 URL（Windows 经 argv）。
	handleProtocolUrl(getProtocolUrlFromArgv(process.argv));

	// macOS 的 open-url 可能稍晚到达；给一个短暂的宽限期再判断是否为「直接打开」。
	setTimeout(() => {
		if (!receivedProtocolUrl) {
			warnDirectLaunchAndQuit();
		}
	}, 500);
});

// 无可见窗口：所有窗口关闭后直接退出（macOS 也退出，因本工具非常驻）。
app.on("window-all-closed", () => {
	app.quit();
});
