import { combinedHash, contentHash, createApp } from "@astroflare/core";
import { describe, expect, it } from "vitest";
import { createTestHost } from "../src/test-host.js";

describe("createApp", () => {
  it("composes host + config and exposes them", async () => {
    const host = createTestHost();
    const app = await createApp({
      config: { site: "https://example.com", output: "static" },
      host,
    });
    expect(app.config.site).toBe("https://example.com");
    expect(app.host).toBe(host);
  });

  it("invokes config:setup integration hook", async () => {
    const host = createTestHost();
    let called = 0;
    await createApp({
      config: {
        integrations: [
          {
            name: "test",
            hooks: {
              "config:setup": () => {
                called++;
              },
            },
          },
        ],
      },
      host,
    });
    expect(called).toBe(1);
  });

  it("Phase 0/1: app.fetch is a stable not-yet-implemented stub (501)", async () => {
    const host = createTestHost();
    const app = await createApp({ config: {}, host });
    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(501);
  });
});

describe("contentHash", () => {
  it("produces a 16-char hex string", () => {
    const h = contentHash("hello");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for identical inputs and differs for different inputs", () => {
    expect(contentHash("a")).toBe(contentHash("a"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });

  it("combinedHash uses a separator so [a,b] != [ab]", () => {
    expect(combinedHash(["a", "b"])).not.toBe(combinedHash(["ab"]));
  });
});
