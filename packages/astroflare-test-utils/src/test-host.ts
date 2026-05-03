/**
 * Convenience: build a fully-wired in-memory `Host` for framework tests.
 *
 * Tests typically want individual handles to assert on (e.g. inspect the
 * coordinator's graph), so the returned object is the host *plus* the
 * concrete impls — pull whichever fields you need.
 */
import type { Host } from "@astroflare/core";
import { InProcessExecutor } from "./inproc-executor.js";
import { MapCoordinator } from "./map-coordinator.js";
import { MemoryImageService } from "./memory-image-service.js";
import { MemoryCache, MemorySite } from "./memory-site.js";
import { MemoryTransport, StubClock, StubLogger } from "./stubs.js";

export interface TestHost extends Host {
	site: MemorySite;
	cache: MemoryCache;
	executor: InProcessExecutor;
	coordinator: MapCoordinator;
	transport: MemoryTransport;
	clock: StubClock;
	logger: StubLogger;
	imageService: MemoryImageService;
	dispose(): Promise<void>;
}

export function createTestHost(): TestHost {
	const clock = new StubClock();
	const logger = new StubLogger(clock);
	const site = new MemorySite();
	const cache = new MemoryCache();
	const coordinator = new MapCoordinator();
	const transport = new MemoryTransport();
	const executor = new InProcessExecutor();
	const imageService = new MemoryImageService();

	return {
		site,
		cache,
		executor,
		coordinator,
		transport,
		clock,
		logger,
		imageService,
		async dispose() {
			await executor.dispose();
		},
	};
}
