import { describe, expect, it } from "vitest";
import { mimeForPath } from "./mime.js";

describe("mimeForPath", () => {
	it("returns common image types", () => {
		expect(mimeForPath("/logo.png")).toBe("image/png");
		expect(mimeForPath("/favicon.ico")).toBe("image/vnd.microsoft.icon");
		expect(mimeForPath("/photo.JPG")).toBe("image/jpeg");
		expect(mimeForPath("vector.svg")).toBe("image/svg+xml");
	});

	it("returns charset-tagged text types", () => {
		expect(mimeForPath("/index.html")).toBe("text/html;charset=utf-8");
		expect(mimeForPath("/styles.css")).toBe("text/css;charset=utf-8");
		expect(mimeForPath("/script.js")).toBe("text/javascript;charset=utf-8");
		expect(mimeForPath("/data.json")).toBe("application/json;charset=utf-8");
		expect(mimeForPath("/feed.xml")).toBe("application/xml;charset=utf-8");
	});

	it("recognises font, audio, and video extensions", () => {
		expect(mimeForPath("/font.woff2")).toBe("font/woff2");
		expect(mimeForPath("/song.mp3")).toBe("audio/mpeg");
		expect(mimeForPath("/clip.mp4")).toBe("video/mp4");
	});

	it("accepts bare extensions with or without a dot", () => {
		expect(mimeForPath("png")).toBe("image/png");
		expect(mimeForPath(".png")).toBe("image/png");
		expect(mimeForPath("HTML")).toBe("text/html;charset=utf-8");
	});

	it("falls back to application/octet-stream for unknown extensions", () => {
		expect(mimeForPath("/binary.bin")).toBe("application/octet-stream");
		expect(mimeForPath("/no-ext")).toBe("application/octet-stream");
		expect(mimeForPath("/trailing.")).toBe("application/octet-stream");
		expect(mimeForPath("")).toBe("application/octet-stream");
	});
});
