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
