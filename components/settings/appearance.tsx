"use client";
/** Applies saved appearance settings and exposes the effective Light/Dark mode.
 * next-themes handles the pre-paint cache, native color-scheme, and live OS
 * changes; the settings record remains the durable source of truth.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ThemeProvider, useTheme } from "next-themes";
import { FACTORY_SETTINGS, type AppearanceSettings } from "@/src/core";

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		mode: delta?.mode ?? f.mode,
		background: delta?.background ?? f.background,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? f.mdRendering.headingWeight,
			boldColor: delta?.mdRendering?.boldColor ?? f.mdRendering.boldColor,
			italicColor: delta?.mdRendering?.italicColor ?? f.mdRendering.italicColor,
		},
	};
}

export type ResolvedAppearanceMode = "light" | "dark";

/** Shift each background channel, preserving the original Dark offsets. */
function raise(hex: string, add: number): string {
	const n = hex.length === 4
		? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
		: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	return `#${n.map((c) => Math.max(0, Math.min(255, c + add)).toString(16).padStart(2, "0")).join("")}`;
}

/** Light surfaces step down from the background; Dark surfaces step up. */
export function derivedPalette(background: string, mode: ResolvedAppearanceMode = "dark"): Record<string, string> {
	const direction = mode === "light" ? -1 : 1;
	const card = raise(background, direction * 8);
	const accent = raise(background, direction * 22);
	const border = raise(background, direction * 47);
	return {
		"--background": background,
		"--card": card,
		"--popover": card,
		"--secondary": card,
		"--muted": card,
		"--accent": accent,
		"--border": border,
		"--input": border,
		"--primary-foreground": background,
	};
}

/** THE mapping: resolved appearance → the CSS variables to set on <html>.
 *  Absent entries = leave the factory stylesheet value in place. Pure —
 *  exported for tests. */
export function appearanceVars(
	a: ReturnType<typeof resolveAppearance>,
	mode: ResolvedAppearanceMode = a.mode === "light" ? "light" : "dark",
): Record<string, string> {
	const vars: Record<string, string> = {};
	if (a.background !== null) Object.assign(vars, derivedPalette(a.background, mode));
	if (a.fontFamily !== null) {
		vars["--font-prose"] = `"${a.fontFamily}", var(--font-sans3), ui-sans-serif, system-ui, sans-serif`;
	}
	// The ONE documented reading-size variable (typography round 4): prose,
	// inputs, and session titles all read it, so one setProperty moves them.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Session names: CMU Serif by default; the toggle swaps the title font
	// to the prose family — covers chat.tsx + new-session.tsx titles with
	// zero component edits (they use the .font-title utility).
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	// Markdown rendering: heading weight + the emphasis inks (the vars
	// were built "ready for the settings UI").
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	if (a.mdRendering.boldColor !== null) vars["--lh-ink-strong"] = a.mdRendering.boldColor;
	if (a.mdRendering.italicColor !== null) vars["--lh-ink-italic"] = a.mdRendering.italicColor;
	return vars;
}

/** Pure: the previously-applied names ABSENT from the next var set —
 *  these get removeProperty so the factory stylesheet value returns.
 *  (Owner repro, fix wave: resets and toggle-backs never reverted because
 *  application only ever SET properties — the removal half was missing.)
 *  Exported for tests. */
export function staleVarNames(
	prevNames: readonly string[],
	nextVars: Record<string, string>,
): string[] {
	return prevNames.filter((n) => !(n in nextVars));
}

interface AppearanceContextValue {
	/** Resolved appearance; factory until the record arrives. */
	appearance: ReturnType<typeof resolveAppearance>;
	resolvedMode: ResolvedAppearanceMode;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	resolvedMode: "dark",
	onAppearanceChange: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
	return (
		<ThemeProvider attribute="class" defaultTheme="dark" storageKey="learnharness-appearance-mode" enableSystem>
			<AppearanceState>{children}</AppearanceState>
		</ThemeProvider>
	);
}

function AppearanceState({ children }: { children: React.ReactNode }) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(undefined);
	const [settingsReady, setSettingsReady] = useState(false);
	const { resolvedTheme, setTheme } = useTheme();
	const resolvedMode: ResolvedAppearanceMode = resolvedTheme === "light" ? "light" : "dark";
	const editedRef = useRef(false);
	// next-themes' setter changes identity with the theme. Keep the mount
	// fetch independent of that identity so OS/theme changes never refetch.
	const setThemeRef = useRef(setTheme);
	useEffect(() => { setThemeRef.current = setTheme; }, [setTheme]);
	const appearance = useMemo(() => resolveAppearance(delta), [delta]);
	const vars = useMemo(() => appearanceVars(appearance, resolvedMode), [appearance, resolvedMode]);
	useEffect(() => {
		if (settingsReady) window.lh?.setAppearance?.({ mode: appearance.mode, background: appearance.background });
	}, [settingsReady, appearance.mode, appearance.background]);
	const appliedNamesRef = useRef<string[]>([]);
	useEffect(() => {
		const root = document.documentElement;
		for (const name of staleVarNames(appliedNamesRef.current, vars)) root.style.removeProperty(name);
		for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
		appliedNamesRef.current = Object.keys(vars);
	}, [vars]);

	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((response) => {
				if (!response.ok) throw new Error("Could not load appearance settings");
				return response.json();
			})
			.then((body: { settings?: { appearance?: AppearanceSettings } }) => {
				// A slow initial read must not undo a selection saved meanwhile.
				if (!alive || editedRef.current) return;
				const next = body.settings?.appearance;
				setDelta(next);
				setSettingsReady(true);
				setThemeRef.current(resolveAppearance(next).mode);
			})
			.catch(() => { /* Keep the cached mode if settings are unavailable. */ });
		return () => { alive = false; };
	}, []);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		editedRef.current = true;
		setDelta(next);
		setSettingsReady(true);
		setThemeRef.current(resolveAppearance(next).mode);
	}, []);

	const value = useMemo(
		() => ({ appearance, resolvedMode, onAppearanceChange }),
		[appearance, resolvedMode, onAppearanceChange],
	);
	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
