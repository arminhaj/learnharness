"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "lucide-react";

export function ChemistryDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
	const ref = useRef<HTMLDialogElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const dialog = ref.current;
		dialog?.showModal();
		return () => { dialog?.close(); previous?.focus(); };
	}, []);
	if (typeof document === "undefined") return null;
	return createPortal(
		<dialog ref={ref} data-chemistry-dialog="" data-chemistry-interactive="" aria-label={title}
			className="fixed inset-0 z-[100] m-auto max-h-[92dvh] w-[min(1100px,96vw)] max-w-none overflow-auto rounded-xl border border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50"
			onCancel={(event) => { event.preventDefault(); closeRef.current(); }}
			onKeyDown={(event) => { event.stopPropagation(); }}>
			<header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
				<h2 className="text-base font-medium">{title}</h2>
				<button type="button" aria-label="Close molecule view" onClick={onClose} className="rounded-md p-2 hover:bg-accent"><XIcon className="size-4" /></button>
			</header>
			<div className="p-4">{children}</div>
		</dialog>, document.body,
	);
}
