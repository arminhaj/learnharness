import { mkdir, copyFile, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const out = new URL('public/chemistry/', root);
await mkdir(out, { recursive: true });
const rdkit = dirname(require.resolve('@rdkit/rdkit'));
for (const file of ['RDKit_minimal.js', 'RDKit_minimal.wasm']) {
  await copyFile(join(rdkit, file), new URL(file, out));
}
await copyFile(new URL('node_modules/3dmol/build/3Dmol-min.js', root), new URL('3Dmol-min.js', out));
await copyFile(new URL('node_modules/3dmol/build/3Dmol-min.js.LICENSE.txt', root), new URL('3Dmol-min.js.LICENSE.txt', out));
await copyFile(new URL('node_modules/3dmol/LICENSE', root), new URL('3Dmol-LICENSE', out));
// The RDKit and Ketcher npm packages omit their upstream license files.
// Keep the versioned notices alongside the assets in web and desktop builds.
await cp(new URL('third-party/chemistry/', root), new URL('licenses/', out), { recursive: true });
console.log('Prepared local chemistry rendering assets.');
