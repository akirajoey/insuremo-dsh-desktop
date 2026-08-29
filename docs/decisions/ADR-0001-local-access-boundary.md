# ADR-0001: Local access boundary

- **Status:** Accepted for v1
- **Date:** 2026-08-29
- **Decision owner:** Product owner, recorded at desktop implementation start

## Decision

V1 adopts **same-user local trust**. The Harness service is bound only to
`127.0.0.1` and receives an OS-assigned port. The desktop window accepts only
the exact URL returned by the owned runtime handshake. A random port is not an
authentication mechanism.

This decision permits another process running as the same OS user to connect to
the local Harness service. It does not claim protection against a hostile local
process, malware, or a compromised same-user plugin.

## Threat scope

- **In scope:** accidental LAN exposure, wrong-port attachment, origin confusion,
  renderer-to-Main privilege escalation, and stale/orphan process cleanup.
- **Out of scope for v1:** an attacker already able to act as the same OS user
  and connect to loopback. Plugin installation remains an arbitrary-code
  execution boundary and requires explicit user confirmation.
- **Network boundary:** bind `127.0.0.1`; verify that the service is not
  reachable through a non-loopback interface in packaged validation.

## Strong-auth alternative

If product requirements change to defend against hostile local processes, this
ADR no longer authorizes release. The official Harness must first provide an
authentication seam covering HTTP, static assets, SSE, and WebSocket routes.
A reverse proxy, random port, or patch layer must not be described as a
replacement. Until that seam exists, strong-auth remains a blocker.

## Implementation invariants

1. No authentication secret is placed in Harness argv, environment, user data,
   renderer DTOs, sessions, or ordinary logs.
2. `launchId` is a public ownership correlation value, not a credential.
3. The Harness window has no privileged preload. Local management windows use
   exact sender/frame/origin and capability checks.
4. External HTTPS navigation uses the system browser; webview and unexpected
   navigation are denied.
5. The decision contains no token, credential, environment value, or absolute
   machine-specific path.
