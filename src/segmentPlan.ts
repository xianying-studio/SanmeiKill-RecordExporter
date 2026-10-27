import { availableParallelism, freemem } from "node:os";

export interface SegmentRange {
	startFrame: number;
	endFrame?: number;
}

/** 这里只估算负载分配，最后一段始终播放至实际结束，绝不按估算截断录像。 */
export function estimateReplaySeconds(record: { video?: Array<{ type?: string; delay?: number; content?: unknown }> }): number {
	let milliseconds = 13000;
	for (const event of record.video || []) {
		milliseconds += Math.min(2000, Math.max(0, Number(event.delay) || 0));
		if (event.type === "delay" && typeof event.content === "number") milliseconds += Math.max(0, event.content) * 500;
	}
	return milliseconds / 1000;
}

export function defaultRenderWorkers(seconds: number): number {
	// macOS 当前链路实测单路更快，避免默认增加 VideoToolbox/纹理交接的背压。
	// 显式指定 workers 仍可使用已经验证的分段并行，其他平台按 CPU 和内存预算选择。
	if (process.platform === "darwin" || seconds < 120) return 1;
	return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2), Math.floor(freemem() / (2 * 1024 ** 3))));
}

export function planSegments(seconds: number, fps: number, workers: number): SegmentRange[] {
	if (
		!(seconds > 0) ||
		!Number.isFinite(seconds) ||
		!Number.isSafeInteger(fps) ||
		fps < 1 ||
		!Number.isSafeInteger(workers) ||
		workers < 1 ||
		workers > 8
	) {
		throw new Error("分段参数无效");
	}
	const framesPerSegment = Math.max(1, Math.ceil((seconds * fps) / workers));
	return Array.from({ length: workers }, (_, index) => ({
		startFrame: index * framesPerSegment,
		...(index + 1 < workers ? { endFrame: (index + 1) * framesPerSegment } : {}),
	}));
}
