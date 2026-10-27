import { sharedTexture, type NativeImage, type OffscreenSharedTexture } from "electron";
import type { EncoderWindow } from "./encoder/encoderWindow";

/** 缓存只持有一帧，发送期间额外持有引用，避免换帧或取消时提前释放 GPU 纹理。 */
export class CapturedFrame {
	private references = 1;
	private constructor(
		readonly width: number,
		readonly height: number,
		private readonly bitmap?: Buffer,
		private readonly texture?: Electron.SharedTextureImported
	) {}

	static fromBitmap(image: NativeImage): CapturedFrame {
		const size = image.getSize();
		return new CapturedFrame(size.width, size.height, Buffer.from(image.toBitmap()));
	}

	static fromTexture(source: OffscreenSharedTexture): CapturedFrame {
		try {
			const texture = sharedTexture.importSharedTexture({
				textureInfo: source.textureInfo,
				allReferencesReleased: () => source.release(),
			});
			return new CapturedFrame(source.textureInfo.codedSize.width, source.textureInfo.codedSize.height, undefined, texture);
		} catch (error) {
			source.release();
			throw error;
		}
	}

	async send(encoder: EncoderWindow, timestamp: number): Promise<void> {
		if (this.references === 0) throw new Error("画面已释放");
		this.references++;
		try {
			if (this.texture) await encoder.pushSharedFrame(this.texture, timestamp);
			else await encoder.pushFrame(this.bitmap!, timestamp);
		} finally {
			this.release();
		}
	}

	release(): void {
		if (this.references > 0 && --this.references === 0) this.texture?.release();
	}
}
