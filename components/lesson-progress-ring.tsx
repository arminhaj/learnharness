"use client";

import { useRef, useState } from "react";
import { lessonProgress, type PlanTree } from "@/src/core";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { Hint } from "@/components/ui/hint";

export function LessonProgressRing({ tree }: { tree: PlanTree | null }) {
 const [open, setOpen] = useState(false);
 const root = useRef<HTMLDivElement>(null);
 usePopoverDismiss(root, open, () => setOpen(false));
 const progress = lessonProgress(tree);
 const label = progress.total ? `${progress.percent}% of lesson completed` : "Lesson progress: Not started";
 const circumference = 2 * Math.PI * 6;
 return <div ref={root} className="lh-no-drag relative shrink-0">
  <Hint label={label} side="bottom">
   <button type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="lesson-progress-ring">
    <svg viewBox="0 0 16 16" className="size-5" aria-hidden="true">
     <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" className="stroke-border" />
     {progress.count > 0 && <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" className="stroke-foreground/70" strokeDasharray={`${progress.count / progress.total * circumference} ${circumference}`} strokeLinecap="round" transform="rotate(-90 8 8)" />}
    </svg>
    <span className="tabular-nums">{progress.total ? `${progress.percent}%` : "Not started"}</span>
   </button>
  </Hint>
  {open && <div className="absolute top-full right-0 z-40 mt-1.5 w-72 rounded-xl border bg-card p-3 text-xs shadow-xl">
   <div className="font-medium">Lesson completion</div>
   <p className="my-2 text-muted-foreground">{progress.total ? `${progress.count} of ${progress.total} plan steps completed (${progress.percent}%).` : "Not started — a lesson plan has not been created yet."}</p>
   <ul className="max-h-64 space-y-2 overflow-y-auto">{tree?.nodes.map(node => <li key={node.id} className="flex justify-between gap-3"><span>{node.title}</span><span className="shrink-0 text-muted-foreground">{progress.completed.has(node.id) ? "Complete" : "Remaining"}</span></li>)}</ul>
   <p className="mt-3 text-muted-foreground">Each step counts equally. The tutor marks steps complete as their learning goals are met.</p>
  </div>}
 </div>;
}
