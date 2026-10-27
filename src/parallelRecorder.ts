import { mkdtemp, copyFile, stat, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordOffscreenToFile, type RecordOptions, type RecordingStats } from "./recorder";
import { mergeSegments, type RenderedSegment } from "./mergeSegments";
import { defaultRenderWorkers, planSegments } from "./segmentPlan";
import { app } from "electron";

export interface ParallelRecordOptions extends RecordOptions {
	estimatedSeconds: number;
	workers?: number;
	serialFallback?: boolean;
}

export async function recordParallelToFile(opts: ParallelRecordOptions, destination: string): Promise<number> {
	const workers = opts.workers ?? defaultRenderWorkers(opts.estimatedSeconds);
	if (workers === 1 || opts.renderMode !== "frame") return recordOffscreenToFile(opts, destination);
	try {
		return await renderSegments(opts, destination, workers);
	} catch (error) {
		if (opts.signal?.aborted || (error instanceof Error && error.name === "AbortError") || opts.serialFallback === false) throw error;
		opts.onLog?.(`并行导出失败，使用同画质降低并行度重试：${String(error)}`);
		if (workers > 2) {
			try {
				return await renderSegments(opts, destination, 2);
			} catch (retryError) {
				if (opts.signal?.aborted || (retryError instanceof Error && retryError.name === "AbortError")) throw retryError;
				opts.onLog?.(`双进程重试失败：${String(retryError)}`);
			}
		}
		return recordOffscreenToFile(opts, destination);
	}
}

async function renderSegments(opts: ParallelRecordOptions, destination: string, workers: number): Promise<number> {
	const ranges = planSegments(opts.estimatedSeconds, opts.fps, workers);
	const directory = await mkdtemp(path.join(tmpdir(), "sanmei-segments-"));
	const controller = new AbortController();
	const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
	const progress = new Array(workers).fill(0);
	const clock = opts.clock ?? { epoch: Date.now(), seed: Date.now() >>> 0 };
	const ready = new Set<number>();
	let release!: () => void;
	let rejectReady!: (reason: unknown) => void;
	const allReady = new Promise<void>((resolve, reject) => {
		release = resolve;
		rejectReady = reject;
	});
	void allReady.catch(() => {});
	const onAbort = () => rejectReady(signal.reason);
	const onQuit = () => controller.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	app.on("before-quit", onQuit);
	let tasks: Array<Promise<RenderedSegment>> = [];
	try {
		opts.onLog?.(`启动 ${workers} 个独立渲染进程，分段范围：${JSON.stringify(ranges)}`);
		tasks = ranges.map(async (segment, index) => {
			const segmentPath = path.join(directory, `segment-${index}.mp4`);
			let stats: RecordingStats | undefined;
			await recordOffscreenToFile(
				{
					...opts,
					signal,
					segment,
					clock,
					includeAudio: index === workers - 1,
					injectScript: `window.__exporterSkipAudioCapture=${index !== workers - 1};\n` + opts.injectScript,
					beforeRender: async () => {
						ready.add(index);
						if (ready.size === workers) {
							opts.onLog?.("所有分段已恢复状态，同时开始并行渲染");
							release();
						}
						await allReady;
					},
					onComplete: value => {
						stats = value;
					},
					onStage: (stage, percent) => {
						if (stage === "cache" || stage === "load") opts.onStage?.(stage, percent);
					},
					onLog: message => {
						const encoded = /^encoded (\d+) frames$/.exec(message);
						if (encoded) {
							progress[index] = Number(encoded[1]);
							opts.onStage?.("record", Math.min(99, (100 * progress.reduce((a, b) => a + b, 0)) / (opts.estimatedSeconds * opts.fps)));
						} else opts.onLog?.(`[分段 ${index + 1}/${workers}] ${message}`);
					},
				},
				segmentPath
			);
			if (!stats || (segment.endFrame !== undefined && stats.endFrame !== segment.endFrame)) throw new Error("录像在分段终点之前结束");
			opts.onLog?.(`[分段 ${index + 1}/${workers}] 渲染进程 PID=${stats.rendererPid} 已完成 ${stats.frames} 帧`);
			return { path: segmentPath, stats };
		});
		const segments = await Promise.all(tasks);
		const pids = new Set(segments.map(segment => segment.stats.rendererPid));
		if (pids.size !== workers || pids.has(0)) throw new Error("分段未使用独立游戏渲染进程");
		opts.onStage?.("encode", 0);
		const merged = path.join(directory, "merged.mp4");
		const frames = await mergeSegments(segments, merged, opts.fps, signal, percent => opts.onStage?.("encode", percent));
		signal.throwIfAborted();
		await copyFile(merged, destination, constants.COPYFILE_FICLONE);
		opts.onComplete?.({ startFrame: 0, endFrame: frames, frames, rendererPid: 0 });
		opts.onLog?.(`encoded ${frames} frames`);
		return (await stat(destination)).size;
	} finally {
		controller.abort();
		signal.removeEventListener("abort", onAbort);
		app.removeListener("before-quit", onQuit);
		await Promise.allSettled(tasks);
		await rm(directory, { recursive: true, force: true });
	}
}
