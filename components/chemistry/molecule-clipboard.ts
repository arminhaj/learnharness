/** Some browser permission prompts leave readText pending indefinitely. A
 * bounded read lets the editor offer its ordinary manual paste field. */
export async function readStructureClipboard(read: () => Promise<string> = () => navigator.clipboard.readText(), timeoutMs = 1_500): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			read(),
			new Promise<string>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Paste the molecular structure manually.")), timeoutMs); }),
		]);
	} finally { if (timer) clearTimeout(timer); }
}
