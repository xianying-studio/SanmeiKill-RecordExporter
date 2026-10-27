import {
	Input,
	FilePathSource,
	FilePathTarget,
	MP4,
	Output,
	Mp4OutputFormat,
	EncodedPacketSink,
	EncodedPacket,
	EncodedVideoPacketSource,
	EncodedAudioPacketSource,
} from "mediabunny";
import type { RecordingStats } from "./recorder";

export interface RenderedSegment {
	path: string;
	stats: RecordingStats;
}

/** 只重封装编码包；视频按全局帧位置拼接，完整音轨只取最后一个进程，避免接缝重启 BGM。 */
export async function mergeSegments(
	segments: RenderedSegment[],
	destination: string,
	fps: number,
	signal?: AbortSignal,
	onProgress?: (percent: number) => void
): Promise<number> {
	const inputs: Input[] = [];
	let output: Output | undefined;
	try {
		let expectedStart = 0;
		for (const segment of segments) {
			if (
				segment.stats.startFrame !== expectedStart ||
				segment.stats.frames <= 0 ||
				segment.stats.endFrame !== segment.stats.startFrame + segment.stats.frames
			)
				throw new Error("分段之间存在缺帧或重叠");
			expectedStart = segment.stats.endFrame;
			inputs.push(new Input({ formats: [MP4], source: new FilePathSource(segment.path, { maxCacheSize: 8 * 1024 * 1024 }) }));
		}
		const videoTracks = await Promise.all(inputs.map(input => input.getPrimaryVideoTrack()));
		const firstVideo = videoTracks[0];
		if (!firstVideo) throw new Error("分段缺少视频轨道");
		const config = await firstVideo.getDecoderConfig();
		if (!config) throw new Error("分段缺少解码配置");
		const videoCodec = await firstVideo.getCodec();
		if (!videoCodec) throw new Error("分段视频编码不受支持");
		const video = new EncodedVideoPacketSource(videoCodec);
		const audioTrack = await inputs[inputs.length - 1].getPrimaryAudioTrack();
		const audioCodec = await audioTrack?.getCodec();
		if (audioTrack && !audioCodec) throw new Error("完整音轨编码不受支持");
		const audio = audioCodec ? new EncodedAudioPacketSource(audioCodec) : undefined;
		output = new Output({
			format: new Mp4OutputFormat({ fastStart: false }),
			target: new FilePathTarget(destination, { chunkSize: 1024 * 1024 }),
		});
		output.addVideoTrack(video, { frameRate: fps });
		if (audio) output.addAudioTrack(audio);
		await output.start();
		let writtenFrames = 0;
		for (let index = 0; index < segments.length; index++) {
			const track = videoTracks[index];
			if (!track) throw new Error("分段缺少视频轨道");
			const nextConfig = await track.getDecoderConfig();
			if (
				!nextConfig ||
				nextConfig.codec !== config.codec ||
				nextConfig.codedWidth !== config.codedWidth ||
				nextConfig.codedHeight !== config.codedHeight ||
				!Buffer.from((nextConfig.description as ArrayBuffer) || new ArrayBuffer(0)).equals(
					Buffer.from((config.description as ArrayBuffer) || new ArrayBuffer(0))
				)
			)
				throw new Error("分段编码配置不一致，无法无损拼接");
			let count = 0;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				signal?.throwIfAborted();
				if (count === 0 && packet.type !== "key") throw new Error("分段首帧不是关键帧");
				const shifted = new EncodedPacket(
					packet.data,
					packet.type,
					segments[index].stats.startFrame / fps + packet.timestamp,
					packet.duration
				);
				await video.add(shifted, count === 0 ? { decoderConfig: nextConfig } : undefined);
				count++;
				writtenFrames++;
				if (writtenFrames % 600 === 0) onProgress?.((90 * writtenFrames) / expectedStart);
			}
			if (count !== segments[index].stats.frames) throw new Error("分段编码帧数不完整");
		}
		if (audio && audioTrack) {
			const decoderConfig = await audioTrack.getDecoderConfig();
			if (!decoderConfig) throw new Error("完整音轨缺少解码配置");
			let first = true;
			for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
				signal?.throwIfAborted();
				await audio.add(packet, first ? { decoderConfig } : undefined);
				first = false;
			}
		}
		await output.finalize();
		onProgress?.(100);
		return writtenFrames;
	} catch (error) {
		await output?.cancel().catch(() => {});
		throw error;
	} finally {
		for (const input of inputs) input.dispose();
	}
}
