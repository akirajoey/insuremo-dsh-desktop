# Desktop icon design assets

The **single active source** for the application icon is
`insuremo-dsh-glass-icon-v2-imo.png` (1254×1254, 8-bit RGB):

```
sha256 6fb21082817bfcd7cfffe57e791bd4e11467561db71a2d7a17d772fd971188c7
```

`insuremo-dsh-glass-icon-v1.png` / `v1-512.png` are retained as superseded
design history only; nothing reads them.

## Committed derivatives (`design/icons/`)

Downscaled square derivatives committed once so that `scripts/gen-icon.mjs`
performs **no image processing at build time** (byte-deterministic on macOS
and Windows, no sips/Pillow/ImageMagick dependency):

| File | Size | sha256 |
| --- | --- | --- |
| icon-16.png | 16×16 | `aa335327471b1b2697a2da8dc4f8d031bd11502c91a1825e818242401fd78ad0` |
| icon-24.png | 24×24 | `d945e2206c674a4d4423ec16d1a326d5416e98796b5f33caf025e653dcf7db37` |
| icon-32.png | 32×32 | `e8a9bb2dcf98a24477763c7a88bb9590c86c7eae23848fef321ef82a14d575c1` |
| icon-48.png | 48×48 | `2f2d78872b57212b2e0fa62d8e7f3b5dc41fa6c76f3ab25cfefcf94753b80f1a` |
| icon-64.png | 64×64 | `62eb5069e5fb6d94f26e0481937f512cb74201e9f941f7d42c69bb69ba6798d8` |
| icon-128.png | 128×128 | `2311b5954ca187bd083d6f8e0b9a9e632cf09786609c419b86362797d451aab3` |
| icon-256.png | 256×256 | `b1af57f75c60388a49cae3f7d6f6711b8c0fff79f615285d8fe9b41d85de6d86` |
| icon-512.png | 512×512 | `e3dafb46b4291b4f4c849fc3cf071c05fbf5bfbb05ee797b7af5cda698e69500` |
| icon-1024.png | 1024×1024 | `2bf50b3d37f7dbe6b0b24b8a69aee4e9da51bf95f9bb38dc58cef55dc1b3d4b6` |

### One-time generation command (record only — never run by the build)

```sh
sips -z <SIZE> <SIZE> design/insuremo-dsh-glass-icon-v2-imo.png \
  --out design/icons/icon-<SIZE>.png   # SIZE in 16 24 32 48 64 128 256 512 1024
```

macOS `sips` uses its default (Lanczos-style) resampling; the outputs above
are the committed reference bytes. Regenerating with another resampler will
change these hashes — update this table and the pins in
`scripts/gen-icon.mjs` together, or the build fails by design.

## Build-time behavior (`scripts/gen-icon.mjs`)

1. Verify the source hash and PNG IHDR (1254×1254).
2. Verify every derivative's hash and square dimensions.
3. `build/icon.png` ← copy of `icon-1024.png` (dock, BrowserWindow, menu,
   and electron-builder's `icon.icns` input).
4. `build/icon.ico` ← pure-Node ICONDIR assembly of the 16/24/32/48/64/128/256
   PNG entries (256 encoded with width/height byte `0`, directory sizes and
   offsets exactly matching the payloads).
