const { execFile } = require("node:child_process");
const { readdir, open } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const machoMagic = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

async function collectBinaries(directory) {
	const binaries = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) binaries.push(...(await collectBinaries(file)));
		else if (entry.isFile()) {
			const handle = await open(file, "r");
			try {
				const header = Buffer.alloc(4);
				const { bytesRead } = await handle.read(header, 0, 4, 0);
				if (bytesRead === 4 && machoMagic.has(header.readUInt32BE())) binaries.push(file);
			} finally {
				await handle.close();
			}
		}
	}
	return binaries;
}

async function verifyMacApp(app) {
	// --deep 仅用于校验；签名本身由 @electron/osx-sign 从内到外逐层完成。
	await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
	const binaries = await collectBinaries(app);
	if (!binaries.length) throw new Error(`应用未包含 Mach-O 可执行文件：${app}`);
	// 额外扫描 Resources 等位置，防止可执行文件只被当作普通资源封入外层签名。
	for (const binary of binaries) await execute("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", binary]);
	console.log(`macOS 签名验证通过：${app}，共 ${binaries.length} 个二进制文件`);
	return binaries;
}

async function findApps(output) {
	if (output.endsWith(".app")) return [output];
	const apps = [];
	for (const entry of await readdir(output, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("mac")) continue;
		for (const bundle of await readdir(path.join(output, entry.name), { withFileTypes: true })) {
			if (bundle.isDirectory() && bundle.name.endsWith(".app")) apps.push(path.join(output, entry.name, bundle.name));
		}
	}
	if (!apps.length) throw new Error(`找不到待验证的 macOS 应用：${output}`);
	return apps;
}

module.exports = { verifyMacApp };
if (require.main === module) {
	(async () => {
		if (!process.argv[2]) throw new Error("用法：node scripts/verifyMacSignatures.cjs <应用路径或构建输出目录>");
		for (const app of await findApps(path.resolve(process.argv[2]))) await verifyMacApp(app);
	})().catch(error => {
		console.error(error.stderr || error.message);
		process.exitCode = 1;
	});
}
