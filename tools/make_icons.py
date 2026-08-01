"""Generate PWA / home-screen icons from assets/logo.png.

Run:  python tools/make_icons.py

The source logo is 800x800 and ~954 KB, far larger than any icon slot needs.
These downscales are what index.html and manifest.json actually reference.
"""
import pathlib

from PIL import Image

root = pathlib.Path(__file__).resolve().parent.parent
src_path = root / "assets" / "logo.png"
out_dir = root / "assets" / "icons"
out_dir.mkdir(parents=True, exist_ok=True)

src = Image.open(src_path).convert("RGBA")
print("source: %s  %dx%d  %.0f KB"
      % (src_path.name, src.width, src.height, src_path.stat().st_size / 1024))

# "any" icons keep transparency. "maskable" needs the artwork inside the safe
# zone (centre 80%) so Android can crop it to any shape without clipping.
JOBS = [
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-192-maskable.png", 192, True),
    ("icon-512-maskable.png", 512, True),
    ("apple-touch-icon.png", 180, False),
    ("favicon-32.png", 32, False),
]

# The logo is photographic (~79k unique colours), so a straight RGBA PNG at
# 512px costs 420 KB. Octree-quantising to 128 colours after downscaling drops
# that to ~67 KB with no visible difference at icon size.
PALETTE_COLOURS = 128

total = 0
for name, size, maskable in JOBS:
    if maskable:
        # Artwork occupies the centre 80%, on an opaque background so the
        # platform mask never reveals transparent corners.
        canvas = Image.new("RGBA", (size, size), (255, 255, 255, 255))
        inner = int(size * 0.8)
        art = src.resize((inner, inner), Image.LANCZOS)
        off = (size - inner) // 2
        canvas.paste(art, (off, off), art)
        img = canvas
    else:
        img = src.resize((size, size), Image.LANCZOS)

    # FASTOCTREE is the only method that keeps the alpha channel intact.
    img = img.quantize(colors=PALETTE_COLOURS, method=Image.FASTOCTREE)

    dest = out_dir / name
    img.save(dest, "PNG", optimize=True)
    kb = dest.stat().st_size / 1024
    total += kb
    print("  %-26s %4dpx  %6.1f KB%s" % (name, size, kb, "  (maskable)" if maskable else ""))

print("total icon payload: %.0f KB (was %.0f KB for the single source logo)"
      % (total, src_path.stat().st_size / 1024))
