# Windows runtime supervisor

`runtime-supervisor.exe` is a deliberately small MSVC helper for the packaged
Windows runtime. It creates a Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, launches the bundled `node.exe` wrapper,
and watches the Electron parent PID. The control endpoint is a named pipe with
a DACL granting access only to the current user's SID. It forwards newline
framed JSON and implements `accepted`, `exited`, `timeout`, and `forced`
shutdown states. The normal path never invokes `taskkill`.

The helper is built on a native Windows runner by
`scripts/build-runtime-supervisor.ps1`; no prebuilt binary is committed.
