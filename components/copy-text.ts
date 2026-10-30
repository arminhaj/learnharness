/** Copy in browsers and Electron, with a fallback when clipboard permission
 * is unavailable. A false result lets the caller show visible feedback. */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch { /* Try the browser's legacy clipboard path. */ }
	const previous = document.activeElement;
	const textarea = document.createElement("textarea");
	try {
		textarea.value = text;
		textarea.setAttribute("readonly", "");
		textarea.style.position = "fixed";
		textarea.style.opacity = "0";
		// A native modal makes elements outside it inert.
		(document.querySelector("dialog[open]") ?? document.body).appendChild(textarea);
		textarea.select();
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		textarea.remove();
		if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
	}
}
