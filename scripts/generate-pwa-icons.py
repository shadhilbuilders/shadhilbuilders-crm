#!/usr/bin/env python3
"""
Generate PWA icons for shadhil-crm from the canonical Shadhil brand mark.

Usage: python3 scripts/generate-pwa-icons.py [--source PATH]

Default source: ../landing-page/public/favicon/android-chrome-512x512.png
(the wordmark cropped from realfavicongenerator's set, used on the public
marketing site shadhilbuilders.in landing page). Override --source to point
at a different 512x512 RGBA PNG (e.g. an updated brand mark).

Output: apps/web/public/icons/{icon-192,icon-512,maskable-512,apple-touch-180}.png

Output sizes and constraints:
  - icon-192.png        192x192 RGBA   "any"      - full-bleed wordmark
  - icon-512.png        512x512 RGBA   "any"      - full-bleed wordmark
  - maskable-512.png    512x512 RGBA   "maskable" - navy frame + white
                                              inner square + wordmark inset
                                              to the 80% safe zone per
                                              https://maskable.app/editor
  - apple-touch-180.png 180x180 RGBA   "any"      - iOS home-screen icon
                                              (Apple applies its own mask,
                                              so we ship a flat square)

The manifest at apps/web/public/manifest.webmanifest references these four
filenames; do not rename without updating the manifest in lockstep.

Re-run after any brand-mark update (the source file or any of the four
output PNGs). Safe to re-run idempotently.

Requires: Pillow >= 10 (pip install --user Pillow). Not declared as a project
dependency because this is a one-shot build script, not runtime code.

History:
  - v1 (pre-2026-09-02): drew a green "S" placeholder via raw zlib PNG
    construction. Docstring explicitly flagged itself as a placeholder
    awaiting the real brand mark.
  - v2 (2026-09-02): sources the real Shadhil wordmark from the landing
    page. Manifest is now installable per Lighthouse PWA audit.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.stderr.write(
        "Pillow is required. Install with: pip install --user Pillow\n"
        "(or: python3 -m pip install --user Pillow)\n"
    )
    sys.exit(1)

# Pillow < 10 exposed LANCZOS as Image.LANCZOS; Pillow >= 10 deprecated that
# and exposes it as Image.Resampling.LANCZOS. The latter works on both.
RESAMPLE = Image.Resampling.LANCZOS

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = (
    REPO_ROOT.parent
    / "landing-page"
    / "public"
    / "favicon"
    / "android-chrome-512x512.png"
)
ICONS_DIR = REPO_ROOT / "apps" / "web" / "public" / "icons"

# Maskable canvas colors.
NAVY = (15, 23, 42, 255)        # #0f172a - matches the CRM app theme
WHITE = (255, 255, 255, 255)    # inner field background

# Required output (size_pixels, filename). Order = write order.
OUTPUTS = [
    (192, "icon-192.png"),
    (512, "icon-512.png"),
    (180, "apple-touch-180.png"),
    (512, "maskable-512.png"),  # generated specially, see make_maskable()
]


def render_full_bleed(source: Image.Image, size: int) -> Image.Image:
    """Resize the brand mark to `size x size`, RGBA, full bleed.

    The source wordmark fills its canvas tightly; for 'any'-purpose icons
    that is the desired behavior (launchers do not apply additional masks).
    """
    return source.convert("RGBA").resize((size, size), RESAMPLE)


def make_maskable(source: Image.Image, size: int = 512) -> Image.Image:
    """Compose the maskable icon.

    Structure (outside-in):
      1. Navy frame - fills the full square. Visible under any launcher
         mask shape (circle, squircle, rounded-rect, teardrop).
      2. White inner square - 410x410 (the 80% safe zone per maskable.app).
         Provides contrast for the wordmark and a visual breathing area.
      3. Brand mark - the wordmark, scaled to fit inside the white square
         with a small inner margin, centered.

    Why the white inner square: the wordmark itself uses white as its
    background. Without an inner square, the wordmark blends into the
    navy frame and loses contrast at small sizes (<48 px) on light-mode
    launchers. The white square preserves brand contrast on both light
    and dark home screens.
    """
    SAFE = 410  # 80% of 512
    PAD = (size - SAFE) // 2  # 51 px navy frame on each side
    INNER_MARGIN = 20  # extra padding between wordmark and white edge
    inner = SAFE - 2 * INNER_MARGIN  # 370 px usable wordmark area

    # Scale the wordmark to fit inside the inner safe area.
    wordmark = source.convert("RGBA").copy()
    wordmark.thumbnail((inner, inner), RESAMPLE)

    canvas = Image.new("RGBA", (size, size), NAVY)
    # Inner white square (the safe area).
    canvas.paste(WHITE, (PAD, PAD, PAD + SAFE, PAD + SAFE))
    # Center the wordmark within the safe area (alpha-composited).
    ox = (size - wordmark.width) // 2
    oy = (size - wordmark.height) // 2
    canvas.alpha_composite(wordmark, (ox, oy))
    return canvas


def validate(path: Path, expected_size: int) -> None:
    """Confirm the written file is a valid PNG of the expected size.

    Re-running the script after someone manually edits a PNG with the
    wrong dimensions has been a footgun before - this catches it.
    """
    with Image.open(path) as img:
        if img.size != (expected_size, expected_size):
            raise RuntimeError(
                f"{path}: expected {expected_size}x{expected_size}, "
                f"got {img.size[0]}x{img.size[1]}"
            )
        if img.mode != "RGBA":
            raise RuntimeError(
                f"{path}: expected RGBA mode, got {img.mode}"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help="Brand-source PNG (default: %(default)s)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=ICONS_DIR,
        help="Output directory (default: %(default)s)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be written without touching files.",
    )
    args = parser.parse_args()

    if not args.source.is_file():
        sys.stderr.write(f"Source brand mark not found: {args.source}\n")
        sys.stderr.write(
            "Pass --source PATH or place the landing-page favicon at the "
            "default location.\n"
        )
        return 2

    if not args.dry_run:
        args.out.mkdir(parents=True, exist_ok=True)

    print(f"Source: {args.source}")
    print(f"Output: {args.out}")

    with Image.open(args.source) as src_img:
        if src_img.size[0] < 512 or src_img.size[1] < 512:
            sys.stderr.write(
                f"Source is {src_img.size[0]}x{src_img.size[1]}; "
                "must be at least 512x512 to upscale cleanly.\n"
            )
            return 2
        src_rgba = src_img.convert("RGBA")
        for size, filename in OUTPUTS:
            out_path = args.out / filename
            if filename == "maskable-512.png":
                img = make_maskable(src_rgba, size=512)
            else:
                img = render_full_bleed(src_rgba, size)
            if args.dry_run:
                print(f"  [dry-run] would write {out_path} ({size}x{size} RGBA)")
                continue
            img.save(out_path, "PNG", optimize=True)
            validate(out_path, size)
            try:
                rel = out_path.relative_to(REPO_ROOT)
            except ValueError:
                rel = out_path
            print(f"  wrote {rel} ({out_path.stat().st_size} bytes)")

    if args.dry_run:
        return 0

    # Sanity-check that the manifest references the files we just wrote.
    manifest = REPO_ROOT / "apps" / "web" / "public" / "manifest.webmanifest"
    if manifest.is_file():
        text = manifest.read_text()
        missing = [
            filename for _, filename in OUTPUTS
            if f"/icons/{filename}" not in text
        ]
        if missing:
            sys.stderr.write(
                f"WARNING: manifest.webmanifest does not reference: {missing}\n"
            )

    print("Done. Run scripts/lighthouse-pwa.sh against the live URL to verify.")
    return 0


if __name__ == "__main__":
    sys.exit(main())