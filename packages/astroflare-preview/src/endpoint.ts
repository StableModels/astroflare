/**
 * Server endpoints — `.js` files under `src/pages/` that export named
 * HTTP-method handlers (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`,
 * `OPTIONS`) and/or a default `(ctx) => Response | Promise<Response>`.
 *
 * Phase 8 ships JS-only endpoints. TS endpoints need a type-stripping
 * pass that the framework doesn't yet have (Phase 6 retro carry-over).
 *
 * Endpoint module shape:
 *
 *   export const GET = async ({ params, request, url }) =>
 *     new Response("hello");
 *
 *   export async function POST({ request }) { … }
 *
 *   // Or fallback for any method:
 *   export default async ({ request, params }) => …;
 *
 * The framework looks up the matching named export; falls back to
 * `default`; returns `405 Method Not Allowed` if neither matches.
 */

import { transformTS } from "@astroflare/compiler/ts";
import type { Host, TaskBundle } from "@astroflare/core";

const dec = new TextDecoder();

export interface EndpointContext {
	request: Request;
	url: URL;
	params: Record<string, string>;
	site?: string;
	/** Phase 18: resolved locale when an `i18n` config is active. */
	currentLocale?: string;
}

export interface EndpointResult {
	/** Map of HTTP method → handler. */
	handlers: Record<string, (ctx: EndpointContext) => Promise<Response> | Response>;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export interface RunEndpointOptions {
	host: Host;
	filePath: string;
	cacheId: string;
	context: EndpointContext;
}

/**
 * Read an endpoint module's source from `host.storage`, run it through the
 * executor, and dispatch by HTTP method. Designed to slot into the same
 * `Executor.runCached` flow the page render path uses.
 */
export async function runEndpoint(opts: RunEndpointOptions): Promise<Response> {
	const sourceBytes = await opts.host.storage.read(opts.filePath);
	let source = dec.decode(sourceBytes);
	// `.ts` endpoints get TS syntax stripped before bundling. Plain `.js`
	// passes through unchanged.
	if (opts.filePath.endsWith(".ts")) {
		try {
			source = await transformTS(source, { filename: opts.filePath });
		} catch {
			// On TS init failure (e.g. workerd without WASM), fall back to
			// the original source. JS-only `.ts` files load fine; type
			// annotations would surface as a runtime error.
		}
	}

	const taskBundle: TaskBundle = {
		mainModule: "main.js",
		modules: { "main.js": wrapEndpoint(source) },
	};

	const handlers = await opts.host.executor.runCached<
		Record<string, (ctx: EndpointContext) => Promise<Response> | Response>
	>(opts.cacheId, () => taskBundle, null);

	const method = opts.context.request.method.toUpperCase();
	const handler = handlers[method] ?? handlers.default;
	if (!handler) {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: {
				"content-type": "text/plain;charset=utf-8",
				allow: HTTP_METHODS.filter((m) => handlers[m]).join(", ") || HTTP_METHODS.join(", "),
			},
		});
	}
	return handler(opts.context);
}

/**
 * Wrap a user endpoint module so its named/default exports come back as
 * an object the executor's `default` can return. Works with the existing
 * IIFE-bundle / `runCached` machinery.
 */
function wrapEndpoint(userSource: string): string {
	return [
		"export default async () => {",
		"  const userMod = await (async () => {",
		"    const __module = { exports: {} };",
		"    let __default;",
		`    ${rewriteExports(userSource)}`,
		"    return Object.assign({ default: __default }, __module.exports);",
		"  })();",
		"  return userMod;",
		"};",
	].join("\n");
}

/**
 * Translate the small-but-realistic export shapes the brief calls for into
 * declarations + `__module.exports.X = X` assignments so we can run the
 * module body inside an IIFE and capture exports.
 *
 * Strategy:
 *   1. Strip `export ` from each `export <decl>` (capturing the declared name).
 *   2. After the body, append `__module.exports.X = X;` for each captured name.
 *   3. `export default <expr>` becomes `__default = <expr>` (no name to track).
 *
 * Regexes are deliberately narrow — anything else (re-exports,
 * `export type`, namespace imports of bare specifiers) is left alone.
 */
function rewriteExports(source: string): string {
	const names: string[] = [];
	let out = source;

	// `export default <expr>;`
	out = out.replace(/^[ \t]*export[ \t]+default[ \t]+/m, "__default = ");

	// `export async function NAME(...) { … }`
	out = out.replace(/^[ \t]*export[ \t]+async[ \t]+function[ \t]+(\w+)/gm, (_, name) => {
		names.push(name);
		return `async function ${name}`;
	});
	// `export function NAME(...) { … }`
	out = out.replace(/^[ \t]*export[ \t]+function[ \t]+(\w+)/gm, (_, name) => {
		names.push(name);
		return `function ${name}`;
	});
	// `export (const|let|var) NAME = …`
	out = out.replace(/^[ \t]*export[ \t]+(const|let|var)[ \t]+(\w+)/gm, (_, kw, name) => {
		names.push(name);
		return `${kw} ${name}`;
	});

	// `export { Foo, Bar as default, Baz };` — esbuild's TS-strip emits
	// this shape for `.ts` modules. Each entry maps to either a name to
	// re-export (bare) or `__default` (`X as default`).
	out = out.replace(/^[ \t]*export[ \t]*\{([^}]*)\}[ \t]*;?[ \t]*$/gm, (_, list) => {
		const lines: string[] = [];
		for (const part of list.split(",")) {
			const trimmed = part.trim();
			if (!trimmed) continue;
			const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
			if (asMatch) {
				const src = asMatch[1] as string;
				const dst = asMatch[2] as string;
				if (dst === "default") {
					lines.push(`__default = ${src};`);
				} else {
					names.push(dst);
					lines.push(`var ${dst} = ${src};`);
				}
				continue;
			}
			const bareMatch = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
			if (bareMatch) names.push(bareMatch[1] as string);
		}
		return lines.join("\n");
	});

	for (const name of names) {
		out += `\n__module.exports.${name} = ${name};`;
	}
	return out;
}
