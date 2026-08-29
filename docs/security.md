# Security contract

## E01 renderer boundary

Every renderer runs with `nodeIntegration: false`, `contextIsolation: true`,
`sandbox: true`, and `webSecurity: true`. The preload exposes only the typed
`app.version` call. Main authorizes an IPC request only when all of these hold:

- the sender is the expected BrowserWindow;
- the sender frame is that window's main frame;
- the frame URL is the exact expected packaged file URL or exact dev origin;
- the requested capability is assigned to that window;
- the window has not been destroyed or unexpectedly navigated.

Subframes, unexpected origins, and unknown capabilities are denied. New-window
requests and webview use are denied. The renderer cannot read profile files,
execute a command, or access Node APIs.

## E02+ boundaries

The runtime controller will use an OS-assigned loopback port and an owned
handshake. `launchId` is an ownership identifier, never a secret. Control
channels must not put credentials in child argv, environment, or user data.

V1 uses the same-user local-trust decision in ADR-0001. Strong authentication
is not implemented by a proxy or patch and cannot be released until an official
Harness seam covers HTTP, static, SSE, and WebSocket traffic.
