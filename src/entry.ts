// HTTP 头仅允许字节字符；Electron 默认 UA 可能带有中文 productName。
const { app } = require("electron");
app.userAgentFallback = app.userAgentFallback.replace(/[^\x20-\x7e]/g, "");
require("./main");
