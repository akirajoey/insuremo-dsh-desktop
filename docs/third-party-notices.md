# Third-party notices

E00 introduces the project boundary only. E07's generated packaging directory
contains the release-time runtime graph; it is not hand-maintained source.
The planned runtime and UI dependencies are consumed under their upstream licenses. Before a distributable package is produced, the release process must
materialize a generated SBOM and complete notices for Electron, React, Vite,
TypeScript, Vitest, electron-builder, the official DSH runtime, bundled Node,
pnpm, native helpers, and all transitive dependencies.

## E07 generated inventory

The arm64 packaged runtime generated `docs/evidence/e07-sbom.json` (534
components, 28 native `.node`/helper files, zero unknown license fields). Its
resource manifest records every regular file hash and every symlink target
metadata entry. `docs/evidence/e07-artifacts.json` records the relative
artifact paths, byte sizes, SHA256 values, runtime/workbench hashes, and
arm64 signed/x64 unsigned directory status. `docs/evidence/e07-scan.json`
records the release scan: zero source maps, test resources, absolute
machine-development paths, and token-like material.

The generated inventory is evidence, not a replacement for upstream license
texts. A distribution release must retain each package's license/NOTICE text
and provide signing/notarization credentials; the current unsigned zip/DMG
are development artifacts and the arm64 signed directory uses the locally
available Apple Development identity.
