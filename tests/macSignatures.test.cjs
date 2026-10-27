const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, copyFile, rm } = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { verifyMacApp } = require("../scripts/verifyMacSignatures.cjs");
const execute = promisify(execFile);

async function makeApp(app, identifier) {
	await mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
	await copyFile("/usr/bin/true", path.join(app, "Contents/MacOS/main"));
	await writeFile(
		path.join(app, "Contents/Info.plist"),
		`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>main</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`
	);
}

test("签名校验覆盖嵌套程序和 Resources 中未签名的 Mach-O，拒绝损坏包体", { skip: process.platform !== "darwin" }, async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "sanmei-sign-test-"));
	try {
		const app = path.join(directory, "Example.app");
		const helper = path.join(app, "Contents/Frameworks/Helper.app");
		await makeApp(app, "online.xianying.sign-test");
		await makeApp(helper, "online.xianying.sign-test.helper");
		for (const bundle of [helper, app]) await execute("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", bundle]);
		assert.equal((await verifyMacApp(app)).length, 2);

		const resource = path.join(app, "Contents/Resources/extra");
		await mkdir(path.dirname(resource), { recursive: true });
		await copyFile("/usr/bin/true", resource);
		await execute("/usr/bin/codesign", ["--remove-signature", resource]);
		await execute("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
		// 外层签名正常仍不代表资源目录中的二进制已签名，额外扫描必须捕获它。
		await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
		await assert.rejects(verifyMacApp(app), error => error.stderr?.includes("code object is not signed at all"));

		await execute("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", resource]);
		await execute("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
		assert.equal((await verifyMacApp(app)).length, 3);
		await writeFile(path.join(helper, "Contents/Info.plist"), "tampered");
		await assert.rejects(verifyMacApp(app));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
