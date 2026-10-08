# InsureMO DSH Desktop

An independent Electron shell for the official DeepSeek DSH runtime and the
InsureMO Workbench plugin. The desktop application owns windows, process
lifecycle, profile transactions, and trusted plugin management; Harness owns
Agent, Session, Skills, Explain, and iComposer behavior.

## Status

E00–E09 are implemented at the source/contract level. macOS arm64 packaging
has real evidence; Windows native execution and final distribution signing are
runner/credential gates. The Windows Job Object supervisor, NSIS pipeline,
upgrade snapshots, four rollback boundaries, and release receipts are in
place.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm dev
pnpm build
```

The development app uses a separate Electron user-data directory. It does not
read or write a user's ordinary DSH home.

E07 packaging (the Workbench path is supplied by the release operator and is
hash-checked):

```bash
DSH_WORKBENCH_TGZ=<verified-workbench.tgz> pnpm package:e07:arm64:dir
DSH_WORKBENCH_TGZ=<verified-workbench.tgz> pnpm package:e07:full:arm64:mac
APP=release/mac-arm64-Full/mac-arm64/InsureMO\ DSH\ Desktop.app
node scripts/run-e07-packaged-smoke.mjs "$APP/Contents/MacOS/InsureMO DSH Desktop"
pnpm smoke:e07:diagnosis "$APP"
node scripts/record-e07-full-release.mjs
```

The macOS arm64 **Full** release set is `release/mac-arm64-Full/`:
the `InsureMO DSH Desktop-Full-<version>-arm64.dmg` and `.zip` plus the
`SHA256SUMS.txt` written by `record-e07-full-release.mjs`. Blockmaps,
`latest-mac.yml`, and any older Thin/Full package that still exists elsewhere
under `release/` are **not** release artifacts and must not be uploaded.
`docs/evidence/e07-full-release.json` records the filenames, byte sizes,
SHA256 values, the source-tgz → runtime-manifest → DMG/ZIP app chain, the smoke
results, and the signature state.

These Full artifacts are **development-only**: the build is unsigned (adhoc)
and not notarized, so a downloaded copy is blocked by Gatekeeper until the user
explicitly allows it. A distributable release requires the CSC/notarization
environment described below and in `docs/release-evidence-checklist.md`; do not
present an unsigned package as a public release.

`package:e07:arm64:dir` is an unsigned development directory by default;
`signed-dir` uses the configured local signing identity and refreshes the
post-sign resource manifest. The two smoke runners use explicit test-only
`DSH_DESKTOP_TEST_USER_DATA` seams so clean-user-data tests do not depend on
macOS HOME handling. `smoke:e07:diagnosis` uses a temporary fake `npx` which
exits non-zero; it never performs a registry/global install or model request.
Distribution builds provide the CSC/Apple notarization environment variables
described in `docs/evidence/e07-packaging.md`.

The exact source-to-desktop synchronization order, Workbench hash, runtime
provenance, manual install backup, and rollback procedure are documented in
[`docs/workbench-sync.md`](docs/workbench-sync.md).

E08 Windows packaging runs on a native Windows x64 runner:

```powershell
$env:DSH_WORKBENCH_TGZ = "<verified-workbench.tgz>"
pnpm build:e08:supervisor
pnpm build:e08:resources
pnpm exec electron-builder --win nsis --x64 --publish never
pnpm scan:e08:artifacts
pnpm smoke:e08:win
```

See `docs/windows-build-and-verification.md` for the required normal/safe,
plugin, Job Object/orphan, Defender, and Unicode-space-path evidence. E09
release receipts and rollback policy are in `docs/release-evidence-checklist.md`.


## Security boundary

ADR-0001 records the selected v1 policy: same-user local trust. Harness binds
to `127.0.0.1` and uses an OS-assigned port; a random port is not
authentication and this policy does not defend against a hostile local process.
A future strong-auth mode requires an official Harness seam covering HTTP,
static assets, SSE, and WebSocket routes; a reverse proxy or patch layer is not
presented as authentication.

The Harness window has no privileged preload. Only locally packaged windows
receive narrow, capability-scoped IPC. IPC authorization checks the expected
window, main frame, exact origin, and capability before handling a request.

## Version policy

All installed direct dependencies are exact pins. The runtime contract targets
Electron 43.4.0, pnpm 11.7.0, and official DSH 0.1.0-rc.7; standalone bundled
Node is 24.9.0 where that runtime mode is used.
The exact E07 packaging pin is `electron-builder@26.0.12`; it is installed and
locked in `pnpm-lock.yaml`. On macOS E07 the runtime manifest intentionally
records Node `24.18.1`: this is Electron `43.4.0`'s embedded Node used in
`electron-run-as-node` mode. The `24.9.0` Node contract remains for the
standalone bundled-node mode used by other targets (including Windows E08);
it is not a macOS runtime drift. The resource preparation step uses a
one-command `block-exotic-subdeps=false` resolution seam only to admit
electron-builder's pinned `@electron/node-gyp` git dependency; subsequent
frozen installs use the lockfile.
