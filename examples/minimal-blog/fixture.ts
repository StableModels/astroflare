/**
 * In-memory project tree for the `minimal-blog` example. Used by tests and
 * by anyone wanting to bootstrap an Astroflare host with a known-good blog
 * shape.
 *
 * The fixture exercises:
 *   - layout component                (`src/components/Layout.astro`)
 *   - markdown route                  (`src/pages/about.md`)
 *   - astro index route               (`src/pages/index.astro`)
 *   - astro dynamic route             (`src/pages/posts/[slug].astro`)
 *   - content collection (blog posts) (`src/content/blog/*.md` + schema)
 */

export const minimalBlogFiles: Record<string, string> = {
	// ---- layout
	"/src/components/Layout.astro":
		"---\nconst { title } = Astro.props;\n---\n" +
		"<html><head><title>{title}</title></head><body><main><slot/></main><footer>astroflare</footer></body></html>",

	// ---- index page lists posts (rendered with markdown headings)
	"/src/pages/index.astro":
		'---\nimport Layout from "../components/Layout.astro";\n---\n' +
		'<Layout title="My Blog"><h1>Welcome</h1><p>Posts coming soon.</p></Layout>',

	// ---- markdown about page
	"/src/pages/about.md": "---\ntitle: About\n---\n# About this blog\n\nA tiny example.\n",

	// ---- dynamic post route (preview-only; deploy skips dynamic routes)
	"/src/pages/posts/[slug].astro":
		'---\nimport Layout from "../../components/Layout.astro";\nconst { slug } = Astro.params;\n---\n' +
		"<Layout title={slug}><h1>{slug}</h1></Layout>",

	// ---- content collection: schema + entries
	"/src/content/blog/hello-world.md":
		"---\ntitle: Hello, World\npubDate: 2026-05-02\ntags: [intro, hello]\n---\n# Hello!\n\nThis is the first post.\n",

	"/src/content/blog/second-post.md":
		"---\ntitle: A Second Post\npubDate: 2026-05-09\ntags: [updates]\n---\n# Second post\n\nMore content.\n",

	"/src/content/blog/third-post.md":
		"---\ntitle: Third\npubDate: 2026-05-16\ntags: []\n---\n# Three\n",
};
