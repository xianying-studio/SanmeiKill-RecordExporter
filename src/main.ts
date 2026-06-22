import { app, dialog, Menu } from "electron";
import path from "path";
import fs from "fs";
import { PROTOCOL, parseProtocolUrl, type ExportPayload } from "./protocol";
import { startWsServer, type ExporterConnection, type VideoMessage } from "./wsServer";
import { registerAppScheme, handleAppScheme } from "./appProtocol";
import { recordOffscreen } from "./recorder";
import { buildInjectScript } from "./inject";
import { dlog } from "./debugLog";

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

/** 是否正在导出（录制中临时窗口关闭不应触发整体退出）。 */
let exporting = false;

/** 录制画面尺寸（离屏窗口逻辑尺寸）。 */
const RECORD_WIDTH = 1920;
const RECORD_HEIGHT = 1080;

/**
 * 等待压缩系数：=1 表示原速录制（不压缩任何等待，观感与实际游戏一致）。
 * 历史上曾尝试 >1 压缩各类「等待」以加快导出，但实测加速后观感不佳（动画与节奏割裂），故改回原速。
 * 保留该参数与链路：若将来需要再次提速，调大此值即可（注入脚本据此压缩 videoDuration 与 lib.config.duration）。
 */
const WAIT_COMPRESS = 1;
const CAPTURE_FPS = 60;

/** 游戏 IndexedDB 数据库名与配置前缀（configprefix 固定为 noname_0.9_）。 */
const GAME_DB_NAME = "noname_0.9_data";
const GAME_CONFIG_PREFIX = "noname_0.9_";

// —— 单实例锁 ——
// 通过协议二次拉起时，应复用已运行实例（Windows 经 second-instance 传 argv）。
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
	app.quit();
}

// 放开自动播放策略：离屏录制无用户手势，否则游戏的 <audio>.play() 与音频采集
// AudioContext 会被 Chromium 自动播放策略阻塞，导致录制出的视频无声。
// 注意：离屏窗口仍设 setAudioMuted(true)，故放开自动播放不会导致主机外放。
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// 强制设备像素缩放为 1：离屏 paint 的 image.getBitmap() 返回的是「物理像素」，而 image.getSize()
// 返回「逻辑像素」。若系统显示缩放 >100%，两者不一致会导致按逻辑尺寸构造的 VideoSample 字节数不符而抛错。
// 录制为后台无界面场景，固定 1:1 既消除该不一致，也避免以更高分辨率渲染、降低开销。
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("high-dpi-support", "1");

// 移除应用菜单：本工具无前台界面，macOS 默认会在屏幕顶部显示应用菜单栏，
// 其中「View → Toggle Developer Tools」（及 ⌥⌘I 快捷键）会暴露开发者工具入口。
// 置空菜单即可去除该菜单栏与相关快捷键（Windows/Linux 亦移除窗口菜单）。
Menu.setApplicationMenu(null);

// 注册 app:// 协议（必须在 app ready 之前声明），用于编码器窗口加载本地资源与 mediabunny。
registerAppScheme();

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
	dlog("收到协议拉起, baseurl=", payload.baseurl, "listenport=", payload.listenport);
	startExport(payload);
}

/**
 * 启动一次导出流程。
 * 起 WS（来源校验）→ 收到录像 → 弹保存对话框 → 离屏加载游戏 → 录制 → 写盘 → 汇报进度。
 * @param payload 协议载荷
 */
function startExport(payload: ExportPayload): void {
	let handled = false; // 一次拉起只处理一条录像
	let finished = false; // 导出已结束（成功/失败/已退出），避免重复处理
	let aborter: AbortController | null = null; // 当前导出的取消控制器
	const closeServer = startWsServer(payload.listenport, payload.baseurl, {
		onVideo: (msg, conn) => {
			if (handled) {
				return;
			}
			handled = true;
			exporting = true;
			aborter = new AbortController();
			runExport(payload, msg, conn, aborter.signal).finally(() => {
				finished = true;
				exporting = false;
				closeServer();
				// 让最后的 WS 消息（done/error）有机会送达后再退出。
				setTimeout(() => app.quit(), 300);
			});
		},
		onClose: () => {
			// WebSocket 意外中断（如网页被关闭）：立即结束本地待运行的任务并退出残留进程。
			if (finished) {
				return;
			}
			finished = true;
			if (aborter) {
				aborter.abort();
			}
			exporting = false;
			closeServer();
			app.quit();
		},
	});
}

/**
 * 执行实际导出：弹保存对话框 → （后续）离屏录制 → 写盘。
 * @param payload 协议载荷
 * @param msg 网页端发来的录像消息
 * @param conn 向网页端汇报进度的连接
 * @param signal 取消信号：WebSocket 断开时触发，用于中止导出
 */
async function runExport(payload: ExportPayload, msg: VideoMessage, conn: ExporterConnection, signal?: AbortSignal): Promise<void> {
	// 0. 若连接已断开，直接放弃（不弹保存对话框）。
	if (signal?.aborted) {
		console.warn("[record-exporter] 连接已断开，放弃导出。");
		return;
	}
	// 1. 不可见地弹出系统保存对话框（不绑定可见窗口）。
	conn.progress("save", 0);
	const defaultName = (msg.filename || "三梅杀录像").replace(/[\\/:*?"<>|]/g, "-") + ".mp4";
	const result = await dialog.showSaveDialog({
		title: "导出录像视频",
		defaultPath: defaultName,
		filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
	});
	if (result.canceled || !result.filePath) {
		conn.error("保存已被取消");
		return;
	}
	const savePath = result.filePath;

	// 2. 解码录像 payload（base64(JSON.stringify(link))，与网页端 lib.init.encode 一致）。
	let linkJson: string;
	try {
		linkJson = Buffer.from(msg.payload, "base64").toString("utf-8");
		JSON.parse(linkJson); // 校验可解析
	} catch {
		conn.error("录像数据无效");
		return;
	}

	// 3. 离屏加载游戏、注入驱动脚本、压缩等待回放并逐帧编码为 MP4。
	dlog("开始离屏录制, savePath=", savePath, "录像 payload 长度=", msg.payload.length, "等待压缩=", WAIT_COMPRESS);
	const injectScript = buildInjectScript(linkJson, GAME_DB_NAME, GAME_CONFIG_PREFIX, WAIT_COMPRESS);
	try {
		const buffer = await recordOffscreen({
			url: payload.baseurl,
			injectScript,
			width: RECORD_WIDTH,
			height: RECORD_HEIGHT,
			fps: CAPTURE_FPS,
			speed: WAIT_COMPRESS,
			onStage: (stage, percent) => conn.progress(stage, percent),
			onLog: m => dlog(m),
			signal,
		});
		if (signal?.aborted) {
			return;
		}
		// 4. 写盘并汇报完成。
		await fs.promises.writeFile(savePath, buffer);
		dlog("录制完成, 已写盘, 字节=", buffer.length);
		conn.progress("encode", 100);
		conn.done();
	} catch (e: any) {
		dlog("录制失败:", e && e.message ? e.message : String(e));
		console.error("[record-exporter] 录制失败：", e);
		conn.error("录制失败：" + (e && e.message ? e.message : String(e)));
	}
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
	// 挂载 app:// 协议处理器（编码器窗口与 mediabunny 资源经此加载）。
	handleAppScheme();

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
// 录制过程中临时窗口的销毁不应触发退出（由导出流程结束后显式退出）。
app.on("window-all-closed", () => {
	if (!exporting) {
		app.quit();
	}
});
