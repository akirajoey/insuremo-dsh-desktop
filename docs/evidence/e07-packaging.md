# E07 macOS packaging evidence

Date/host: macOS arm64 development host. Electron `43.4.0`,
electron-builder `26.0.12`, `asar:false`. The package configuration has an
explicit `extraResources` entry for `dsh-runtime` and a signing/notarization
environment seam (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).

## Resource preparation

Command (workbench path is supplied by the release operator and is not stored
in source):

```text
DSH_RUNTIME_ARCH=arm64 DSH_WORKBENCH_TGZ=<verified-workbench.tgz> pnpm build:e07:resources
```

The script downloaded the official Node `v24.9.0` archives and verified the
published SHA256 values before extraction:

- darwin-arm64: `961024296c2a8e60daed0784f8b61e0fab5c51d197502a92eff052c72b53209b`
- darwin-x64: `6c9ac12d3160538d96d456dc59a8fec1479e3f8b20bfc0d61bc809eb9ec11417`

`dsh-runtime` contains both Node targets, pnpm `11.7.0` JS entry/package, a
production-only complete DSH graph at `0.1.0-rc.7`, Workbench tgz, wrapper,
and runtime/profile helpers. The resource manifest contains **27,781**
entries, including regular-file size/content hashes and explicit symlink
target metadata. No temporary stage symlink escapes the runtime tree.

Before packaging, `.map`, test/example/fixture directories, pnpm's
machine-specific `.modules.yaml`, and other test resources are removed. A
post-build scan reports zero source maps, test resources, absolute development
paths, and token-like material (`docs/evidence/e07-scan.json`). Its findings
SHA256 is `47df91ebee5b8a7e335dfe1d559f9e5f5de780a8fb62bfa12f425e5c5ecdc781`.

## Builder commands and artifacts

```text
pnpm build
CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac zip dmg --arm64 --publish never
CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --dir --x64 --publish never
```

The arm64 zip and DMG builder run both exited 0:

- `release/InsureMO DSH Desktop-0.1.0-arm64-mac.zip` — 257,389,420 bytes,
  SHA256 `654be8137c0063c19eb3842a94cdd15e589c8e6b9b0dd1210d903938d3338a97`
  (blockmap `386a5d50b78e188774dfd02e5ab8728b7fd10d16b3e2f74c7293082ca07c7513`)
- `release/InsureMO DSH Desktop-0.1.0-arm64.dmg` — 252,708,362 bytes,
  SHA256 `c811fa0e268d6452861dfde233db12dad64f9901da584d24944316b3d4aa01b1`
  (blockmap `b872c36ff6af9cae27137abed68ee89ff8835210592145158cc04410f1a128a2`)

The final signed arm64 directory is
`release/mac-arm64-signed/InsureMO DSH Desktop.app` (approximately 774 MiB).
`codesign --verify --deep --strict` reports `valid on disk` and
`satisfies its Designated Requirement`; identity is the host's Apple
Development identity `ZG29WGT668`. The finalizer preserves hardened runtime
(`codesign -d` reports Runtime Version 26.4.0). The unsigned arm64 directory is
also retained for development artifact inspection. The x64 `--dir` target
built successfully at `release/mac/InsureMO DSH Desktop.app` with the x64
resource graph and is intentionally not run on this arm64 host; native x64
execution belongs on a native x64 runner, not Rosetta.

`docs/evidence/e07-artifacts.json` records all artifact relative paths,
byte sizes, SHA256 values, directory manifest hashes, Node hashes, Workbench
hash (`b1019017b79782a97b0b980268c2250384446ae5bbed8cb62af41c0754bdc59f`),
and signed/unsigned status. The arm64 signed and all unsigned app manifests
were independently rehashed after packaging; all 27,781 entries pass.

## Clean packaged matrix

`scripts/run-e07-packaged-smoke.mjs` launches the actual arm64 app with the
explicit test-only `DSH_DESKTOP_TEST_USER_DATA` → `app.setPath('userData',
...)` seam, never relying on `HOME` or `--user-data-dir`. It runs normal and
safe phases with real process shutdown:

- normal: Workbench is installed from the bundled verified tgz using bundled
  Node/pnpm; visible Workbench wordmark is 99×24 and its host asset route is
  HTTP 200; packaged Plugin Manager installs/removes the tgz test bundle;
- runtime binds loopback only: LAN probe is not reachable (`TypeError` from
  refused/aborted connection);
- normal `app.quit()` exits code 0, removes ownership, and leaves no wrapper
  orphan;
- safe: independent safe profile boots and page renders; normal profile keeps
  Workbench while safe manifest has no Workbench;
- before/after snapshot of pre-existing `~/.dsh` is unchanged.

Result: `E07 packaged smoke result ok:true`, with
`normal.plugin = {install:true, remove:true, gone:true}`,
`normal.brandStatus = 200`, `safe.manifest = {normalWorkbench:true,
safeWorkbench:false}`, `homeDshUnchanged = true`, and `orphanWrappers = []`.
The complete redacted result is retained in the local smoke log/result file;
no machine path is committed here.

## SBOM/notices/signing residual

`docs/evidence/e07-sbom.json` contains **534 components**, **28 native
`.node`/helper files**, and zero unknown license fields (file SHA256
`fd2e065ddb8446281d7ff5343bac36ef57fe3debec426be0d6bdfe8167445089`). `docs/third-party-
notices.md` points to the generated inventory and states that upstream
license/NOTICE texts must be retained for distribution.

The host has a valid Apple Development signature on the final arm64 dir;
notarization was skipped because no notarization credentials/options were
provided. A distribution release still requires a Developer ID identity and
Apple notarization. Re-running with `CSC_LINK`/password and Apple notarization
environment variables is the explicit release seam. The unsigned zip/DMG
are development artifacts and must not be represented as notarized releases.

## TASK-077 elephant icon refresh

The supplied source was copied byte-for-byte to
`design/archive/elephant-download-rgb.png` (SHA256
`190e7d1093a0df6cd784dfb1e34741a92ce7a3992ef08d4024e97548d1fadd93`). The
active `design/insuremo-dsh-elephant.png` is a 1254×1254 RGBA canvas containing
the complete artwork uniformly resampled to a centered 1082×1082 square by the
pure-Node deterministic Lanczos-3 asset generator. The TASK-073 fourth-order
superellipse remains applied inside that square. The measured active non-zero
alpha bbox is inclusive `93..1159` on both axes (half-open endpoint
`(1160,1160)`), 1067×1067 (`85.09%`); the source SHA256
is `8a801e66a5ec87b977d0f2e3dc57d27077508f506a325cee0168c27ae887ee67`.

`scripts/gen-icon.mjs` verifies the committed 16/24/32/48/64/128/256/512/1024
RGBA ladder and copies the 1024 derivative to `build/icon.png`; the refreshed
build hashes are:

- `build/icon.png`: `04fe34ef0af2758feda525c7cd9d2c311ffb4336110bda05cd9cba0165961390`
- `build/icon.ico`: `97b28773206961af8000d4259653de6c223174d39fa90641af9f61e82884bb08`
- packaged `icon.icns`: `809749d390ebe435b5d66697ec1f32122dc518a7e2699e58bba8e90a75c59bf9`

The Full arm64 rebuild was produced with
`pnpm package:e07:full:arm64:mac` and the verified Workbench tgz. Its current
artifacts are recorded in `docs/evidence/e07-variants.json`:

- ZIP `release/mac-arm64-Full/InsureMO DSH Desktop-Full-0.1.0-arm64.zip` —
  176,137,517 bytes, SHA256
  `fa682a577cef832dfde81fcf06e795f60746d34df62c9290cec0c144bd4e1b65`
- DMG `release/mac-arm64-Full/InsureMO DSH Desktop-Full-0.1.0-arm64.dmg` —
  168,768,184 bytes, SHA256
  `4e7f8c3d6b224580f3eec8aec69be9847743d3a872c2b2c2aba8519656d9803f`

Thin arm64 was also rebuilt (`release/mac-arm64-Thin/`); its refreshed ZIP/DMG
hashes and the four blockmap hashes are in the same evidence JSON. The Thin
invalid-runtime recovery plus external-runtime normal/safe/plugin smoke also
passed once after the refresh. `iconutil` extraction from both app bundles
verified `CFBundleIdentifier`
`com.insuremo.dsh.desktop`, `CFBundleIconFile` `icon.icns`, and a byte-equal
1024×1024 largest representation (`04fe34…`, 872×872 non-zero alpha bbox).

The Full packaged hidden smoke passed with an isolated temporary HOME carrying
a copy of the 16 test skills and an isolated `DSH_TEST_USER_DATA`: normal and
safe phases exited 0, Workbench/IMO/skills and plugin install/remove passed,
LAN remained refused, `homeDshUnchanged` was true, and wrapper orphans were
zero. Process observation showed every GPU/utility/renderer helper using the
temporary `--user-data-dir`; no real production userData path was present.
