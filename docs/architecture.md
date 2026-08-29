# Architecture

## Ownership

Electron Main is the only desktop component with filesystem, process, native
dialog, and window-management authority. Harness remains the owner of Agent,
Session, Skills, Explain, workspace, and iComposer behavior. The Workbench is a
normal Harness plugin and must remain usable outside Electron.

## Windows

The Harness window loads the runtime's exact loopback URL and has no privileged
preload because it executes third-party client plugins. The Plugin Manager and
failure/recovery windows are packaged local pages with dedicated preloads.
Those preloads expose typed, capability-scoped operations rather than a generic
IPC bridge.

## Runtime boundary

E02 will add the official DSH runtime only after the port-0 handshake,
process ownership, control channel, packaged loading, and G-AUTH gates pass.
E00/E01 intentionally contain no Harness startup or plugin mutation code.

## Data boundary

Production user data belongs below Electron's `userData` path. The normal
Harness home, staging generations, artifact cache, and runtime ownership record
are separate concerns. No implementation may fall back to the developer's
ordinary DSH home.
