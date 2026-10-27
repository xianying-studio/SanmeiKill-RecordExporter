/** 仅修复离屏录像的展示；旧包体的身份模式在 _status.video 时会跳过中央死亡身份。 */
export function installReplayPresentation(): boolean {
	const w = window as any;
	const { game, lib, ui, _status } = w;
	if (!game?.videoContent || !lib?.config || !ui?.arena || !_status?.video) return false;
	if (game.__exporterPresentationInstalled) return true;
	game.__exporterPresentationInstalled = true;
	lib.config.link_style2 = "chain";
	ui.arena.classList.remove("nolink");

	const showDeathIdentity = (player: any) => {
		if (!player?.classList?.contains("dead") || !["identity", "doudizhu"].includes(lib.config.mode)) return;
		const identity = player.node?.identity?.dataset?.color;
		const key = player.special_identity || `${identity}2`;
		const text = lib.config.mode === "doudizhu" ? ({ zhu: "地主", fan: "农民" } as Record<string, string>)[identity] : lib.translate[key];
		if (typeof text !== "string" || !text) return;
		let node = player.node.dieidentity;
		if (!node) {
			node = ui.create.div(".damage.dieidentity", text, player);
			ui.refresh(node);
			player.node.dieidentity = node;
		}
		node.textContent = text;
		node.style.opacity = "1";
		if (text === "野心家") node.style.fontSize = "40px";
		// 与普通对局一致，反向旋转文字，使它在卡牌翻至背面后仍能正向显示。
		const transform = player.style.transform || "";
		node.style.transform = transform.includes("rotateY") ? "rotateY(180deg)" : transform.includes("rotateX") ? "rotateX(180deg)" : "";
	};
	const wrap = (name: string) => {
		const original = game.videoContent[name];
		if (typeof original !== "function") return;
		game.videoContent[name] = function (player: any, ...args: any[]) {
			const result = original.call(this, player, ...args);
			if (result && typeof result.then === "function")
				return result.then((value: any) => {
					showDeathIdentity(player);
					return value;
				});
			showDeathIdentity(player);
			return result;
		};
	};
	for (const name of ["die", "setIdentity", "showIdentity", "identityText", "identityColor"]) wrap(name);
	for (const player of Object.values(game.playerMap || {})) showDeathIdentity(player);
	return true;
}
