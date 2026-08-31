# Desktop icon design assets

The **single active source** for the application icon is
`insuremo-dsh-glass-icon-v2-imo.png` (1254×1254, 8-bit RGBA):

```
sha256 aa84a60fbfcdc99eb69c8b458d1952d1cb2b3db7f51dc8659d8dfbe88b058b8d
```

The original opaque RGB source is archived at
`design/archive/insuremo-dsh-glass-icon-v2-imo-opaque-rgb.png` (sha256
`6fb21082817bfcd7cfffe57e791bd4e11467561db71a2d7a17d772fd971188c7`) and is
not read by any build or runtime code. The active source preserves every RGB
pixel from that archive and adds only the outer alpha mask.

`insuremo-dsh-glass-icon-v1.png` / `v1-512.png` are retained as superseded
design history only; nothing reads them.

## Deterministic outer alpha mask

The active source uses a fourth-order superellipse (squircle) mask centered at
the source pixel-center midpoint `(626.5, 626.5)`. Its horizontal and
vertical radii are `616.5px` (a 10px inset from the 1254px canvas), and the
antialias feather is `3px` outward from the boundary. For signed superellipse
distance `d` (positive inside), each pixel gets
`alpha = round(clamp((d + 3) / 3, 0, 1) * 255)`. This leaves the boundary
content opaque while making the outside transition transparent; corners are
alpha 0 and the axis edge at `(627, 10)` is alpha 255. The one-time,
pure-Node generator is `scripts/apply-icon-alpha.mjs`; it is never called by
the build. It preserves the original RGB and ancillary `caBX` chunk.

## Committed derivatives (`design/icons/`)

Downscaled square derivatives committed once so that `scripts/gen-icon.mjs`
performs **no image processing at build time** (byte-deterministic on macOS
and Windows, no sips/Pillow/ImageMagick dependency):

| File | Size | sha256 |
| --- | --- | --- |
| icon-16.png | 16×16 | `ca56a4b15b7e601d9e203dcc7183f50ae0b98471ca8c8e15ea8b02458cd83014` |
| icon-24.png | 24×24 | `35ea627fbf85a0e0b2b957480f4c954473483a78acfd568becebe4d9efe61240` |
| icon-32.png | 32×32 | `910c57930c147356404f157410ec88afafafab5dc0ca2719ae53569e9f8b7923` |
| icon-48.png | 48×48 | `5c79255b2ff66966b62711161655225827de013dac54b9803c98f3bde6728ac3` |
| icon-64.png | 64×64 | `c1737b7ba92972813db7a097abb2b588d14d85cef0626bce1b0f07104ad72425` |
| icon-128.png | 128×128 | `81adda616e416e3906b7e4abb37de27434c068bbc08015023d1853797d3334e6` |
| icon-256.png | 256×256 | `96de57faeba2b6ae3d7792fcea903f4b58904e2fdd5d7fb70bce5b2cbe4a8bc7` |
| icon-512.png | 512×512 | `e276275da99c42741370a5b59f45718e0ca8bc0da7bb24c28e8a10af484e2ca8` |
| icon-1024.png | 1024×1024 | `0e4408ad7bf8356f2c3896be04a901fc182f3b3b639989f8072d515d9a39413b` |

### One-time derivative generation command (record only — never run by the build)

```sh
for SIZE in 16 24 32 48 64 128 256 512 1024; do
  sips -z "$SIZE" "$SIZE" design/insuremo-dsh-glass-icon-v2-imo.png \
    --out "design/icons/icon-$SIZE.png"
done
```

macOS `sips` uses its default (Lanczos-style) resampling and preserves the
source alpha. The RGBA outputs above are the committed reference bytes.
Regenerating with another resampler will change these hashes — update this
table and the pins in `scripts/gen-icon.mjs` together, or the build fails by
design.

## Build-time behavior (`scripts/gen-icon.mjs`)

1. Verify the source hash and PNG IHDR (1254×1254, 8-bit RGBA).
2. Verify every derivative's hash and square dimensions (8-bit RGBA).
3. `build/icon.png` ← copy of `icon-1024.png` (dock, BrowserWindow, menu,
   and electron-builder's `icon.icns` input).
4. `build/icon.ico` ← pure-Node ICONDIR assembly of the 16/24/32/48/64/128/256
   PNG entries (256 encoded with width/height byte `0`, directory sizes and
   offsets exactly matching the payloads).
