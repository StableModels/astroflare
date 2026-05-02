/**
 * POSIX-style path utilities.
 *
 * Self-contained — `node:path` isn't available in workerd, so the framework
 * (which runs in workerd in production) can't reach for it. Workspace paths
 * always use forward slashes and a leading `/` for the workspace root, so
 * we don't need full Node-path semantics, just the bits the framework uses:
 *   - `dirname(path)` — strip the last segment
 *   - `joinPath(base, specifier)` — resolve a relative specifier against a
 *     directory, normalising `.` and `..` segments
 *   - `replaceExtension(path, fromExt, toExt)`
 */

/** Return the directory portion of a path (everything before the last `/`). */
export function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	if (i < 0) return ".";
	if (i === 0) return "/";
	return path.slice(0, i);
}

/** Resolve a relative specifier (`./x`, `../y`, `x/y`) against a base directory. */
export function joinPath(baseDir: string, specifier: string): string {
	if (specifier.startsWith("/")) return normalisePath(specifier);
	const combined = baseDir.endsWith("/") ? baseDir + specifier : `${baseDir}/${specifier}`;
	return normalisePath(combined);
}

/** Collapse `.` and `..` segments. Anchored absolute paths (leading `/`) preserved. */
export function normalisePath(path: string): string {
	const isAbsolute = path.startsWith("/");
	const out: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
			else if (!isAbsolute) out.push("..");
			continue;
		}
		out.push(part);
	}
	const joined = out.join("/");
	if (isAbsolute) return `/${joined}`;
	return joined.length === 0 ? "." : joined;
}

/** Replace a file extension. Returns the original path if `fromExt` doesn't match. */
export function replaceExtension(path: string, fromExt: string, toExt: string): string {
	if (!path.endsWith(fromExt)) return path;
	return path.slice(0, -fromExt.length) + toExt;
}
