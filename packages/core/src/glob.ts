/**
 * Tiny glob matcher.
 *
 * Supports the subset Astroflare actually uses for `Site.glob`:
 *   - `*`   — match any run of non-separator chars
 *   - `**`  — match any path (zero or more segments, including separators)
 *   - `?`   — match exactly one non-separator char
 *
 * Phase 1b: enough for routing fixtures and module-graph tests. We can grow
 * this (negation, brace expansion) when a feature actually requires it. Avoid
 * pulling in `picomatch` etc. — every dependency is a future audit.
 */

const RE_SPECIAL = /[.+^${}()|[\]\\]/g;

export function globToRegex(glob: string): RegExp {
	let re = "^";
	let i = 0;
	while (i < glob.length) {
		const c = glob[i] as string;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				// `**` — any number of segments. Consume optional trailing `/`.
				re += ".*";
				i += 2;
				if (glob[i] === "/") i++;
			} else {
				// `*` — one segment (no `/`).
				re += "[^/]*";
				i++;
			}
		} else if (c === "?") {
			re += "[^/]";
			i++;
		} else {
			re += c.replace(RE_SPECIAL, "\\$&");
			i++;
		}
	}
	return new RegExp(`${re}$`);
}

export function globMatch(glob: string, path: string): boolean {
	return globToRegex(glob).test(path);
}
