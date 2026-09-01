# Desktop icon design assets

## Active elephant artwork

The single active application icon source is the RGBA derivative
`design/insuremo-dsh-elephant.png` (1254×1254, 8-bit RGBA, non-interlaced).
It is derived from the supplied opaque RGB PNG:

- source attribution: `/Users/junjie.zhang/Downloads/download.png`
- immutable repository archive: `design/archive/elephant-download-rgb.png`
- archive format: 1254×1254, 8-bit RGB, non-interlaced
- archive SHA256: `190e7d1093a0df6cd784dfb1e34741a92ce7a3992ef08d4024e97548d1fadd93`
- active RGBA SHA256: `8a801e66a5ec87b977d0f2e3dc57d27077508f506a325cee0168c27ae887ee67`

The archive is the attribution copy and is never overwritten by tooling. The
full artwork is uniformly resampled to a `1082×1082` square and centered in
the 1254×1254 active canvas, leaving an 86px transparent canvas margin on
each side. This preserves the entire composition while matching the optical
safe-area benchmark from the Teams reference. Because this intentional
resampling changes RGB sample locations, active RGB is not required to be
byte- or pixel-identical to the archive; provenance is established by the
immutable archive hash and the pure-Node conversion parameters.

`scripts/apply-icon-alpha.mjs` always reads the archive and writes the active
source, so it is safe to rerun and cannot compound an earlier conversion. It
uses a deterministic separable Lanczos-3 resampler and preserves the source
RGB artwork composition plus ancillary PNG chunks (including `caBX` when
present). It is an asset-generation command only; the build never invokes it.

The former `insuremo-dsh-glass-icon-v2-imo.png` (historical SHA256
`aa84a60fbfcdc99eb69c8b458d1952d1cb2b3db7f51dc8659d8dfbe88b058b8d`) and its
v1 artwork remain in the repository as **superseded design history**. They are
not read by the build. The former opaque archive remains available at
`design/archive/insuremo-dsh-glass-icon-v2-imo-opaque-rgb.png` for historical
comparison (SHA256
`6fb21082817bfcd7cfffe57e791bd4e11467561db71a2d7a17d772fd971188c7`).

## Deterministic outer alpha mask

The active source applies the TASK-073 fourth-order superellipse (squircle)
to the centered 1082px artwork square. Its local pixel-center midpoint is
`(540.5, 540.5)`, its radius is `530.5px` (a 10px inset), and its outward
antialias feather is 3px. For signed superellipse distance `d` (positive
inside), each artwork pixel gets:

```text
alpha = round(clamp((d + 3) / 3, 0, 1) * 255)
```

The resulting non-zero alpha bbox is measured at inclusive pixel coordinates
`x=93..1159` and `y=93..1159` (equivalently the half-open box
`(93,93)..(1160,1160)`), 1067×1067 pixels (`85.09%` of the 1254px canvas),
within the requested 1066–1072px optical footprint. The global top-axis samples are
`(627,93)=42`, `(627,94)=127`, `(627,95)=212`, `(627,96)=255`; corners are
alpha 0 and the canvas center `(627,627)` is opaque. The pure-Node conversion
keeps the output canvas transparent outside the centered artwork square.

## Committed derivatives (`design/icons/`)

These RGBA square derivatives are committed once. `scripts/gen-icon.mjs`
performs no image processing at build time, so builds are byte deterministic
on macOS and Windows and require no sips, Pillow, ImageMagick, or other image
dependency.

| File | Size | SHA256 |
| --- | ---: | --- |
| icon-16.png | 16×16 | `ef3bd51c475168e55b44b676872a070498bfde545833608dac95cd22506d0f89` |
| icon-24.png | 24×24 | `96ce51004b09cf6a17c20f1e8653b01f98cc3d1617c09d4f098f1d70abe2fc7a` |
| icon-32.png | 32×32 | `ef78bb6ef6d90b748151709495b3a20f71b8f088a00c3df2f283b685507a1cbd` |
| icon-48.png | 48×48 | `96ca0392110985eeab3ed963135bbc3f0e52d0ec9377ba1c0b56ea55c1da797a` |
| icon-64.png | 64×64 | `9934b5959d03356cfa785387818f8e21c3d094d2c7b2509619c372aef0e83fef` |
| icon-128.png | 128×128 | `f2a2bf4e2d5402ec86dd4076b5c9a8c44bad852c6badfb2014f4740ab56d93e0` |
| icon-256.png | 256×256 | `93a50dd17b1f22e009cfe9c6f076e6de2091a10ba998dae625fa8358c29f74e7` |
| icon-512.png | 512×512 | `940449f6fa204f1af833978f54efd5ea8bc6f07fb48578640d256ad8a75c409d` |
| icon-1024.png | 1024×1024 | `04fe34ef0af2758feda525c7cd9d2c311ffb4336110bda05cd9cba0165961390` |

The one-time asset commands used to create the committed references are:

```sh
node scripts/apply-icon-alpha.mjs
for SIZE in 16 24 32 48 64 128 256 512 1024; do
  sips -z "$SIZE" "$SIZE" design/insuremo-dsh-elephant.png \
    --out "design/icons/icon-$SIZE.png"
done
node scripts/gen-icon.mjs
```

Regenerating with another resampler changes bytes and therefore requires
updating the table and pins in `scripts/gen-icon.mjs` together. The build
itself only verifies the active source and derivative pins, copies
`icon-1024.png` to `build/icon.png`, and assembles `build/icon.ico` from the
16/24/32/48/64/128/256 PNG entries. The 256 ICO width/height byte is encoded
as zero, as required by ICONDIR.
