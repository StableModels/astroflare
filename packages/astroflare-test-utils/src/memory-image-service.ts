/**
 * In-memory `ImageService` for tests + framework-side coverage. Stores
 * a hand-supplied metadata table and serves it back when the framework
 * asks (compile time, mostly).
 *
 * The brief leaves real image processing — PNG/JPEG header parsing,
 * format conversion, DPR variants — to the host layer (Cloudflare
 * Images binding) per §3 Tier 1. This stub keeps every framework-side
 * test honest about that boundary.
 */
import type { ImageMetadata, ImageService } from "@astroflare/core";

export class MemoryImageService implements ImageService {
	readonly #table = new Map<string, ImageMetadata>();

	/** Pre-seed metadata. Tests call this before exercising the compiler. */
	set(path: string, meta: ImageMetadata): void {
		this.#table.set(path, meta);
	}

	async getMetadata(path: string): Promise<ImageMetadata> {
		const found = this.#table.get(path);
		if (!found) {
			throw new Error(`MemoryImageService: no metadata registered for ${path}`);
		}
		return found;
	}

	/** Test introspection — count of registered images. */
	get size(): number {
		return this.#table.size;
	}
}
