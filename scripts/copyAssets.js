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

// 构建标记：写入 dist/buildFlags.json，:debug 构建时 debug=true，生产构建为 debug=false。
// 运行时仅当 debug=true 时才会创建日志文件。
const debugBuild = process.env.EXPORTER_BUILD_DEBUG === "1";
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "buildFlags.json"), JSON.stringify({ debug: debugBuild }), "utf-8");
console.log("wrote dist/buildFlags.json debug =", debugBuild);
