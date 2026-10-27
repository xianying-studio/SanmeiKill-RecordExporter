const { createHash } = require("node:crypto");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function pack(files) {
	const manifestFiles = Object.keys(files).filter(p => p !== "/index.html");
	const manifest = {
		schema: 2,
		algorithm: "sha256",
		files: manifestFiles,
		count: manifestFiles.length,
		hashes: Object.fromEntries(manifestFiles.map(p => [p, hash(files[p])])),
	};
	const entries = Object.entries(files).map(([p, bytes]) => ({
		path: p,
		size: bytes.length,
		hash: hash(bytes),
		type: p.endsWith(".html") ? "text/html" : "application/octet-stream",
	}));
	const metadata = Buffer.from(JSON.stringify({ format: 1, app: "SanmeiKill", version: "123", manifest: JSON.stringify(manifest), entries }));
	const header = Buffer.alloc(44);
	header.write("SMKPACK1");
	header.writeUInt32BE(metadata.length, 8);
	Buffer.from(hash(metadata), "hex").copy(header, 12);
	return Buffer.concat([header, metadata, ...Object.values(files)]);
}
module.exports = { pack };
