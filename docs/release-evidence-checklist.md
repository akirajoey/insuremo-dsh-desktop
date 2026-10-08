# Release evidence checklist (E09)

A release is a receipt, not a claim. `scripts/record-e09-release-receipt.mjs`
records relative artifact paths, byte sizes, SHA256, compatibility, SBOM,
scan, packaged smoke, and orphan-process evidence. It keeps
`evidence.executedCommands` (commands actually run on the receipt's OS)
separate from `requiredWindowsCommands` (a plan that is never evidence on
macOS). Verify it with
`scripts/verify-e09-release-receipt.mjs` before publication.

## Required receipt fields

- release version and exact `compatibility.json` (desktop, DSH, Workbench,
  profile, and session schemas);
- OS/architecture, build commands, app/runtime/plugin/Workbench hashes;
- Node/pnpm/runtime graph and recursive resource-manifest verification;
- signed installer/app subject, timestamp, certificate chain, and SHA256;
- SBOM component/native/license counts and third-party notices;
- clean normal/safe boot, loopback-only binding, plugin install/remove/rollback,
  shutdown/timeout/forced state, and zero orphan descendants;
- clean userData and unchanged pre-existing DSH home;
- explicit residual risks, especially native runner and signing/notarization.

## Upgrade boundary

Desktop upgrades are installer replacements. The previous installer receipt
must be signed and hash-verified; rollback is a **manual reinstall** and never
an automatic downgrade. `userData` is retained.

Before a Desktop or Harness/runtime upgrade, stop Harness and create a private
E09 snapshot under `userData/desktop-state/upgrades`. It contains profile,
session, settings, Workbench marker, and auth **schema metadata only**. It must
not contain or export token stores, refresh tokens, credentials, or secrets.
The manifest hashes every copied file and is verified before restore.

Rollback boundaries stay separate:

- **Desktop:** reinstall the previous signed installer manually;
- **Harness:** restore the compatible profile/session/settings snapshot;
- **Workbench:** restore the previous verified tgz/hash and generation;
- **Plugin:** restore the previous verified profile generation through the
  existing journaled Plugin Manager transaction.

Cache/store directories are never authoritative rollback state. A failed
migration or interrupted directory switch must leave the previous verified
generation available; the current generation is garbage-collected only after
the next generation is ready and committed.

## Distribution gates

`developmentOnly: true` receipts may document unsigned development packages.
A distributable receipt must set `E09_DISTRIBUTION_RELEASE=1`, provide the
platform signing environment (`CSC_LINK`/`CSC_KEY_PASSWORD` or Authenticode
seam), and pass native macOS/Windows verification. Apple Developer ID,
notarization, Windows Authenticode, and update-feed credentials are not stored
in source or CI logs. Do not publish a receipt with pending signatures or
unverified native x64 evidence.

## TASK-139 macOS arm64 Full package (development-only)

`docs/evidence/e07-full-release.json` records the arm64 Full DMG/ZIP produced
by `package:e07:full:arm64:mac` for TASK-139. Its `distribution` is
`development-only` and the receipt is explicit about why: the app is unsigned
(adhoc signature, no `TeamIdentifier`) and not notarized, so Gatekeeper blocks
a plain download until the user allows it. The checklist above still governs a
distributable receipt, and the release form (source branch push versus a
GitHub Release carrying these files) is a user decision that this receipt does
not make.

The recorded release set is exactly the arm64 Full DMG, ZIP, and
`SHA256SUMS.txt`. Blockmaps, `latest-mac.yml`, and any older Thin/Full package
under `release/` are listed as excluded; `expandedApp` proves the app inside
the DMG and inside the ZIP matches the built app byte for byte. macOS x64 and
Windows were not built or verified, and the safe-mode core home resolves the
frozen non-DSH Cordis pins from `config/runtime-pins.json` instead of floating
to newer registry releases.
