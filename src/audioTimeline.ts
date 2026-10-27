export interface AudioTimelineEvent {
	t: number;
	url: string;
	loop: boolean;
	offset?: number;
	rate?: number;
}
export interface AudioClip extends AudioTimelineEvent {
	end: number;
}

/** BGM 是一条播放器时间线，换曲或暂停必须停止上一段，音效仍可重叠。 */
export function planAudioClips(events: AudioTimelineEvent[], duration: number): AudioClip[] {
	const ordered = events.map((event, order) => ({ ...event, order })).sort((a, b) => a.t - b.t || a.order - b.order);
	const result: AudioClip[] = [];
	let music: AudioClip | undefined;
	for (const event of ordered) {
		if (event.t >= duration) break;
		if (event.loop && music) music.end = Math.max(music.t, event.t);
		if (!event.url) {
			if (event.loop) music = undefined;
			continue;
		}
		const clip = { ...event, t: Math.max(0, event.t), end: duration };
		result.push(clip);
		if (event.loop) music = clip;
	}
	return result.filter(clip => clip.end > clip.t);
}
