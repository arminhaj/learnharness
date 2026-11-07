/** Serializable runtime readiness, kept apart from the catalog's descriptors.
 *  Servers compute it on demand and pass it across existing service boundaries.
 *  It informs the UI and execution only; it never gates saved-content parsing. */
export interface CodeProfileReadiness {
	profileId: string;
	state: "ready" | "unavailable";
	/** Human-readable explanation, e.g. what to install when unavailable. */
	message?: string;
	toolchain?: { id: string; version?: string };
}
