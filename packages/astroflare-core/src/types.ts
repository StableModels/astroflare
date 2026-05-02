/**
 * Public types and host-capability interfaces for Astroflare.
 *
 * Astroflare's framework packages depend ONLY on these interfaces. Cloudflare-specific
 * implementations live in @astroflare/host-cloudflare. See section 5.2 of the design brief.
 */

// ---------------------------------------------------------------------------
// Storage — files + content-addressed cache
// ---------------------------------------------------------------------------

export interface FileStat {
  size: number;
  /** SHA-256 hex of the file contents, truncated to 16 chars. */
  hash: string;
}

export interface Storage {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Yields paths matching a glob pattern. */
  glob(pattern: string): AsyncIterable<string>;
  stat(path: string): Promise<FileStat | null>;
  cacheRead(hash: string): Promise<Uint8Array | null>;
  cacheWrite(hash: string, bytes: Uint8Array): Promise<void>;
}

// ---------------------------------------------------------------------------
// Executor — isolated unit of work
// ---------------------------------------------------------------------------

export type TaskBundle = {
  /** Key in `modules` that is the entry point. */
  mainModule: string;
  /** Virtual filesystem of source modules. Values are JavaScript source. */
  modules: Record<string, string>;
  /** Names of host-side RPC services to expose to the task. */
  capabilities?: string[];
};

export interface Executor {
  /** Run `task` in a fresh isolate. No caching. */
  runOnce<R>(task: TaskBundle, input: unknown): Promise<R>;
  /**
   * Run `task` with content-addressed reuse. The factory is invoked at most once
   * per `id`; subsequent calls reuse the prepared bundle.
   */
  runCached<R>(id: string, taskFactory: () => TaskBundle, input: unknown): Promise<R>;
}

// ---------------------------------------------------------------------------
// Coordinator — long-lived per-workspace state and event hub
// ---------------------------------------------------------------------------

export interface ModuleNode {
  path: string;
  hash: string;
  /** Resolved paths of modules this module imports. */
  deps: string[];
  /** Resolved paths of modules that import this one. Maintained by the coordinator. */
  importers: string[];
}

export type HmrMessage =
  | { type: "update"; path: string; hash: string; acceptedBy: string[] }
  | { type: "prune"; paths: string[] }
  | { type: "error"; path: string; message: string; stack?: string }
  | { type: "full-reload"; reason: string };

export interface Subscription {
  unsubscribe(): void;
}

export interface Coordinator {
  /** Notify the coordinator that a file was written. Updates the module graph. */
  onFileChanged(path: string, hash: string): Promise<void>;
  graphGet(path: string): Promise<ModuleNode | null>;
  graphPut(node: ModuleNode): Promise<void>;
  publish(channel: string, message: HmrMessage): Promise<void>;
  subscribe(channel: string, handler: (m: HmrMessage) => void): Subscription;
}

// ---------------------------------------------------------------------------
// Transport — browser-facing
// ---------------------------------------------------------------------------

export interface Transport {
  /**
   * Accept an HMR WebSocket upgrade request. The returned Response should be
   * the WebSocket upgrade response (status 101 with the server-side socket pair).
   */
  acceptHmrSocket(req: Request): Response;
  broadcastHmr(workspaceId: string, msg: HmrMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// Clock + Logger — trivially stubbable
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
}

export interface Logger {
  event(name: string, fields: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Aggregate host capabilities passed to createApp().
// ---------------------------------------------------------------------------

export interface Host {
  storage: Storage;
  executor: Executor;
  coordinator: Coordinator;
  transport: Transport;
  clock: Clock;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// User-facing config (Astro-shaped). Tier-0 surface only.
// ---------------------------------------------------------------------------

export type AstroflareOutput = "static" | "server" | "hybrid";

export interface AstroflareConfig {
  site?: string;
  base?: string;
  output?: AstroflareOutput;
  srcDir?: string;
  publicDir?: string;
  outDir?: string;
  integrations?: AstroflareIntegration[];
  trailingSlash?: "always" | "never" | "ignore";
}

export interface AstroflareIntegration {
  name: string;
  hooks?: Partial<{
    "config:setup": (ctx: { config: AstroflareConfig }) => void | Promise<void>;
    "build:start": (ctx: { config: AstroflareConfig }) => void | Promise<void>;
    "build:done": (ctx: { config: AstroflareConfig }) => void | Promise<void>;
  }>;
}
