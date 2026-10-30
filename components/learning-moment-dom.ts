import { momentTextFingerprint, type MomentSelection } from "@/src/core";

const EXCLUDED = 'script,style,noscript,input,textarea,select,button,iframe,canvas,[contenteditable="true"],[hidden],.sr-only,.katex-mathml,[data-learning-moment-ui],[data-exploration-id],[data-testid="exploration-starter"]';
const BLOCKS = new Set(['P', 'DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'TR', 'TD', 'BR']);
interface Point { node: Text; offset: number }
interface Character { start: Point; end: Point }
export interface MomentDisplay { text: string; characters: Character[] }
export interface SelectedMoment { messageId: string; selection: MomentSelection; excerpt: string; range: Range; root: HTMLElement }

const elementOf = (node: Node) => node.nodeType === 1 ? node as Element : node.parentElement;
const sourceOf = (node: Node) => elementOf(node)?.closest<HTMLElement>('[data-source-message-id]') ?? null;
export const momentBlockId = (root: HTMLElement) => root.dataset.sourcePartId || root.dataset.sourceMessageId || '';

/** One visible text coordinate system for creation, reopening and highlighting.
 * Formatting can change without moving an anchor. Controls, draft fields,
 * hidden math copies and nested exploration messages never enter its offsets. */
export function momentDisplay(root: HTMLElement): MomentDisplay {
	let text = ''; const characters: Character[] = [];
	let boundary = false;
	const append = (node: Text) => {
		for (let offset = 0; offset < node.data.length; offset++) {
			const value = node.data[offset]!;
			if (boundary && text && !text.endsWith(' ') && !/\s/u.test(value)) {
				text += ' '; characters.push({ start: characters.at(-1)!.end, end: { node, offset } });
			}
			boundary = false;
			const space = /\s/u.test(value);
			if (space && !text) continue;
			if (space && text.endsWith(' ')) { characters.at(-1)!.end = { node, offset: offset + 1 }; continue; }
			text += space ? ' ' : value;
			characters.push({ start: { node, offset }, end: { node, offset: offset + 1 } });
		}
	};
	const visit = (element: Element) => {
		if (element.matches(EXCLUDED) || element !== root && element.hasAttribute('data-source-message-id')) return;
		const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
		if (style && (style.display === 'none' || style.visibility === 'hidden')) return;
		if (BLOCKS.has(element.tagName)) boundary = true;
		for (const child of element.childNodes) {
			if (element.tagName === 'DETAILS' && !element.hasAttribute('open') && (child.nodeType !== 1 || (child as Element).tagName !== 'SUMMARY')) continue;
			if (child.nodeType === 3) append(child as Text);
			else if (child.nodeType === 1) visit(child as Element);
		}
		if (BLOCKS.has(element.tagName)) boundary = true;
	};
	visit(root);
	if (text.endsWith(' ')) { text = text.slice(0, -1); characters.pop(); }
	return { text, characters };
}

export function momentSelectionFromRange(root: HTMLElement, range: Range): MomentSelection | null {
	if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
	const display = momentDisplay(root);
	let start = display.characters.findIndex(c => range.comparePoint(c.start.node, c.start.offset) === 0 && range.comparePoint(c.end.node, c.end.offset) === 0);
	if (start < 0) return null;
	let end = start;
	while (end < display.characters.length && range.comparePoint(display.characters[end]!.end.node, display.characters[end]!.end.offset) === 0) end++;
	while (start < end && display.text[start] === ' ') start++;
	while (end > start && display.text[end - 1] === ' ') end--;
	if (end <= start || end - start > 16000) return null;
	return { blockId: momentBlockId(root), start, end, fingerprint: momentTextFingerprint(display.text) };
}

export function readMomentSelection(doc: Document, chatId: string): SelectedMoment | null {
	const selection = doc.getSelection?.();
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
	const range = selection.getRangeAt(0);
	const root = sourceOf(range.startContainer);
	if (!root || root !== sourceOf(range.endContainer) || root.closest<HTMLElement>('[data-learning-chat-id]')?.dataset.learningChatId !== chatId) return null;
	const anchor = momentSelectionFromRange(root, range);
	if (!anchor) return null;
	return { messageId: root.dataset.sourceMessageId!, selection: anchor, excerpt: momentDisplay(root).text.slice(anchor.start, anchor.end), range: range.cloneRange(), root };
}

export function momentRoots(scope: HTMLElement, messageId: string): HTMLElement[] {
	return [...scope.querySelectorAll<HTMLElement>('[data-source-message-id]')].filter(root => root.dataset.sourceMessageId === messageId && root.closest('[data-learning-chat-id]') === scope);
}

/** Refuse changed content rather than silently highlighting a different phrase. */
export function resolveMomentSelection(root: HTMLElement, selection: MomentSelection): { range: Range; excerpt: string } | null {
	if (momentBlockId(root) !== selection.blockId) return null;
	const display = momentDisplay(root);
	if (momentTextFingerprint(display.text) !== selection.fingerprint || selection.end > display.text.length || selection.start >= selection.end) return null;
	const start = display.characters[selection.start]!.start, end = display.characters[selection.end - 1]!.end;
	const range = root.ownerDocument.createRange();
	if (typeof range.setStart !== 'function') return null;
	range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
	return { range, excerpt: display.text.slice(selection.start, selection.end) };
}

export function momentAtPoint(root: HTMLElement, x: number, y: number): number | null {
	const doc = root.ownerDocument as Document & { caretRangeFromPoint?(x: number, y: number): Range | null };
	const caret = doc.caretRangeFromPoint?.(x, y);
	if (!caret || !root.contains(caret.startContainer)) return null;
	const display = momentDisplay(root);
	const index = display.characters.findIndex(c => c.start.node === caret.startContainer && c.start.offset >= caret.startOffset);
	return index < 0 ? null : index;
}
