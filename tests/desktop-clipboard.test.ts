/** Exercise the registered production permission handlers without opening Electron. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);
const origin = "http://127.0.0.1:3217";
const appUrl = `${origin}/chat/current-session`;
type Details = { isMainFrame?: boolean; requestingUrl?: string };
type Contents = {
	mainFrame?: { url: string };
	destroyed: boolean;
	isDestroyed(): boolean;
	getURL(): string;
	on(): void;
	setWindowOpenHandler(): void;
};
type RequestHandler = (contents: Contents | null, permission: string, callback: (allowed: boolean) => void, details?: Details) => void;
type CheckHandler = (contents: Contents | null, permission: string, requestingOrigin: string, details?: Details) => boolean;

function fixture() {
	let requestHandler!: RequestHandler;
	let checkHandler!: CheckHandler;
	const windows = new Map<Contents, FakeWindow>();
	class FakeWindow {
		focused = true;
		destroyed = false;
		closed?: () => void;
		webContents: Contents = {
			mainFrame: { url: appUrl }, destroyed: false,
			isDestroyed() { return this.destroyed; },
			getURL() { return this.mainFrame?.url ?? ""; },
			on() {}, setWindowOpenHandler() {},
		};
		constructor() { windows.set(this.webContents, this); }
		static fromWebContents(contents: Contents) { return windows.get(contents) ?? null; }
		isDestroyed() { return this.destroyed; }
		isFocused() { return this.focused; }
		once(event: string, callback: () => void) { if (event === "closed") this.closed = callback; }
		loadURL(url: string) { this.webContents.mainFrame!.url = url; }
	}
	const electron = {
		app: { setName() {}, getPath: () => "/fixture/LearnHarness", setPath() {}, requestSingleInstanceLock: () => false, quit() {} },
		BrowserWindow: FakeWindow,
		nativeTheme: { shouldUseDarkColors: true },
		session: { defaultSession: {
			setPermissionRequestHandler(handler: RequestHandler) { requestHandler = handler; },
			setPermissionCheckHandler(handler: CheckHandler) { checkHandler = handler; },
		} },
	};
	const context = {
		require: (id: string) => id === "electron" ? electron : mainRequire(id),
		process: { platform: "darwin", argv: [], env: {}, on() {} },
		URL, __dirname: dirname(mainFile),
	};
	runInNewContext(mainSource, context, { filename: mainFile });
	const win = runInNewContext(`createWindow(${JSON.stringify(appUrl)})`, context) as FakeWindow;
	const details: Details = { isMainFrame: true, requestingUrl: appUrl };
	return {
		win, details, untrustedWindow: () => new FakeWindow(),
		request(permission: string, contents: Contents | null = win.webContents, requestDetails?: Details) {
			let result: boolean | undefined;
			requestHandler(contents, permission, allowed => { result = allowed; }, arguments.length > 2 ? requestDetails : details);
			assert.equal(typeof result, "boolean", "the request callback must complete with a decision");
			return result;
		},
		check(permission: string, contents: Contents | null = win.webContents, requestingOrigin = origin, checkDetails?: Details) {
			return checkHandler(contents, permission, requestingOrigin, arguments.length > 3 ? checkDetails : details);
		},
	};
}

test("focused trusted app main-frame clipboard reads pass both production permission handlers", () => {
	const app = fixture();
	assert.equal(app.request("clipboard-read"), true);
	assert.equal(app.check("clipboard-read"), true);
});

test("clipboard reads reject foreign, opaque, malformed and subframe request contexts", () => {
	for (const requestingUrl of ["https://external.invalid/paste", "http://127.0.0.1:3218/chat/current-session", "about:srcdoc", "data:text/html,demo", "not a URL"]) {
		const app = fixture();
		app.details.requestingUrl = requestingUrl;
		assert.equal(app.request("clipboard-read"), false, `request: ${requestingUrl}`);
		assert.equal(app.check("clipboard-read"), false, `check: ${requestingUrl}`);
	}
	for (const details of [{ isMainFrame: false, requestingUrl: appUrl }, { requestingUrl: appUrl }, { isMainFrame: true }, {}, undefined]) {
		const app = fixture();
		assert.equal(app.request("clipboard-read", app.win.webContents, details), false, `request metadata: ${JSON.stringify(details)}`);
		assert.equal(app.check("clipboard-read", app.win.webContents, origin, details), false, `check metadata: ${JSON.stringify(details)}`);
	}
	const app = fixture();
	assert.equal(app.check("clipboard-read", app.win.webContents, "https://external.invalid"), false);
	assert.equal(app.check("clipboard-read", app.win.webContents, "null"), false);
});

test("clipboard reads require live contents belonging to an open focused app window", () => {
	const mutations: [string, (app: ReturnType<typeof fixture>) => Contents | null][] = [
		["missing contents", () => null],
		["untrusted native window", app => app.untrustedWindow().webContents],
		["unknown contents", app => ({ ...app.win.webContents })],
		["destroyed contents", app => { app.win.webContents.destroyed = true; return app.win.webContents; }],
		["destroyed window", app => { app.win.destroyed = true; return app.win.webContents; }],
		["background window", app => { app.win.focused = false; return app.win.webContents; }],
		["closed window", app => { app.win.closed!(); return app.win.webContents; }],
		["main frame navigated away", app => { app.win.webContents.mainFrame!.url = "https://external.invalid/"; return app.win.webContents; }],
		["missing main frame", app => { app.win.webContents.mainFrame = undefined; return app.win.webContents; }],
		["frame metadata unavailable", app => { app.win.webContents.isDestroyed = () => { throw new Error("disposed"); }; return app.win.webContents; }],
	];
	for (const [label, mutate] of mutations) {
		const app = fixture();
		const contents = mutate(app);
		assert.equal(app.request("clipboard-read", contents), false, `request: ${label}`);
		assert.equal(app.check("clipboard-read", contents), false, `check: ${label}`);
	}
});

test("existing own-origin clipboard writes and other grants retain their behavior", () => {
	const app = fixture();
	for (const permission of ["clipboard-sanitized-write", "media", "local-fonts"]) {
		assert.equal(app.request(permission), true, permission);
		assert.equal(app.check(permission), true, permission);
		app.win.focused = false;
		assert.equal(app.request(permission), true, `${permission} keeps its existing permission policy`);
		assert.equal(app.check(permission), true, `${permission} keeps its existing permission policy`);
		assert.equal(app.request(permission, app.win.webContents, { isMainFrame: true, requestingUrl: "https://external.invalid/" }), false);
		assert.equal(app.check(permission, app.win.webContents, "https://external.invalid"), false);
	}
	assert.equal(app.request("geolocation"), false);
	assert.equal(app.check("geolocation"), false);
	assert.equal(app.request("deprecated-sync-clipboard-read"), false);
	assert.equal(app.check("deprecated-sync-clipboard-read"), false);
});
