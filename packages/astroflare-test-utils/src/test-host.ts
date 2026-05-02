import type { Clock, HmrMessage, Host, Logger, Transport } from "@astroflare/core";
import { InProcessExecutor } from "./inproc-executor.js";
import { MapCoordinator } from "./map-coordinator.js";
import { MemoryStorage } from "./memory-storage.js";

export class FixedClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export class CapturingLogger implements Logger {
  readonly events: { name: string; fields: Record<string, unknown> }[] = [];
  event(name: string, fields: Record<string, unknown>): void {
    this.events.push({ name, fields });
  }
}

/** A no-op Transport. The real implementation lives in @astroflare/host-cloudflare. */
export class NullTransport implements Transport {
  acceptHmrSocket(_req: Request): Response {
    return new Response("HMR not supported in test host", { status: 501 });
  }
  async broadcastHmr(_workspaceId: string, _msg: HmrMessage): Promise<void> {}
}

export interface TestHost extends Host {
  storage: MemoryStorage;
  executor: InProcessExecutor;
  coordinator: MapCoordinator;
  clock: FixedClock;
  logger: CapturingLogger;
}

/**
 * Build a fully wired in-memory Host suitable for framework-layer tests.
 * Used by Layer A unit tests in every phase from Phase 1 onward.
 */
export function createTestHost(opts: { startTime?: number } = {}): TestHost {
  return {
    storage: new MemoryStorage(),
    executor: new InProcessExecutor(),
    coordinator: new MapCoordinator(),
    transport: new NullTransport(),
    clock: new FixedClock(opts.startTime ?? 0),
    logger: new CapturingLogger(),
  };
}
