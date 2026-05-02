import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResult } from "../../astroflare-runtime/src/render.js";
import { compileAstro } from "../src/index.js";

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "astroflare-e2e-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let fileCounter = 0;
async function compileAndImport(source: string): Promise<{
  default: (
    result: ReturnType<typeof createResult>,
    props: Record<string, unknown>,
    slots?: Record<string, () => Promise<string>>,
  ) => Promise<string>;
}> {
  const { code } = compileAstro(source);
  const filename = `page-${fileCounter++}.mjs`;
  const path = join(workDir, filename);
  writeFileSync(path, code);
  // Import with a cache-bust to avoid Node caching across tests sharing a name.
  return import(`${pathToFileURL(path).href}?t=${Date.now()}-${Math.random()}`) as Promise<{
    default: (
      result: ReturnType<typeof createResult>,
      props: Record<string, unknown>,
      slots?: Record<string, () => Promise<string>>,
    ) => Promise<string>;
  }>;
}

async function render(source: string, props: Record<string, unknown> = {}): Promise<string> {
  const mod = await compileAndImport(source);
  return mod.default(createResult(), props, {});
}

describe("end-to-end render", () => {
  it("renders a static element tree", async () => {
    const html = await render("<div><p>hello world</p></div>");
    expect(html).toBe("<div><p>hello world</p></div>");
  });

  it("escapes interpolated values", async () => {
    const html = await render("---\nconst { value } = props;\n---\n<p>{value}</p>", {
      value: "<script>x</script>",
    });
    expect(html).toBe("<p>&lt;script&gt;x&lt;/script&gt;</p>");
  });

  it("renders props from the frontmatter", async () => {
    const html = await render("---\nconst { name } = props;\n---\n<h1>Hello, {name}!</h1>", {
      name: "Astroflare",
    });
    expect(html).toBe("<h1>Hello, Astroflare!</h1>");
  });

  it("renders attributes — static, expression, boolean, spread", async () => {
    const html = await render(
      `---\nconst { n, rest } = props;\n---\n<input type="text" name={n} disabled {...rest}>`,
      { n: "email", rest: { placeholder: "you@example.com", required: true } },
    );
    // Order is the order the attributes were declared.
    expect(html).toBe(
      '<input type="text" name="email" disabled placeholder="you@example.com" required>',
    );
  });

  it("omits attributes whose value is null/undefined/false; emits boolean attrs for true", async () => {
    const html = await render(
      "---\nconst { d, h, p } = props;\n---\n<input disabled={d} hidden={h} placeholder={p}>",
      { d: true, h: false, p: null },
    );
    expect(html).toBe("<input disabled>");
  });

  it("set:html bypasses escaping", async () => {
    const html = await render("---\nconst { raw } = props;\n---\n<div set:html={raw}></div>", {
      raw: "<b>bold</b>",
    });
    expect(html).toBe("<div><b>bold</b></div>");
  });

  it("renders <style> blocks verbatim", async () => {
    const html = await render("<style>h1 { color: red; }</style>");
    expect(html).toBe("<style>h1 { color: red; }</style>");
  });

  it("renders a slot with fallback when no slot is provided", async () => {
    const html = await render('<slot name="footer">no footer</slot>');
    expect(html).toBe("no footer");
  });

  it("renders a slot from the slots argument when provided", async () => {
    const mod = await compileAndImport('<slot name="footer">fallback</slot>');
    const html = await mod.default(
      createResult(),
      {},
      {
        footer: async () => "<p>real footer</p>",
      },
    );
    expect(html).toBe("<p>real footer</p>");
  });

  it("renders interpolated maps over arrays", async () => {
    const html = await render(
      `---\nconst { items } = props;\n---\n<ul>{items.map((i) => "<li>" + i + "</li>").join("")}</ul>`,
      { items: ["a", "b", "c"] },
    );
    // Interpolation result is a string and gets escaped — verify behaviour.
    expect(html).toBe(
      "<ul>&lt;li&gt;a&lt;/li&gt;&lt;li&gt;b&lt;/li&gt;&lt;li&gt;c&lt;/li&gt;</ul>",
    );
  });

  it("composes a parent component with a typed slot", async () => {
    // Compile child first, then parent that imports it.
    const childCode = compileAstro("<aside><slot /></aside>").code;
    const childPath = join(workDir, "Child.astro.mjs");
    writeFileSync(childPath, childCode);

    const parentSource = `---\nimport Child from "./Child.astro.mjs";\nconst { msg } = props;\n---\n<Child><p>{msg}</p></Child>`;
    const parentCode = compileAstro(parentSource).code;
    const parentPath = join(workDir, "Parent.astro.mjs");
    writeFileSync(parentPath, parentCode);

    const mod = (await import(`${pathToFileURL(parentPath).href}?t=${Date.now()}`)) as {
      default: (
        result: ReturnType<typeof createResult>,
        props: Record<string, unknown>,
        slots?: Record<string, () => Promise<string>>,
      ) => Promise<string>;
    };
    const html = await mod.default(createResult(), { msg: "ping" });
    expect(html).toBe("<aside><p>ping</p></aside>");
  });
});
