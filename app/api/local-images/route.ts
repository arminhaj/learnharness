import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MIME: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
	".bmp": "image/bmp", ".avif": "image/avif", ".ico": "image/x-icon",
};
const HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Content-Security-Policy": "default-src 'none'; sandbox",
};
const error = (status: number, message: string) => Response.json({ error: message }, { status, headers: HEADERS });

export async function GET(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const origin = `${url.protocol}//${request.headers.get("host") ?? url.host}`;
	const site = request.headers.get("sec-fetch-site");
	if ((site && site !== "same-origin" && site !== "none") ||
		(request.headers.has("origin") && request.headers.get("origin") !== origin)) {
		return error(403, "Open local images from LearnHarness.");
	}
	const input = url.searchParams.get("path");
	if (!input || input.includes("\0")) return error(400, "Expected an absolute image path.");
	const file = input.startsWith("~/") ? path.join(homedir(), input.slice(2)) : input;
	if (!path.isAbsolute(file) || file.startsWith("//")) return error(400, "Expected an absolute image path.");
	const mime = MIME[path.extname(file).toLowerCase()];
	if (!mime) return error(415, "Unsupported image type.");

	// Root-relative public images have the same syntax as absolute POSIX
	// paths. Keep both working; API and Next asset URLs aren't rewritten.
	const publicRoot = path.resolve("public");
	const publicFile = path.resolve(publicRoot, `.${file}`);
	const candidates = [file];
	if (publicFile.startsWith(publicRoot + path.sep)) candidates.push(publicFile);
	for (const candidate of candidates) {
		let handle;
		try {
			handle = await open(candidate, constants.O_RDONLY | constants.O_NONBLOCK);
			if (!(await handle.stat()).isFile()) return error(404, "Image not found.");
			const bytes = await handle.readFile();
			return new Response(new Uint8Array(bytes), { headers: { ...HEADERS, "Content-Type": mime } });
		} catch (cause) {
			const code = (cause as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return error(404, "Image not found.");
		} finally { await handle?.close(); }
	}
	return error(404, "Image not found.");
}
