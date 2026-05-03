/**
 * @astroflare/test-utils — first-class in-memory implementations of every host
 * interface (§5.2), plus canonical fixture projects.
 *
 * The brief calls this out as the substrate of all framework-layer testing —
 * not a quick stub. These implementations match the same semantics the
 * Cloudflare host gives the framework, so anything that passes against
 * `createTestHost()` should also pass against the real host modulo
 * Cloudflare-specific behaviour (workerd globals, hibernation, etc.).
 */
export * from "./memory-storage.js";
export * from "./map-coordinator.js";
export * from "./memory-image-service.js";
export * from "./inproc-executor.js";
export * from "./stubs.js";
export * from "./test-host.js";
export * from "./in-memory-services.js";

export const TEST_UTILS_VERSION = "0.0.0";
