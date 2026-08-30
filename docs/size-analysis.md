# TASK-071 Packaging Size Analysis (macOS)

Baseline and variant measurements for the InsureMO DSH Desktop 0.1.0 macOS
packages. All hidden packaged smokes ran with isolated temporary `userData`;
`~/.dsh` remained unchanged and no orphan wrappers were left behind.

## Baseline (before TASK-071)

The previous baseline package was a universal app carrying the complete
offline runtime plus standalone Node `24.9.0` binaries for **both** Darwin
architectures:

| Component | Size |
| --- | --- |
| Universal `.app` (arm64+x64 Node) | 775 MB |
| Embedded `dsh-runtime` | 487 MB |
| Harness runtime graph | 234 MB |
| Standalone Node arm64 | 112 MB |
| Standalone Node x64 | 114 MB |
| Bundled pnpm 11.7.0 | 19 MB |
| Electron Frameworks | 275 MB (220 `.lproj` locale dirs) |

ZIP 246 MB / DMG 241 MB (arm64 slice of the universal build).

## Changes adopted

1. **Target-specific packages** — each package carries exactly one native
   runtime architecture (`DSH_RUNTIME_ARCH`); cross-arch Node binaries are no
   longer copied into an otherwise self-contained app.
2. **Electron run-as-Node (macOS Full)** — Electron 43 embeds Node `24.18.1`;
   the verified run-as-Node matrix (worker_threads, `node:sqlite`, `koffi`,
   `node-pty`, fork IPC, pnpm add, agent worker thread, normal/safe/plugin/
   Settings/cleanup) passed on the staged package, so the standalone Darwin
   Node binary is dropped. The wrapper is launched with
   `ELECTRON_RUN_AS_NODE=1` plus `--expose-internals` (required by
   `@deepseek-ai/cordis-plugin-loader`'s internal ESM loader on Node 24.18).
   Windows keeps bundled Node `24.9.0` and the Job-Object supervisor.
3. **Locale pruning** — an `afterPack` hook removes every non
   `Base|en*|zh*` `.lproj` from `Contents/Resources` and all framework
   bundles before signing (220 → 16 locale dirs, ≈44 MB saved).
4. **Thin variant** — the shell ships without `dsh-runtime`; the runtime root
   is resolved from `--runtime-root`, `DSH_DESKTOP_RUNTIME_ROOT`, or
   `desktop-state/runtime-source.json` (root + manifest SHA256 only), strictly
   verified (absolute, realpath, per-file hashes, symlink escape rejection,
   arch/Node-pin/distribution checks), and a missing/invalid runtime shows the
   local Recovery page with a `Select DSH Runtime…` picker instead of crashing.

## Resulting arm64 packages

| Variant | Installed `.app` | ZIP | DMG |
| --- | --- | --- | --- |
| Full (embedded runtime, run-as-Node) | 492 MB | 165 MB (172,990,434 B) | 157 MB (164,447,255 B) |
| Thin (external runtime) | 232 MB | 100 MB (104,738,405 B) | 103 MB (108,043,946 B) |

SHA256 hashes and per-artifact byte sizes are recorded in
`docs/evidence/e07-variants.json`.

Full saves ≈283 MB installed versus the 775 MB universal baseline; Thin saves
≈543 MB installed for deployments that provision the runtime pack separately.
The external runtime pack measured from the verified
`packaging/e07/runtime` root is 261 MB (27,775 manifest entries), so a Thin
install plus one shared runtime pack still totals less than one Full install
while serving multiple desktop copies.

## Runtime closure decision

The minimal-anchor closure (`dsh-app-boot` + `dsh-base` + `dsh-web-app`,
399 packages / 194 MB) was measured but **not adopted**: it was never booted
end-to-end, while the umbrella `@deepseek-ai/dsh` + React closure (514
packages) is the proven boot/runtime/plugin/Settings path. `docs/evidence/
e07-runtime-size.json` records both measurements for a future decision.

## Evidence

- `docs/evidence/e07-variants.json` — artifact hashes/sizes, installed sizes,
  hidden packaged smoke summaries for both variants.
- `docs/evidence/e07-electron-node-experiment.json` — run-as-Node matrix.
- `docs/evidence/e07-runtime-size.json` — minimal-anchor vs umbrella closure.
