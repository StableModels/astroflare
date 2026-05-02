/**
 * Middleware — `src/middleware.js` (or `.ts` later, when type-stripping
 * lands). Astro-shaped:
 *
 *   export const onRequest = async (context, next) => {
 *     // pre-processing (logging, auth, redirect, etc.)
 *     const response = await next();
 *     // post-processing (headers, body rewrite)
 *     return response;
 *   };
 *
 * Or sequence multiple:
 *
 *   export const onRequest = sequence(authMiddleware, loggingMiddleware);
 *
 * The framework calls `onRequest(ctx, next)` for every request; `next()`
 * invokes either the next middleware in the chain or, finally, the page
 * render (or endpoint). The middleware can short-circuit by returning a
 * `Response` without calling `next()`.
 */

import type { Host } from "@astroflare/core";

export interface MiddlewareContext {
	request: Request;
	url: URL;
	params: Record<string, string>;
	site?: string;
	/** Per-request scratch space accessible across middleware steps. */
	locals: Record<string, unknown>;
}

export type MiddlewareNext = () => Promise<Response>;

export type MiddlewareFn = (
	ctx: MiddlewareContext,
	next: MiddlewareNext,
) => Promise<Response> | Response;

export interface MiddlewareModule {
	onRequest?: MiddlewareFn;
	default?: MiddlewareFn;
}

const dec = new TextDecoder();
const MIDDLEWARE_PATH_CANDIDATES = [
	"/src/middleware.js",
	// `.ts` would go here once type-stripping lands. The host's deploy-time
	// build can pre-strip `.ts` to `.js`; in preview today we only see `.js`.
];

/**
 * Look up and load the user's middleware module. Returns `null` if no
 * middleware file exists (no fallback in that case — the caller skips the
 * chain).
 */
export async function loadMiddleware(host: Host, cacheId: string): Promise<MiddlewareFn | null> {
	for (const path of MIDDLEWARE_PATH_CANDIDATES) {
		const stat = await host.storage.stat(path);
		if (!stat) continue;
		const sourceBytes = await host.storage.read(path);
		const source = dec.decode(sourceBytes);

		const taskBundle = {
			mainModule: "main.js",
			modules: { "main.js": wrapMiddleware(source) },
		};

		const mod = await host.executor.runCached<MiddlewareModule>(cacheId, () => taskBundle, null);
		const fn = mod.onRequest ?? mod.default;
		if (typeof fn === "function") return fn;
	}
	return null;
}

/**
 * Combine multiple middleware functions into one. Each is run in order,
 * with `next()` advancing to the next; the final `next()` invokes the
 * inner page/endpoint.
 */
export function sequence(...fns: readonly MiddlewareFn[]): MiddlewareFn {
	return async (ctx: MiddlewareContext, finalNext: MiddlewareNext): Promise<Response> => {
		let i = -1;
		const dispatch = async (): Promise<Response> => {
			i++;
			const fn = fns[i];
			if (!fn) return finalNext();
			return fn(ctx, dispatch);
		};
		return dispatch();
	};
}

function wrapMiddleware(userSource: string): string {
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

/** See `endpoint.ts#rewriteExports` for the rationale. */
function rewriteExports(source: string): string {
	const names: string[] = [];
	let out = source;
	out = out.replace(/^[ \t]*export[ \t]+default[ \t]+/m, "__default = ");
	out = out.replace(/^[ \t]*export[ \t]+async[ \t]+function[ \t]+(\w+)/gm, (_, name) => {
		names.push(name);
		return `async function ${name}`;
	});
	out = out.replace(/^[ \t]*export[ \t]+function[ \t]+(\w+)/gm, (_, name) => {
		names.push(name);
		return `function ${name}`;
	});
	out = out.replace(/^[ \t]*export[ \t]+(const|let|var)[ \t]+(\w+)/gm, (_, kw, name) => {
		names.push(name);
		return `${kw} ${name}`;
	});
	for (const name of names) {
		out += `\n__module.exports.${name} = ${name};`;
	}
	return out;
}
