import { app, dialog } from "electron";
import path from "path";
import { PROTOCOL, parseProtocolUrl, type ExportPayload } from "./protocol";
import { startWsServer, type ExporterConnection, type VideoMessage } from "./wsServer";

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
 * 起 WS（来源校验）→ 收到录像 → 弹保存对话框 → 离屏加载游戏 → 录制 → 写盘 → 汇报进度。
 * @param payload 协议载荷
 */
function startExport(payload: ExportPayload): void {
	let handled = false; // 一次拉起只处理一条录像
	const closeServer = startWsServer(payload.listenport, payload.baseurl, {
		onVideo: (msg, conn) => {
			if (handled) {
				return;
			}
			handled = true;
			runExport(payload, msg, conn).finally(() => {
				closeServer();
				app.quit();
			});
		},
	});
}

/**
 * 执行实际导出：弹保存对话框 → （后续）离屏录制 → 写盘。
 * @param payload 协议载荷
 * @param msg 网页端发来的录像消息
 * @param conn 向网页端汇报进度的连接
 */
async function runExport(payload: ExportPayload, msg: VideoMessage, conn: ExporterConnection): Promise<void> {
	// 1. 不可见地弹出系统保存对话框（不绑定可见窗口）。
	conn.progress("save", 0);
	const defaultName = (msg.filename || "三梅杀录像").replace(/[\\/:*?"<>|]/g, "-") + ".mp4";
	const result = await dialog.showSaveDialog({
		title: "导出录像视频",
		defaultPath: defaultName,
		filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
	});
	if (result.canceled || !result.filePath) {
		conn.error("已取消保存");
		return;
	}
	const savePath = result.filePath;

	// TODO（后续微任务）：离屏加载游戏 → 注入录像 → 原速播放 → 截帧编码 → 写入 savePath。
	console.log("[record-exporter] 保存路径：", savePath, "录像 payload 长度：", msg.payload.length);
	conn.progress("record", 0);
	// 暂以错误占位，待录制器接入后替换为真实流程。
	conn.error("录制功能尚未接入（开发中）");
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
