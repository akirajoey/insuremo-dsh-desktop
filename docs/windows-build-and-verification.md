# Windows build and verification (E08)

Windows packaging is a native x64 job. Cross-compiling the Electron shell on
macOS is not evidence of Windows runtime compatibility.

## Prerequisites

- Windows 10/11 x64 with Visual Studio 2022 C++ workload and CMake;
- Node `24.9.0`, pnpm `11.7.0`, and a verified Workbench tgz;
- optional Authenticode PFX exposed only through `CSC_LINK` and
  `CSC_KEY_PASSWORD` (or the Windows-specific electron-builder equivalents);
- Defender enabled for the verification pass.

No certificate, token, or development path is stored in the repository.

## Build

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm build:e08:supervisor
$env:DSH_WORKBENCH_TGZ = "<verified-workbench.tgz>"
pnpm build:e08:resources
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false" # unsigned development pass
pnpm exec electron-builder --win nsis --x64 --publish never
pnpm scan:e08:artifacts
```

Run the same sequence again as `pnpm package:e08:win:signed` with the
`CSC_LINK`/`CSC_KEY_PASSWORD` Authenticode environment. The unsigned pass is
for development evidence only; the signed NSIS installer is the release
candidate.
`build-runtime-supervisor.ps1` configures the MSVC CMake target and records the
supervisor SHA256. The resource preparation command verifies the official
Node `v24.9.0` `win-x64.zip` SHA256
`6873514c3e6a012917cc6f95ce48a6289253370d025f1b69db290d70feebfa6e` before
extracting `node.exe`. The production runtime invokes that executable with the
bundled `pnpm.cjs`; it never invokes a `.cmd` shim or shell forwarding path.

The supervisor creates a current-user-only named pipe and a Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. It launches the wrapper with Unicode
`CreateProcessW`, drains stdout/stderr, observes the Electron parent PID, and
uses `accepted`, `exited`, `timeout`, and `forced` protocol states. Normal
shutdown does not use a shell process terminator.

## Required native evidence

Run the unsigned unpacked build and then a signed NSIS build. Set
`DSH_TEST_PLUGIN_TGZ` to the reviewed test bundle and run:

```powershell
pnpm smoke:e08:win
```

The smoke result must be retained as a redacted JSON receipt and must cover:

1. **Normal boot:** a clean userData path containing Unicode and spaces, bundled
   Node/pnpm, Workbench brand asset HTTP 200, and no use of the host Node.
2. **Safe mode:** independent safe home renders, has no Workbench, while the
   normal profile still has Workbench.
3. **Plugin Manager:** install/list/remove a tgz through the trusted window;
   verify the package is gone and the one-time capability cannot be replayed.
4. **Process ownership:** graceful shutdown returns `accepted` then `exited`;
   force timeout returns `timeout` then `forced`; restart after parent death
   leaves no supervisor/wrapper descendants.
5. **Defender:** record `Get-MpComputerStatus` and retain the slow-I/O result;
   locked-file rename must fail safely and recover through the journal.
6. **Chinese/space path:** verify profile, logs, artifact cache, and supervisor
   arguments remain intact under the Unicode-space userData path.
7. **Isolation:** pre-existing `%USERPROFILE%\\.dsh` is byte-for-byte unchanged;
   the runtime binds only to `127.0.0.1` and the LAN probe is unreachable.

A signed NSIS release additionally records Authenticode subject, timestamp,
installer SHA256, app/runtime manifest SHA256, SBOM, scan, and the exact
Windows build number. An unsigned package is a development artifact only.
