# Workbench-to-Desktop synchronization (TASK-087 / TASK-138)

This runbook updates the Desktop's bundled Workbench without changing DSH
core. The current accepted pair is:

| component | accepted source |
| --- | --- |
| Workbench source | `icomposer-workbench` commit `8119f0c` (`fix(ici): make read-range mistakes correctable and label every error honestly`) |
| Workbench artifact | `icomposer-workbench-0.1.0.tgz`, SHA256 `52b75abfb6fcfe6d1a42c1618fc6307b3a190ea51ea58ac4d17dabc7250776c7` |
| Desktop runtime | official DSH `0.1.0-rc.7`, macOS E07 runtime graph |
| macOS runtime mode | Electron `43.4.0` `electron-run-as-node`, embedded Node `24.18.1` |
| Desktop target | macOS arm64 Full development `.app` directory |

Release state (2026-10-08): `8119f0cd2cd036d84f7351c82339ff00427f95f9` is
published on the Workbench **`desktop`** branch (TASK-137 fast-forward push,
`bd062731..8119f0cd`, 13 commits, `desktop`→`desktop`). The Workbench `main`
branch still points at the earlier accepted baseline `737dbcb` — `main` is also
`origin/HEAD`, the repository default — so this sync depends on the `desktop`
branch and not on `main` moving. The accepted Desktop artifact is the tarball
that TASK-136 built from `8119f0c` and deployed as the Workbench update.
TASK-138 re-verified that tarball against a fresh `pack:dist` of the same tree
before pinning it here. Desktop is a separate repository and is not pushed by
this task; the accepted source is identified by commit and artifact hash, not
by branch name.

### Accepted-artifact provenance (read before re-verifying)

`pack:dist` is **not byte-reproducible**: the generated client bundle emits its
CSS-module class map as an object literal whose key order varies between
builds, so two consecutive packs of the same commit produce two different
tarballs with identical content and identical byte size (observed 2026-10-08:
`07cf9cc1…` and `17007a2c…`, both from `8119f0c`, both differing from the
accepted `52b75abf…` only in that key order). Therefore:

- the pinned SHA256 identifies **one frozen artifact**, not a rebuild recipe;
- a verifier must hash the frozen tarball (and the Desktop copy of it) rather
  than re-running `pnpm pack:dist` and expecting the same digest;
- if the Workbench is ever re-packed, the three Desktop identity copies, the
  diagnosis-smoke default and this table must be re-pinned in the same change
  and the Desktop `.app` rebuilt against that new tarball.

Running the Workbench test suite also rewrites the tracked
`icomposer-workbench/docs/compat-audit.json` snapshot; treat that file as a
scratch output of `scripts/audit-compat.mjs` and restore it instead of
committing it in a sync task.

The Workbench build checkout may use its own pinned build-time Harness
checkout (`compatibility.json` in the Workbench repository currently names
local commit `85d8062c8a` for type checking). That checkout is **not** copied
into Desktop. Desktop packages only the verified Workbench tarball and the
stock npm DSH `0.1.0-rc.7` runtime. Do not point a build at a user's profile,
`~/.dsh`, a `vendor` directory, or a Harness checkout carrying local
080–082 patches. Do not replace rc.7 with an alpha/prerelease automatically.

## 1. Build and verify the Workbench artifact

Set absolute paths in a shell. The paths below are placeholders, not a
request to use a user's data directory:

```bash
export WB_REPO=/path/to/icomposer-workbench
export DESKTOP_REPO=/path/to/insuremo-dsh-desktop
export WB_TGZ="$WB_REPO/dist-release/icomposer-workbench-0.1.0.tgz"
export WB_SHA=52b75abfb6fcfe6d1a42c1618fc6307b3a190ea51ea58ac4d17dabc7250776c7

cd "$WB_REPO"
# The accepted commit is on the Workbench 'desktop' branch; 'main' still carries the older baseline.
test "$(git rev-parse --short=7 HEAD)" = 8119f0c
pnpm install --frozen-lockfile
pnpm check
pnpm bundle
pnpm typecheck
pnpm test
pnpm pack:git-dist
pnpm check:git-dist
pnpm pack:dist
printf '%s  %s\n' "$WB_SHA" "$WB_TGZ"
test "$(shasum -a 256 "$WB_TGZ" | awk '{print $1}')" = "$WB_SHA"
```

Use the actual full commit ID printed by `git rev-parse`; the short id above
is an operator checkpoint, not a fabricated full hash. `pnpm bundle` refreshes
the source UI bundles. `pack:git-dist` refreshes the tracked GitHub `#path`
payload and `check:git-dist` checks it. `pack:dist` then rebuilds the
prebuilt `lib/` payload and creates the primary npm tarball. The final SHA256
check is mandatory; do not copy an unverified tarball into Desktop.

A Desktop **pin-only** sync (TASK-138) runs `pnpm check`, `pnpm bundle`,
`pnpm typecheck`, `pnpm test` and `pnpm pack:dist` only. `pack:git-dist` /
`check:git-dist` are deliberately skipped: they rewrite the tracked `git-dist/`
payload, which is a separate Workbench publication artifact, and a Desktop sync
must leave every Workbench tracked file untouched. Because a fresh `pack:dist`
does not reproduce the pinned digest (see *Accepted-artifact provenance*), use
it to confirm the shipped file set and content and then pin the frozen artifact
you actually ship; never let a rebuild silently move an already-pinned
Desktop hash.

If the Workbench source checkout does not have its declared build-time Harness
checkout, stop at `pnpm check` and obtain the exact declared build dependency.
Do not silently substitute a public alpha or a user's installed profile. A
Desktop package built from the already accepted tarball can be verified
without copying that build checkout into the runtime.

## 2. Sync the Desktop compatibility mapping and resources

The Desktop has three intentional copies of the Workbench artifact identity:
`compatibility.json`, `src/main/upgrade/compatibility.ts`, and
test/support/workbench.ts. Update all three to the same full SHA256. The
runtime preparation script refuses an absent artifact and writes the same hash
into `packaging/e07/runtime/manifest.json`.

```bash
cd "$DESKTOP_REPO"
# The following command is read-only and must print WB_SHA.
shasum -a 256 "$WB_TGZ"
grep -n '52b75abfb6fcfe6d1a42c1618fc6307b3a190ea51ea58ac4d17dabc7250776c7' \
  compatibility.json src/main/upgrade/compatibility.ts test/support/workbench.ts

# This rebuilds the ignored E07 runtime directory only; it does not install an
# app or alter Applications. It uses the existing exact rc.7 lock/pins.
DSH_RUNTIME_ARCH=arm64 DSH_WORKBENCH_TGZ="$WB_TGZ" pnpm build:e07:resources

node - <<'NODE'
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const expected = process.env.WB_SHA
const manifest = JSON.parse(readFileSync('packaging/e07/runtime/manifest.json', 'utf8'))
const bundled = 'packaging/e07/runtime/' + manifest.workbench.path
const actual = createHash('sha256').update(readFileSync(bundled)).digest('hex')
if (expected && actual !== expected) throw new Error(`runtime Workbench mismatch: ${actual}`)
if (manifest.workbench.sha256 !== actual) throw new Error('runtime manifest Workbench hash mismatch')
if (manifest.runtimeVersion !== '0.1.0-rc.7' || manifest.nodeMode !== 'electron-run-as-node') throw new Error('unexpected stock E07 runtime')
console.log(JSON.stringify({ runtimeVersion: manifest.runtimeVersion, nodeVersion: manifest.nodeVersion, runtimeArch: manifest.runtimeArch, nodeMode: manifest.nodeMode, workbenchSha256: actual, files: manifest.files.length }, null, 2))
NODE
```

The command intentionally does not change `config/runtime-pins.json`: its
`0.1.0-rc.7` value pins the DSH package graph. On macOS E07,
`electron-run-as-node` uses the Node version embedded by Electron
(`24.18.1`); the standalone bundled-node contract remains `24.9.0` for other
runtime modes/targets. This is an intentional mode distinction, not a reason
to change the rc.7 package pin.

Run the Desktop source checks before packaging:

```bash
pnpm audit:runtime-pins
pnpm typecheck
pnpm test
pnpm check:lines
pnpm check:e00
```

## 3. Produce the local Full arm64 `.app` directory

This is the primary deliverable for this task. It writes only the repository's
ignored `release/mac-arm64-Full` output. It does **not** copy anything into
`/Applications` and it does not use the real Desktop userData.

```bash
cd "$DESKTOP_REPO"
DSH_WORKBENCH_TGZ="$WB_TGZ" pnpm package:e07:full:arm64:dir
APP="$DESKTOP_REPO/release/mac-arm64-Full/mac-arm64/InsureMO DSH Desktop.app"
test -x "$APP/Contents/MacOS/InsureMO DSH Desktop"
```

The `package:e07:full:arm64:dir` script runs `pnpm build`, prepares the
verified E07 resources, and invokes electron-builder with the Full marker and
arm64 output directory. The existing icon generation and single-window
activation fixes remain in the source; no icon or window code is replaced by
this sync.

Thin remains an external-runtime variant. This task does not claim a Thin
rebuild on this arm64 run. Its shared rc.7 pin and runtime verification can be
checked with `pnpm audit:runtime-pins`; build and execute Thin only as a
separate, explicitly selected operator action:

```bash
# Optional operator action; not part of the TASK-138 arm64 Full evidence.
DSH_WORKBENCH_TGZ="$WB_TGZ" pnpm package:e07:thin:arm64:dir
```

Windows and macOS x64 are not verified on this host.

## 4. Isolated packaged diagnosis smoke

Run the dedicated smoke against the newly built Full app directory:

```bash
cd "$DESKTOP_REPO"
DSH_DIAGNOSIS_CANARY=TASK-138-$(date +%s) \
  DSH_DIAGNOSIS_APP="$APP" \
  pnpm smoke:e07:diagnosis
```

The script accepts the app path as its first argument as well, so the
unambiguous form is:

```bash
DSH_DIAGNOSIS_CANARY=TASK-138-$(date +%s) \
  node scripts/run-e07-diagnosis-smoke.mjs "$APP"
```

The smoke creates a temporary `userData`, `HOME`, npm cache/prefix/config,
XDG directories, and a `fakebin` containing a failing `npx` plus a read-only
`npm` shim. The fake `npx` prints synthetic stdout/stderr containing the
canary and exits 1. The read-only shim answers only the real IMO launcher's
local version/registry probes; it has no install branch. PATH puts these
fixtures before standard paths; the configured registry remains
`http://127.0.0.1:9/`. Thus the scenario's real host capture and real HTTP/UI
flow are exercised without a real registry/global install. No model is
selected and no prompt is sent.

A successful result (`ok: true`, process exit 0) proves all of the following:

- the packaged app boots stock rc.7 and exposes the Workbench card;
- the Skills scenario reaches a failed state through exactly two synthetic `npx`
  invocations of the same `@insuremo/skills-tool add insuremo-skills` command
  (a bootstrap add and the scenario-scoped `-s icomposer-full-stack` add), each
  emitted by the fake `npx` shim and each exiting 1 — the per-invocation argv is
  recorded in `fakeNpxTrace` so a change in that flow is visible, not silent;
- clicking Diagnose creates/reuses the dedicated `install-diagnostics`
  Workspace under the isolated Harness home;
- the current composer is editable and contains the canary diagnostic draft;
- the model-selection entry is visible and enabled but is not clicked;
- the draft remains after a delay, no prompt/completion/chat request is made,
  and console/page exceptions are empty; Electron's own DevTools/sandbox
  bootstrap error (if the debugged page reports it) is recorded separately in
  `consoleIgnored` and does not mask application errors;
- the embedded tarball hash, installed `lib/client.js` hash, and served client
  hash agree with the expected Workbench SHA.

The result is written to `/tmp/e07-diagnosis-smoke-result.json`; the packaged
app log is `/tmp/e07-diagnosis-packaged.log`; the isolated root is printed as
`smokeRoot` in the result. These are temporary evidence paths, not user
configuration. Remove the printed `smokeRoot` manually after inspection if
desired.

The existing general packaged smoke remains useful for normal/safe boot,
brand asset, plugin install/remove, loopback, and orphan cleanup. It expects
an executable, not the `.app` directory; pass the Full arm64 binary explicitly:

```bash
APP_BINARY="$APP/Contents/MacOS/InsureMO DSH Desktop"
test -x "$APP_BINARY"
node scripts/run-e07-packaged-smoke.mjs "$APP_BINARY"
```

That smoke does not replace the diagnosis smoke's canary and composer
assertions.

## 5. Hash and source verification

For an app directory, verify the exact chain without reading or writing a
production profile:

```bash
# Reuse the isolated userData from the successful smoke result (never a
# production userData directory).
USERDATA=$(node -p "require('/tmp/e07-diagnosis-smoke-result.json').userData")
RUNTIME="$APP/Contents/Resources/dsh-runtime"
MANIFEST="$RUNTIME/manifest.json"
TARBALL="$RUNTIME/workbench/icomposer-workbench.tgz"
INSTALLED="$USERDATA/harness/profiles/web/node_modules/@icomposer/workbench/lib/client.js"
shasum -a 256 "$WB_TGZ" "$TARBALL"
node - "$MANIFEST" "$TARBALL" "$INSTALLED" <<'NODE'
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const [manifestPath, tarPath, installedPath] = process.argv.slice(2)
if (!manifestPath || !tarPath || !installedPath) throw new Error('usage: node - <manifest> <tarball> <installed-client>')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const tarClient = Buffer.from(execFileSync('tar', ['-xOf', tarPath, 'package/lib/client.js']))
const installed = readFileSync(installedPath)
console.log(JSON.stringify({
  runtimeManifestSha256: digest(readFileSync(manifestPath)),
  tarSha256: digest(readFileSync(tarPath)),
  manifestWorkbenchSha256: manifest.workbench.sha256,
  tarClientSha256: digest(tarClient),
  installedClientSha256: digest(installed),
}, null, 2))
if (manifest.workbench.sha256 !== digest(readFileSync(tarPath)) || digest(tarClient) !== digest(installed)) process.exit(1)
NODE
```

The final served-client comparison is included in
`smoke:e07:diagnosis`. It fetches `/plugins/@icomposer/workbench/client.js`
from the actual packaged Harness page and compares its SHA256 to the installed
client, closing the tar → installed profile → served bytes chain.

## 6. Manual installation, backup, and rollback (operator action only)

Opening the generated app in place is non-destructive and is preferred for
review:

```bash
open "$APP"
```

Do not run a copy into `/Applications` as part of a build or smoke. If a user
explicitly chooses to install it, first close the running Desktop and make
separate backups of the existing app and (if desired) its Desktop userData.
The following commands are examples and require that explicit confirmation:

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$HOME/Desktop/insuremo-dsh-backup-$STAMP"
mkdir -p "$BACKUP"
if [ -d "/Applications/InsureMO DSH Desktop.app" ]; then
  ditto "/Applications/InsureMO DSH Desktop.app" "$BACKUP/InsureMO DSH Desktop.app"
fi
if [ -d "$HOME/Library/Application Support/InsureMO DSH Desktop" ]; then
  ditto "$HOME/Library/Application Support/InsureMO DSH Desktop" "$BACKUP/userData"
fi
# Only after reviewing the backup and explicitly approving replacement:
ditto "$APP" "/Applications/InsureMO DSH Desktop.app"
```

To roll back the app bundle, close Desktop and restore the saved app bundle:

```bash
ditto "$BACKUP/InsureMO DSH Desktop.app" "/Applications/InsureMO DSH Desktop.app"
```

If the upgraded app has already changed profile/session state, restore the
separately backed-up `userData` only after explicitly deciding to roll back
those user records too; app-bundle rollback alone does not erase or rewrite
user data. Never use `rm -rf` against an unknown production path. The Desktop
upgrade manager's normal snapshot/rollback paths remain available for a
separately authorized in-app upgrade; this task does not invoke them.
