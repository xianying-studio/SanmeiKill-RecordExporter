/** 仅修复离屏录像的展示；旧包体的身份模式在 _status.video 时会跳过中央死亡身份。 */
export function installReplayPresentation(): boolean {
	const w = window as any;
	const { game, lib, ui, _status } = w;
	if (!game?.videoContent || !lib?.config || !ui?.arena || !_status?.video) return false;
	if (game.__exporterPresentationInstalled) return true;
	game.__exporterPresentationInstalled = true;
	// 新录像保存通用播放器状态，未来新增彩蛋也走同一回放入口。
	const backgroundMusic = game.videoContent.backgroundMusic;
	game.videoContent.backgroundMusic = (state: any) => {
		const audio = ui.backgroundMusic;
		if (!audio || !state || (state.easterEgg && lib.config.disable_easter_egg_music) || lib.config.background_music === "music_off") return;
		if (state.paused && lib.config.disable_easter_egg_music) {
			for (let event = _status.event, depth = 0; event && depth < 50; event = event.parent, depth++) {
				if (!Array.isArray(event.video)) continue;
				for (const next of event.video) {
					if (next.type !== "backgroundMusic" || next.delay > 0) break;
					if (next.content?.easterEgg) return;
					if (!next.content?.paused) break;
				}
				break;
			}
		}
		if (typeof backgroundMusic === "function") return backgroundMusic(state);
		audio.removeEventListener("ended", game.playBackgroundMusic);
		audio.pause();
		audio.loop = !!state.loop;
		audio.playbackRate = state.rate > 0 ? state.rate : 1;
		const src = state.src ? new URL(state.src, document.baseURI).href : "";
		if (audio.src !== src) audio.src = src;
		audio.currentTime = Math.max(0, state.offset || 0);
		if (state.paused) audio.pause();
		else if (src) game.resumeBackgroundMusic();
	};
	if (!w.__exporterHasMusicEvents) {
		const enabled = () => ui.backgroundMusic && !lib.config.disable_easter_egg_music && lib.config.background_music !== "music_off";
		const fullscreenpop = game.videoContent.fullscreenpop;
		if (typeof fullscreenpop === "function")
			game.videoContent.fullscreenpop = function (player: any, content: any) {
				const result = fullscreenpop.call(this, player, content);
				if (content?.[0] !== (lib.translate.sanmei_zhuiji || "坠机") || !enabled()) return result;
				const audio = ui.backgroundMusic;
				const src = new URL(`${lib.assetURL || ""}extension/SanmeiKill/audio/background/laoda/zhuiji.mp3`, document.baseURI).href;
				const previous = audio.__exporterInterruptedMusic;
				const interrupted = audio.src === src && previous ? previous : { src: audio.src, loop: audio.loop, rate: audio.playbackRate };
				previous?.cleanup?.();
				const cleanup = () => {
					audio.removeEventListener("ended", restore, true);
					audio.removeEventListener("error", restore, true);
					delete audio.__exporterInterruptedMusic;
				};
				const restore = (event: Event) => {
					if (audio.src !== src) return;
					event.stopImmediatePropagation();
					cleanup();
					audio.pause();
					audio.loop = interrupted.loop;
					audio.playbackRate = interrupted.rate;
					if (lib.config.background_music === "music_off") return;
					audio.src = interrupted.src;
					audio.currentTime = 0;
					game.resumeBackgroundMusic();
				};
				audio.__exporterInterruptedMusic = { ...interrupted, cleanup };
				audio.addEventListener("ended", restore, true);
				audio.addEventListener("error", restore, true);
				audio.pause();
				audio.loop = false;
				audio.playbackRate = 1;
				audio.src = src;
				audio.currentTime = 0;
				game.resumeBackgroundMusic();
				return result;
			};
		let luokeScheduled = false;
		w.__exporterStartReplayMusic = () => {
			if (
				luokeScheduled ||
				!enabled() ||
				_status._aozhan ||
				!game.players?.some((player: any) => [player.name, player.name1, player.name2].includes("sanmei_luoke"))
			)
				return;
			luokeScheduled = true;
			const music = `ext:SanmeiKill/audio/background/luoke/${["battle1", "battle2", "battle3"][Math.floor(Math.random() * 3)]}.mp3`;
			_status.tempMusic = music;
			ui.backgroundMusic.addEventListener(
				"ended",
				() => {
					if (_status.tempMusic === music) delete _status.tempMusic;
				},
				{ once: true }
			);
		};
	}
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

	// 旧录像只保存五谷弹窗标题；用真实 drawCard 事件中的卡牌 ID 恢复选牌者，不从标题猜测。
	const cardDialog = game.videoContent.cardDialog;
	if (typeof cardDialog === "function")
		game.videoContent.cardDialog = function (content: any) {
			const result = cardDialog.call(this, content);
			if (Array.isArray(content) && content[0] === (lib.translate.wugu || "五谷丰登")) {
				const dialog = ui.dialogs?.find((item: any) => item.videoId === content[2]);
				if (dialog) dialog.__exporterDraft = true;
			}
			return result;
		};
	const drawCard = game.videoContent.drawCard;
	if (typeof drawCard === "function")
		game.videoContent.drawCard = function (player: any, cards: any) {
			const result = drawCard.call(this, player, cards);
			if (!player?.getName || !Array.isArray(cards)) return result;
			for (const dialog of ui.dialogs || []) {
				if (!dialog.__exporterDraft || !Array.isArray(dialog.buttons)) continue;
				for (const info of cards) {
					const id = info?.[4];
					if (id == null) continue;
					const index = dialog.buttons.findIndex((button: any) => String(button.link?.cardid) === String(id));
					if (index < 0) continue;
					const button = dialog.buttons[index];
					game.createButtonCardsetion(player.getName(true), button);
					dialog.buttons.splice(index, 1);
				}
			}
			return result;
		};
	return true;
}
