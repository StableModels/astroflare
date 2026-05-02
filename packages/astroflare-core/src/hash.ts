import { createHash } from "node:crypto";

/**
 * Content-address hash. SHA-256 hex, truncated to 16 chars.
 *
 * NOTE: in framework code we use this for cache keys only — never as a security
 * primitive. The truncation matches §9.4 of the design brief.
 */
export function contentHash(input: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(typeof input === "string" ? Buffer.from(input, "utf8") : input);
  return h.digest("hex").slice(0, 16);
}

export function combinedHash(parts: readonly (string | Uint8Array)[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(typeof p === "string" ? Buffer.from(p, "utf8") : p);
    h.update(Buffer.from([0])); // separator so [a,b] != [ab]
  }
  return h.digest("hex").slice(0, 16);
}
