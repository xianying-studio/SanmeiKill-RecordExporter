export interface RenderQuality {
	readonly width: number;
	readonly height: number;
	readonly fps: number;
}

export const DEFAULT_RENDER_QUALITY: RenderQuality = Object.freeze({ width: 2560, height: 1440, fps: 120 });
export const FALLBACK_RENDER_QUALITY: RenderQuality = Object.freeze({ width: 1920, height: 1080, fps: 60 });

interface RenderQualityFallbackOptions {
	signal?: AbortSignal;
	onFallback?: (error: unknown) => void;
}

/** 优先导出 2K 120 FPS，失败后只重试一次 1080p 60 FPS；取消不触发重试。 */
export async function renderWithQualityFallback<T>(
	render: (quality: RenderQuality) => Promise<T>,
	options: RenderQualityFallbackOptions = {}
): Promise<T> {
	options.signal?.throwIfAborted();
	try {
		return await render(DEFAULT_RENDER_QUALITY);
	} catch (error) {
		if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
		options.onFallback?.(error);
		options.signal?.throwIfAborted();
		return render(FALLBACK_RENDER_QUALITY);
	}
}
