import { mkdtemp, open, copyFile, readFile, rm, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 编码结果始终分块落盘；支持 MP4 回填文件头，不在渲染进程拼接整段视频。 */
export class VideoFile {
	private handle: FileHandle | undefined;
	bytes = 0;
	private constructor(
		private readonly directory: string,
		readonly path: string,
		handle: FileHandle
	) {
		this.handle = handle;
	}

	static async create(): Promise<VideoFile> {
		const directory = await mkdtemp(path.join(tmpdir(), "sanmei-video-"));
		const filePath = path.join(directory, "video.mp4");
		try {
			return new VideoFile(directory, filePath, await open(filePath, "w+"));
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}

	async write(position: number, data: Uint8Array): Promise<void> {
		if (!this.handle) throw new Error("视频文件已关闭");
		if (
			!Number.isSafeInteger(position) ||
			position < 0 ||
			!(data instanceof Uint8Array) ||
			data.byteLength > 1024 * 1024 ||
			!Number.isSafeInteger(position + data.byteLength)
		) {
			throw new Error("视频写入块无效");
		}
		let offset = 0;
		while (offset < data.byteLength) {
			const { bytesWritten } = await this.handle.write(data, offset, data.byteLength - offset, position + offset);
			if (!bytesWritten) throw new Error("视频写入未能完成");
			offset += bytesWritten;
		}
		this.bytes = Math.max(this.bytes, position + data.byteLength);
	}

	async finish(): Promise<this> {
		await this.handle?.close();
		this.handle = undefined;
		return this;
	}

	async copyTo(destination: string): Promise<void> {
		if (this.handle) throw new Error("视频尚未完成封装");
		await copyFile(this.path, destination, constants.COPYFILE_FICLONE);
	}

	/** 只供需要内存结果的兼容调用方使用；正式导出直接 copyTo。 */
	async read(): Promise<Buffer> {
		if (this.handle) throw new Error("视频尚未完成封装");
		return readFile(this.path);
	}

	async dispose(): Promise<void> {
		await this.finish();
		await rm(this.directory, { recursive: true, force: true });
	}
}
