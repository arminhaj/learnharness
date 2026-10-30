import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { momentTextFingerprint } from "../src/core/learning-history.ts";
import { momentDisplay, momentRoots, momentSelectionFromRange, readMomentSelection, resolveMomentSelection } from "../components/learning-moment-dom.ts";

function fixture(html: string) {
	const { document } = parseHTML(`<html><body><div data-learning-chat-id="lesson"><div data-source-message-id="m1" data-source-part-id="m1-t0">${html}</div></div></body></html>`);
	const root = document.querySelector<HTMLElement>('[data-source-message-id]')!;
	const range = () => ({
		startContainer: null as unknown as Node, startOffset: 0, endContainer: null as unknown as Node, endOffset: 0,
		setStart(node: Node, offset: number) { this.startContainer = node; this.startOffset = offset; },
		setEnd(node: Node, offset: number) { this.endContainer = node; this.endOffset = offset; },
		get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; },
		comparePoint(node: Node, offset: number) {
			const nodes: Node[] = [];
			const walk = (parent: Node) => { if (parent.nodeType === 3) nodes.push(parent); for (const child of parent.childNodes) walk(child); };
			walk(document.body);
			const a = nodes.indexOf(this.startContainer), b = nodes.indexOf(this.endContainer), point = nodes.indexOf(node);
			return point < a || point === a && offset < this.startOffset ? -1 : point > b || point === b && offset > this.endOffset ? 1 : 0;
		},
		cloneRange() { return this; },
	});
	Object.defineProperty(document, 'createRange', { value: range, configurable: true });
	return { document, root, range: range() as unknown as Range };
}

describe('text-selected learning moments', () => {
	it('maps a selection across formatting and paragraphs to stable visible-text offsets', () => {
		const { root, range } = fixture('<p>Force changes <strong>velocity</strong>.</p><p>Motion can continue.</p>');
		const start = root.querySelector('p')!.firstChild!;
		const end = root.querySelectorAll('p')[1]!.firstChild!;
		range.setStart(start, 6); range.setEnd(end, 6);
		const anchor = momentSelectionFromRange(root, range)!;
		assert.ok(anchor); assert.equal(momentDisplay(root).text, 'Force changes velocity. Motion can continue.');
		const restored = resolveMomentSelection(root, anchor)!;
		assert.equal(restored.excerpt, 'changes velocity. Motion');
		assert.equal(restored.range.startContainer, start); assert.equal(restored.range.startOffset, 6);
		assert.equal(restored.range.endContainer, end); assert.equal(restored.range.endOffset, 6);
	});
	it('distinguishes repeated phrases and refuses stale anchors after source content changes', () => {
		const { root, range } = fixture('<p>Force changes motion. Force changes motion.</p>');
		const text = root.querySelector('p')!.firstChild!;
		range.setStart(text, 22); range.setEnd(text, 27);
		const anchor = momentSelectionFromRange(root, range)!;
		assert.equal(resolveMomentSelection(root, anchor)!.range.startOffset, 22);
		(root.querySelector('p')!.firstChild as Text).data = 'A new explanation replaces the source.';
		assert.equal(resolveMomentSelection(root, anchor), null);
	});
	it('excludes controls, drafts, hidden math copies, collapsed text and nested explorations', () => {
		const { root } = fixture('<p>Visible <em>reasoning</em>.</p><button>Copy</button><textarea>draft</textarea><span class="katex-mathml">hidden TeX</span><details><summary>Thinking</summary><p>hidden reasoning</p></details><div data-learning-moment-ui>saved marker</div><div data-exploration-id="child">Child title</div><div data-testid="exploration-starter">What would you like to explore?</div><div data-source-message-id="child-message">Nested child</div>');
		assert.equal(momentDisplay(root).text, 'Visible reasoning. Thinking');
	});
	it('keeps offsets independent of newly added marker controls', () => {
		const { root, document } = fixture('<p>Conservation follows from symmetry.</p>');
		const initial = momentDisplay(root).text;
		const control = document.createElement('div'); control.setAttribute('data-learning-moment-ui', ''); control.textContent = 'This clicked · passage 1'; root.append(control);
		assert.equal(momentTextFingerprint(momentDisplay(root).text), momentTextFingerprint(initial));
	});
	it('rejects selections spanning different messages or a different exploration scope', () => {
		const { root, document, range } = fixture('<p>First message.</p>');
		const other = document.createElement('div'); other.setAttribute('data-source-message-id', 'm2'); other.textContent = 'Second message.'; root.parentElement!.append(other);
		range.setStart(root.querySelector('p')!.firstChild!, 0); range.setEnd(other.firstChild!, 6);
		Object.defineProperty(document, 'getSelection', { value: () => ({ isCollapsed: false, rangeCount: 1, getRangeAt: () => range }) });
		assert.equal(readMomentSelection(document, 'lesson'), null);
		range.setEnd(root.querySelector('p')!.firstChild!, 5);
		assert.ok(readMomentSelection(document, 'lesson'));
		assert.equal(readMomentSelection(document, 'child'), null);
		const nested = document.createElement('div'); nested.setAttribute('data-learning-chat-id', 'child'); nested.innerHTML = '<div data-source-message-id="m1">Child</div>'; root.parentElement!.append(nested);
		assert.deepEqual(momentRoots(root.parentElement!, 'm1'), [root]);
	});
});
