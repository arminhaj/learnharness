/** Native window colors mirror the renderer's semantic appearance defaults. */
function parseNativeAppearance(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const mode = raw.mode ?? "dark";
	const background = raw.background ?? null;
	if (!["dark", "light", "system"].includes(mode)) return null;
	if (background !== null && (typeof background !== "string" || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(background))) return null;
	return { mode, background };
}

function nativeAppearanceColors(appearance, systemDark) {
	const dark = appearance.mode === "dark" || (appearance.mode === "system" && systemDark);
	return {
		background: appearance.background ?? (dark ? "#141414" : "#fafafa"),
		foreground: dark ? "#e5e5e5" : "#242424",
	};
}

module.exports = { parseNativeAppearance, nativeAppearanceColors };
