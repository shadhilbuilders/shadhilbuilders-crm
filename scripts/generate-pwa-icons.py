#!/usr/bin/env python3
"""
Generate PWA icons for shadhil-crm from a simple brand mark.

Usage: python3 scripts/generate-pwa-icons.py
Output: apps/web/public/icons/{icon-192,icon-512,maskable-512,apple-touch-180}.png

Brand: dark navy (#0f172a) background, green (#62b132) "S" mark.
Safe zones per https://maskable.app/editor:
  - 192x192: full bleed (no safe zone needed)
  - 512x512: full bleed
  - maskable-512: 410x410 inner safe zone (40px padding all sides, central 80%)
  - apple-touch-180: 180x180, no transparency, no rounded corners (iOS adds mask)

This is a placeholder until the real brand mark is sourced. Replace the
draw_s_mark() function below with the official logo SVG → PNG export.
"""
import struct
import zlib
from pathlib import Path

BRAND_NAVY = (15, 23, 42)      # #0f172a
BRAND_GREEN = (98, 177, 50)   # #62b132


def png(width: int, height: int, pixels: bytes) -> bytes:
    """Build a minimal PNG (RGB, 8-bit) from raw pixel bytes."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + pixels[y * width * 3:(y + 1) * width * 3] for y in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def make_canvas(size: int, bg=BRAND_NAVY) -> bytearray:
    """Solid background bytearray (RGB, length = size*size*3)."""
    px = bytes(bg)  # (15, 23, 42)
    return bytearray(px * (size * size))


def set_pixel(canvas: bytearray, size: int, x: int, y: int, rgb) -> None:
    idx = (y * size + x) * 3
    canvas[idx:idx + 3] = bytearray(rgb)


def draw_s_mark(size: int, stroke_frac: float = 0.14) -> bytes:
    """Render a chunky 'S' mark on a navy background. Returns raw RGB bytes."""
    canvas = make_canvas(size)
    pad = size // 5
    thick = max(2, int(size * stroke_frac))
    cy = size // 2
    # Top horizontal
    for y in range(cy - pad, cy - pad + thick):
        for x in range(pad, size - pad):
            set_pixel(canvas, size, x, y, BRAND_GREEN)
    # Middle horizontal
    for y in range(cy - thick // 2, cy + thick // 2):
        for x in range(pad, size - pad):
            set_pixel(canvas, size, x, y, BRAND_GREEN)
    # Bottom horizontal
    for y in range(cy + pad - thick, cy + pad):
        for x in range(pad, size - pad):
            set_pixel(canvas, size, x, y, BRAND_GREEN)
    # Top-right vertical (down)
    for y in range(cy - pad, cy):
        for x in range(size - pad - thick, size - pad):
            set_pixel(canvas, size, x, y, BRAND_GREEN)
    # Bottom-left vertical (up)
    for y in range(cy, cy + pad):
        for x in range(pad, pad + thick):
            set_pixel(canvas, size, x, y, BRAND_GREEN)
    return bytes(canvas)


def maskable_canvas(size: int) -> bytes:
    """Maskable: full-bleed bg, mark scaled to central 80% safe zone.

    The full square is the brand background; the OS applies a circular mask
    on top. The mark must stay inside the central 80% so it isn't clipped
    by the OS mask.
    """
    inner = int(size * 0.8)
    inner_data = draw_s_mark(inner, stroke_frac=0.13)
    canvas = make_canvas(size)
    offset = (size - inner) // 2
    for y in range(inner):
        for x in range(inner):
            src_idx = (y * inner + x) * 3
            # Copy only the green mark pixels; navy bg pixels stay.
            if inner_data[src_idx:src_idx + 3] != bytes(BRAND_GREEN):
                continue
            dst_x = offset + x
            dst_y = offset + y
            dst_idx = (dst_y * size + dst_x) * 3
            canvas[dst_idx:dst_idx + 3] = bytearray(BRAND_GREEN)
    return bytes(canvas)


def write_icon(path: Path, size: int, maskable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if maskable:
        data = maskable_canvas(size)
    else:
        data = draw_s_mark(size, stroke_frac=0.14)
    path.write_bytes(png(size, size, data))
    print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    repo = Path(__file__).resolve().parent.parent
    icons_dir = repo / "apps" / "web" / "public" / "icons"
    write_icon(icons_dir / "icon-192.png", 192)
    write_icon(icons_dir / "icon-512.png", 512)
    write_icon(icons_dir / "maskable-512.png", 512, maskable=True)
    write_icon(icons_dir / "apple-touch-180.png", 180)
