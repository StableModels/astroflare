import { describe, expect, it } from "vitest";
import { MemoryImageService } from "./memory-image-service.js";

describe("MemoryImageService", () => {
	it("returns metadata for a registered path", async () => {
		const svc = new MemoryImageService();
		svc.set("/src/assets/logo.png", {
			src: "/_aflare/asset/src/assets/logo.png",
			width: 200,
			height: 100,
			format: "png",
		});
		const m = await svc.getMetadata("/src/assets/logo.png");
		expect(m.width).toBe(200);
		expect(m.height).toBe(100);
		expect(m.format).toBe("png");
	});

	it("throws for unregistered paths", async () => {
		const svc = new MemoryImageService();
		await expect(svc.getMetadata("/missing.png")).rejects.toThrow(/no metadata/);
	});

	it("size reflects registered count", () => {
		const svc = new MemoryImageService();
		expect(svc.size).toBe(0);
		svc.set("/a.png", { src: "/a", width: 1, height: 1 });
		svc.set("/b.png", { src: "/b", width: 1, height: 1 });
		expect(svc.size).toBe(2);
	});
});
