# Chemistry dependency notices

These files are unmodified copies from the official release sources matching
the chemistry packages in `package-lock.json`:

| Packages | Version | Files and upstream source |
| --- | --- | --- |
| `@rdkit/rdkit` | 2026.9.1 | [RDKit-LICENSE.txt](RDKit-LICENSE.txt), from [RDKit Release_2026_09_1](https://github.com/rdkit/rdkit/blob/Release_2026_09_1/license.txt) |
| `ketcher-core`, `ketcher-react`, `ketcher-standalone` | 3.18.0 | [Ketcher-LICENSE.txt](Ketcher-LICENSE.txt) and [Ketcher-NOTICE.txt](Ketcher-NOTICE.txt), from [Ketcher v3.18.0 LICENSE](https://github.com/epam/ketcher/blob/v3.18.0/LICENSE) and [NOTICE](https://github.com/epam/ketcher/blob/v3.18.0/NOTICE) |
| `indigo-ketcher` (embedded by Ketcher standalone) | 1.46.0 | [Indigo-LICENSE.txt](Indigo-LICENSE.txt), from [Indigo indigo-1.46.0](https://github.com/epam/Indigo/blob/indigo-1.46.0/LICENSE) |

`npm run chemistry:assets` copies this directory to `public/chemistry/licenses/`
for redistribution with the application. It also copies the installed `3dmol`
2.5.5 package's `LICENSE` and generated bundle notice directly beside
`3Dmol-min.js`; its [official license](https://github.com/3dmol/3Dmol.js/blob/2.5.5/LICENSE)
includes the upstream GLmol, Three.js, and jQuery notices. Update these copies
when updating the corresponding dependency versions.
