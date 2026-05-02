import { type FileStat, type Storage, contentHash } from "@astroflare/core";

/**
 * In-memory Storage suitable for unit tests.
 *
 * Files live under user-visible paths in `files`. The content-addressed cache
 * lives in a separate map (`cache`) keyed by hash. The two namespaces are
 * isolated: `cacheRead`/`cacheWrite` cannot see, or be seen by, `read`/`write`.
 *
 * `glob` supports the subset of patterns we use in fixtures: literal segments,
 * `*` (no slash), and `**` (any depth). Negation is not supported.
 */
export class MemoryStorage implements Storage {
  private readonly files = new Map<string, Uint8Array>();
  private readonly cache = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(normalize(path));
    if (!f) throw new ENOENT(path);
    return f;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(normalize(path), bytes);
  }

  async stat(path: string): Promise<FileStat | null> {
    const f = this.files.get(normalize(path));
    if (!f) return null;
    return { size: f.byteLength, hash: contentHash(f) };
  }

  async *glob(pattern: string): AsyncIterable<string> {
    const re = globToRegex(pattern);
    for (const k of [...this.files.keys()].sort()) {
      if (re.test(k)) yield k;
    }
  }

  async cacheRead(hash: string): Promise<Uint8Array | null> {
    return this.cache.get(hash) ?? null;
  }

  async cacheWrite(hash: string, bytes: Uint8Array): Promise<void> {
    this.cache.set(hash, bytes);
  }

  // Test helpers ----------------------------------------------------------

  /** Synchronous helper for fixture setup. */
  writeSync(path: string, bytes: Uint8Array | string): void {
    const buf = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    this.files.set(normalize(path), buf);
  }

  has(path: string): boolean {
    return this.files.has(normalize(path));
  }

  fileCount(): number {
    return this.files.size;
  }

  cacheSize(): number {
    return this.cache.size;
  }
}

class ENOENT extends Error {
  constructor(path: string) {
    super(`ENOENT: no such file: ${path}`);
    this.name = "ENOENT";
  }
}

function normalize(p: string): string {
  // Collapse leading "./", remove trailing slash. Don't resolve "..": tests should
  // not try to escape the workspace root.
  let out = p.replace(/^\.\//, "");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function globToRegex(pattern: string): RegExp {
  // Translate a small glob subset to a regex. We support: literal chars, `*`
  // (any chars except `/`), `**` (any chars including `/`), `?` (single char
  // except `/`), and `{a,b}` alternation.
  let i = 0;
  let out = "";
  while (i < pattern.length) {
    const c = pattern.charAt(i);
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 2;
        if (pattern[i] === "/") i++; // consume the trailing slash so `**/` matches zero segments
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
        i++;
      } else {
        const alts = pattern
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&"));
        out += `(?:${alts.join("|")})`;
        i = end + 1;
      }
    } else if (".+^$()|[]\\".includes(c)) {
      out += `\\${c}`;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return new RegExp(`^${out}$`);
}
