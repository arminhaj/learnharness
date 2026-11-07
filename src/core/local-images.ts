/** Markdown image destinations are URLs, even when authored as local paths.
 * Rewrite at render time so saved lessons need no transcript migration. */
export function localImageSource(source: string): string {
	let file = source;
	let fragment = "";
	if (/^file:/i.test(file)) {
		try {
			const url = new URL(file);
			if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return source;
			file = url.pathname;
			fragment = url.hash;
			if (/^\/[a-z]:\//i.test(file)) file = file.slice(1);
		} catch { return source; }
	} else if (
		!file.startsWith("~/") && !/^[a-z]:[\\/]/i.test(file) &&
		(!file.startsWith("/") || file.startsWith("//") || /^\/(?:api|_next)(?:\/|$)/.test(file))
	) return source;
	else if (file.startsWith("/")) {
		// Query strings belong to web asset URLs; encoded ?/# characters
		// remain part of a local filename until the single decode below.
		const url = new URL(file, "http://local.invalid");
		file = url.pathname;
		fragment = url.hash;
	}

	try { file = decodeURIComponent(file); } catch { /* A literal percent in a filename. */ }
	if (file.includes("\0")) return source;
	return `/api/local-images?${new URLSearchParams({ path: file })}${fragment}`;
}

type ImageTree = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: ImageTree[] };

/** Run after raw HTML parsing and before URL sanitization. Handles inline,
 * reference-style and HTML images without touching links or literal code. */
export function rehypeLocalImages() {
	return (tree: ImageTree): void => {
		const pending = [tree];
		while (pending.length) {
			const node = pending.pop()!;
			if (node.tagName === "img" && typeof node.properties?.src === "string") {
				node.properties.src = localImageSource(node.properties.src);
			}
			if (node.children) pending.push(...node.children);
		}
	};
}
