import React from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { Streamdown } from "streamdown";
import { MessageResponse, ToolContentResponse } from "../components/ai-elements/message.tsx";
import { Reasoning, ReasoningContent } from "../components/ai-elements/reasoning.tsx";
import { GET } from "../app/api/local-images/route.ts";
import { localImageSource } from "../src/core/local-images.ts";

const scratch = await mkdtemp(path.join(os.tmpdir(), "lh-local-images-"));
after(() => rm(scratch, { recursive: true, force: true }));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const fixture = path.join(scratch, "word values 日本 100% #1.png");
await writeFile(fixture, png);
const markdownPath = pathToFileURL(fixture).pathname;
const image = (element: React.ReactElement) => parseHTML(renderToStaticMarkup(element)).document.querySelector("img")!;
const request = (source: string, headers?: HeadersInit) => GET(new Request(new URL(source, "http://localhost:3217"), { headers }));

const surfaces = {
	message: (source: string) => <MessageResponse mode="static">{source}</MessageResponse>,
	tool: (source: string) => <ToolContentResponse mode="static">{source}</ToolContentResponse>,
	reasoning: (source: string) => <Reasoning open><ReasoningContent>{source}</ReasoningContent></Reasoning>,
};

for (const [name, surface] of Object.entries(surfaces)) {
	test(`${name}: saved absolute-path Markdown renders and serves the original image bytes`, async () => {
		const source = `![Word values](${markdownPath})`;
		const img = image(surface(source));
		assert.equal(img.getAttribute("alt"), "Word values");
		const src = img.getAttribute("src")!;
		assert.ok(src.startsWith("/api/local-images?"));
		assert.equal(new URL(src, "http://localhost").searchParams.get("path"), fixture);
		const response = await request(src);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "image/png");
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
		assert.equal(source, `![Word values](${markdownPath})`, "rendering does not mutate saved content");
	});
}

test("file URLs, image references and HTML images use the same rendering path", async () => {
	for (const source of [
		`![Words](${pathToFileURL(fixture).href})`,
		`![Words][ref]\n\n[ref]: ${markdownPath} "Source sheet"`,
		`<img src="${markdownPath}" alt="Words">`,
	]) {
		const img = image(surfaces.message(source));
		const response = await request(img.getAttribute("src")!);
		assert.equal(response.status, 200, source);
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
	}
});

test("web images, API image URLs, links and literal code retain their destinations", () => {
	for (const src of ["https://example.org/chart.png", "//example.org/chart.png", "/api/chart.png", "/_next/image?url=chart.png", "chart.png"]) {
		assert.equal(localImageSource(src), src);
		const markdown = `![Chart](${src})`;
		assert.equal(image(surfaces.message(markdown))?.getAttribute("src"),
			image(<Streamdown mode="static">{markdown}</Streamdown>)?.getAttribute("src"));
	}
	const html = renderToStaticMarkup(surfaces.message(`[Sheet](${markdownPath})\n\n\`![Sheet](${markdownPath})\``));
	const doc = parseHTML(html).document;
	assert.ok(!html.includes("/api/local-images"), "ordinary links are not rewritten");
	assert.equal(doc.querySelector("code")?.textContent, `![Sheet](${markdownPath})`);
	assert.equal(doc.querySelector("img"), null);
});

test("sanitization still removes active HTML and unsafe image URLs", () => {
	const doc = parseHTML(renderToStaticMarkup(surfaces.message('<img src="javascript:alert(1)" onerror="alert(2)"><script>alert(3)</script>'))).document;
	assert.equal(doc.querySelector("script, [onerror]"), null);
	assert.ok(!doc.querySelector("img")?.getAttribute("src")?.startsWith("javascript:"));
});

test("public root-relative images remain available through the image handler", async () => {
	const src = image(surfaces.message("![Logo](/siwc/chatgpt-logo-white.svg?v=1)")).getAttribute("src")!;
	const response = await request(src);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "image/svg+xml");
	assert.ok((await response.text()).includes("<svg"));
	assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
});

test("missing images, directories and non-image files fail without exposing file contents", async () => {
	await writeFile(path.join(scratch, "notes.txt"), "private text");
	await mkdir(path.join(scratch, "directory.png"));
	for (const [file, status] of [["missing.png", 404], ["directory.png", 404], ["notes.txt", 415]] as const) {
		const response = await request(`/api/local-images?${new URLSearchParams({ path: path.join(scratch, file) })}`);
		assert.equal(response.status, status);
		assert.ok(!(await response.text()).includes("private text"));
	}
	for (const file of ["relative.png", "//remote.example/share.png", "bad\0.png"]) {
		assert.equal((await request(`/api/local-images?${new URLSearchParams({ path: file })}`)).status, 400);
	}
});

test("cross-origin browser requests cannot read local image files", async () => {
	const src = `/api/local-images?${new URLSearchParams({ path: fixture })}`;
	for (const headers of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "https://example.org" }] as HeadersInit[]) {
		assert.equal((await request(src, headers)).status, 403);
	}
	const response = await request(src, { "sec-fetch-site": "same-origin" });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
});
