import { createHash } from "node:crypto";
import type { CodeActivitySpec } from "../core/code-activity.ts";

/** Digest of the ordered execution inputs: resources (id, path, role, content),
 *  target, the effective ordered build sources, check definitions, and profile ID/version. Independent of workspace
 *  identity and of the source-only edit revision. */
export function executionSnapshotId(spec: CodeActivitySpec, buildSources: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify([
		spec.schemaVersion,
		spec.profile.id,
		spec.profile.version,
		spec.resources.map(resource => [resource.id, resource.path, resource.role, resource.editable, resource.content]),
		spec.target,
		// The effective, ordered build selection: a trusted override can run a different program.
		buildSources,
		spec.check,
	])).digest("hex");
}
