# E07 dependencies

`electron-builder@26.0.12` is the exact packaging pin selected by the desktop
plan and is now restored in `devDependencies` and `pnpm-lock.yaml`.

pnpm 11.7.0 rejects electron-builder's pinned `@electron/node-gyp` git
subdependency when resolving from scratch with `blockExoticSubdeps` enabled.
The release preparation command uses the one-time explicit
`--config.block-exotic-subdeps=false` option while resolving; the resulting
commit/tarball is recorded in the lockfile, and subsequent frozen installs
complete successfully. This is not a version substitution or an automatic
resolution.

The packaging step materializes a production-only runtime tree containing:

- Node `24.9.0` darwin arm64 and x64 binaries (official SHA checked);
- pnpm `11.7.0` JS entry/package;
- the complete `@deepseek-ai/dsh*` rc7 graph;
- the verified Workbench tgz and runtime/profile wrapper/native helpers.

The initial package is `asar:false` so the external Node/ESM/plugin graph and
native helpers remain directly loadable. Unsigned zip/DMG output is explicitly
development-only. Developer ID signing and Apple notarization use the
CSC/Apple environment seam documented in `docs/evidence/e07-packaging.md`.
Version changes require a new compatibility review and packaged validation.
