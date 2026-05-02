import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

const FRAMEWORK_PACKAGES = [
  "astroflare-core",
  "astroflare-compiler",
  "astroflare-runtime",
  "astroflare-preview",
  "astroflare-build",
];

/**
 * Acceptance criterion #5 (§11): no Cloudflare-specific symbols may leak into
 * the framework packages. The host implementation is the *only* place those
 * imports may appear. If you need a capability the framework can't currently
 * express, add a method to one of the five interfaces in §5.2 — don't import
 * the binding here.
 */
describe("framework / host boundary", () => {
  it("framework src trees contain zero `cloudflare:` imports", () => {
    for (const pkg of FRAMEWORK_PACKAGES) {
      const dir = resolve(repoRoot, "packages", pkg, "src");
      const out = grepRecursive(dir, "cloudflare:");
      expect(
        out,
        `${pkg}/src referenced cloudflare: — move it to @astroflare/host-cloudflare`,
      ).toEqual([]);
    }
  });

  it("framework src trees contain zero `@cloudflare/` imports", () => {
    for (const pkg of FRAMEWORK_PACKAGES) {
      const dir = resolve(repoRoot, "packages", pkg, "src");
      const out = grepRecursive(dir, "@cloudflare/");
      expect(
        out,
        `${pkg}/src referenced @cloudflare/ — move it to @astroflare/host-cloudflare`,
      ).toEqual([]);
    }
  });
});

function grepRecursive(dir: string, needle: string): string[] {
  try {
    const out = execSync(`grep -rln --include='*.ts' -- ${shellQuote(needle)} ${shellQuote(dir)}`, {
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch (e) {
    // grep exits 1 when no matches — that's the success case.
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
