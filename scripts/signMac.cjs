const { signAsync } = require("@electron/osx-sign");
const { verifyMacApp } = require("./verifyMacSignatures.cjs");

module.exports = async options => {
	// electron-builder 25 不支持直接用 identity: "-" 选中 ad-hoc，交给标准签名库逐层重签。
	// 保留明确传入的证书身份；当前 CI 没有 Developer ID，使用 ad-hoc 校验代码完整性。
	await signAsync({ ...options, identity: options.identity || "-", identityValidation: false });
	await verifyMacApp(options.app);
};
