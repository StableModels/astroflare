import type { Coordinator, HmrMessage, ModuleNode, Subscription } from "@astroflare/core";
import { ModuleGraph } from "@astroflare/preview/module-graph";

type Handler = (m: HmrMessage) => void;

/**
 * In-memory Coordinator. Wraps a ModuleGraph and a pub/sub registry.
 *
 * `onFileChanged` updates the node's hash (preserving its declared deps) and
 * publishes an HMR `update` message on the workspace's `hmr` channel. Subscribers
 * are notified synchronously in registration order.
 */
export class MapCoordinator implements Coordinator {
  readonly graph = new ModuleGraph();
  private readonly subscribers = new Map<string, Set<Handler>>();

  /**
   * Path-only file-change notification. The deps of the node are not changed
   * here — call `graphPut` to update deps after a recompile.
   */
  async onFileChanged(path: string, hash: string): Promise<void> {
    const existing = this.graph.get(path);
    const deps = existing?.deps ?? [];
    this.graph.set(path, hash, deps);
    const acceptedBy = [...this.graph.invalidate(path)];
    await this.publish("hmr", { type: "update", path, hash, acceptedBy });
  }

  async graphGet(path: string): Promise<ModuleNode | null> {
    return this.graph.get(path) ?? null;
  }

  async graphPut(node: ModuleNode): Promise<void> {
    this.graph.set(node.path, node.hash, node.deps);
  }

  async publish(channel: string, message: HmrMessage): Promise<void> {
    const set = this.subscribers.get(channel);
    if (!set) return;
    // Snapshot to avoid mutation-during-iteration bugs if a handler unsubscribes.
    for (const h of [...set]) h(message);
  }

  subscribe(channel: string, handler: Handler): Subscription {
    let bucket = this.subscribers.get(channel);
    if (!bucket) {
      bucket = new Set();
      this.subscribers.set(channel, bucket);
    }
    const channelBucket = bucket;
    channelBucket.add(handler);
    return {
      unsubscribe: () => {
        channelBucket.delete(handler);
        if (channelBucket.size === 0) this.subscribers.delete(channel);
      },
    };
  }

  // Test helpers ----------------------------------------------------------

  subscriberCount(channel: string): number {
    return this.subscribers.get(channel)?.size ?? 0;
  }
}
