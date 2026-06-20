/* eslint-disable */
// 构建后置步骤：拷贝非 TS 静态资源到 dist。
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");

function copy(src, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(src, dest);
	console.log("copied", path.relative(root, src), "->", path.relative(root, dest));
}

// 编码器渲染页（静态 HTML，tsc 不处理）。
copy(path.join(root, "src", "encoder", "encoder.html"), path.join(dist, "encoder", "encoder.html"));

// mediabunny 单文件 ESM bundle（供编码器页经 app:// 协议 import）。
copy(path.join(root, "node_modules", "mediabunny", "dist", "bundles", "mediabunny.mjs"), path.join(dist, "vendor", "mediabunny.mjs"));
