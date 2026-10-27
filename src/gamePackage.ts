import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";

interface PackageEntry {
	path: string;
	size: number;
	hash: string;
	type: string;
	offset: number;
}

/** 不解包到目录，校验后按索引从 .smk 文件分段读取，内存开销固定。 */
export class GamePackage {
	private constructor(
		readonly filename: string,
		readonly version: string,
		readonly manifest: string,
		private entries: Map<string, PackageEntry>
	) {}

	static async open(filename: string, signal?: AbortSignal): Promise<GamePackage> {
		const file = await open(filename, "r");
		try {
			const size = (await file.stat()).size;
			const header = Buffer.alloc(44);
			if ((await file.read(header, 0, header.length, 0)).bytesRead !== 44 || header.toString("ascii", 0, 8) !== "SMKPACK1") {
				throw new Error("无效的 .smk 包体头");
			}
			const metadataLength = header.readUInt32BE(8);
			if (metadataLength < 1 || metadataLength > 8 * 1024 * 1024 || 44 + metadataLength > size) throw new Error("包体元数据长度无效");
			const bytes = Buffer.alloc(metadataLength);
			if ((await file.read(bytes, 0, metadataLength, 44)).bytesRead !== metadataLength) throw new Error("包体元数据不完整");
			if (!createHash("sha256").update(bytes).digest().equals(header.subarray(12))) throw new Error("包体元数据校验失败");
			const metadata = JSON.parse(bytes.toString("utf8"));
			if (metadata?.format !== 1 || metadata.app !== "SanmeiKill" || typeof metadata.version !== "string" || !Array.isArray(metadata.entries)) {
				throw new Error("包体格式不受支持");
			}
			const manifest = JSON.parse(metadata.manifest);
			if (
				manifest?.schema !== 2 ||
				manifest.algorithm !== "sha256" ||
				!Array.isArray(manifest.files) ||
				manifest.count !== manifest.files.length
			) {
				throw new Error("包体资源清单无效");
			}
			const allowed = new Set<string>(manifest.files.map(normalizePath));
			if (allowed.size !== manifest.files.length || allowed.has("/index.html")) throw new Error("包体清单包含重复文件");
			allowed.add("/index.html");
			const entries = new Map<string, PackageEntry>();
			let offset = 44 + metadataLength;
			for (const entry of metadata.entries) {
				const path = normalizePath(entry.path);
				if (
					!allowed.has(path) ||
					entries.has(path) ||
					!Number.isSafeInteger(entry.size) ||
					entry.size < 0 ||
					!/^[a-f0-9]{64}$/i.test(entry.hash)
				) {
					throw new Error("包体文件索引无效：" + path);
				}
				if (typeof entry.type !== "string" || /[\r\n]/.test(entry.type)) throw new Error("包体资源类型无效");
				if (
					path !== "/index.html" &&
					(manifest.hashes?.[entry.path] !== entry.hash ||
						(manifest.sizes?.[entry.path] != null && manifest.sizes[entry.path] !== entry.size))
				) {
					throw new Error("包体文件与清单不一致：" + path);
				}
				entries.set(path, { ...entry, path, offset });
				offset += entry.size;
				if (!Number.isSafeInteger(offset) || offset > size) throw new Error("包体文件越界");
			}
			if (entries.size !== allowed.size || offset !== size) throw new Error("包体文件数量或总长度不一致");
			// 每个资源流式校验；损坏包体不得部分启用或悄悄回源下载。
			for (const entry of entries.values()) {
				signal?.throwIfAborted();
				const hash = createHash("sha256");
				if (entry.size) {
					for await (const chunk of createReadStream(filename, { start: entry.offset, end: entry.offset + entry.size - 1, signal }))
						hash.update(chunk);
				}
				if (hash.digest("hex") !== entry.hash.toLowerCase()) throw new Error("包体资源校验失败：" + entry.path);
			}
			return new GamePackage(filename, metadata.version, metadata.manifest, entries);
		} finally {
			await file.close();
		}
	}

	response(request: Request): Response {
		const url = new URL(request.url);
		if (url.pathname === "/version") return new Response(this.version);
		if (url.pathname === "/cache-manifest.json") return new Response(this.manifest, { headers: { "content-type": "application/json" } });
		let path: string;
		try {
			path = normalizePath(url.pathname === "/" ? "/index.html" : url.pathname);
		} catch {
			return new Response(null, { status: 400 });
		}
		const entry = this.entries.get(path);
		if (!entry) return new Response("包体中不存在该资源", { status: 404 });
		if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
		const headers: Record<string, string> = { "content-type": entry.type || mimeType(path), "accept-ranges": "bytes" };
		let start = 0;
		let end = entry.size - 1;
		let status = 200;
		const range = request.headers.get("range");
		if (range) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416 });
			start = match[1] ? Number(match[1]) : Math.max(0, entry.size - Number(match[2]));
			end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= entry.size) {
				return new Response(null, { status: 416, headers: { "content-range": `bytes */${entry.size}` } });
			}
			status = 206;
			headers["content-range"] = `bytes ${start}-${end}/${entry.size}`;
		}
		headers["content-length"] = String(Math.max(0, end - start + 1));
		const body =
			request.method === "HEAD" || !entry.size
				? null
				: Readable.toWeb(createReadStream(this.filename, { start: entry.offset + start, end: entry.offset + end }));
		return new Response(body as ReadableStream<Uint8Array> | null, { status, headers });
	}
}

function normalizePath(path: unknown): string {
	if (typeof path !== "string") throw new Error("资源路径无效");
	const normalized = path.startsWith("/") ? path : "/" + path;
	const decoded = decodeURIComponent(normalized);
	if (!/^\/[\S]+$/.test(normalized) || /[\\?#]/.test(decoded) || decoded.split("/").some(part => part === "." || part === ".."))
		throw new Error("资源路径无效");
	return decoded;
}

function mimeType(path: string): string {
	if (/\.m?js$/.test(path)) return "text/javascript";
	if (path.endsWith(".html")) return "text/html";
	if (path.endsWith(".css")) return "text/css";
	return "application/octet-stream";
}
