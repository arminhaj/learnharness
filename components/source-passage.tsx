import type { ComponentProps } from "react";
import { messageAnchorId } from "@/src/core";
import { cn } from "@/lib/utils";
import { MarkLearningMoment } from "./learning-moments";

/** A stable native-message anchor shared by prose and structured answers. */
export function SourcePassage({ messageId, className, children, ...props }: ComponentProps<"div"> & { messageId?: string }) {
	return <div {...props} id={messageId ? messageAnchorId(messageId) : undefined} data-source-message-id={messageId} className={cn("lh-source-passage", className)}>{children}{messageId && <MarkLearningMoment messageId={messageId} />}</div>;
}
