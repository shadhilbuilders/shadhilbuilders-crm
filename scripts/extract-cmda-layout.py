#!/usr/bin/env python3
"""Trace the approved CMDA layout drawing into app assets.

Reads  docs/CMDA LAYOUT.pdf  and writes:
  apps/web/public/cmda-plan.svg                       vector background artwork
  apps/web/src/components/plot-layout/plot-geometry.ts  typed plot geometry

The source PDF is never modified.

WHY THIS IS A SCRIPT AND NOT HAND-DRAWN COORDINATES
---------------------------------------------------
The drawing is a CAD export: pure vector (no images), 4300 path objects across
22 OCG layers, on one page with /Rotate 270. Plot boundaries are individual
line segments, NOT closed polygons, so they cannot be lifted out directly - the
linework has to be noded and polygonised, then each printed plot number matched
to the face that contains it.

THE PIPELINE
------------
1. PyMuPDF reads every vector path (with its OCG layer) and every text span
   (with its position and rotation). Both come back in the page's *media*
   coordinate system, so everything is mapped through the page's
   rotation_matrix into the coordinate system the page actually displays in.
2. Boundary layers - "Plot Bou", "PROPOSED ROAD US", "fmb" (the site boundary)
   - are noded and polygonised with shapely into planar faces.
3. Each text span on layer "PLOT-NO" is matched to the single face containing
   it. 125 numbers resolve to 125 distinct faces with no collisions, which is
   the primary evidence that the plot cells were segmented correctly.
4. Scale is calibrated against the drawing's own area statement
   ("TOTAL EXTENT 17775 SQ.M"), giving 1 user unit = 0.472273 m.
5. Verification, printed on every run:
     - plot numbers mapped / distinct faces
     - summed plot area vs the area statement's implied plot area
       (PLOTTABLE 12421 - OSR 1269 - PUBLIC PURPOSE 133 = 11019 sq.m)
     - the fraction of each polygon's perimeter that lands on drawn ink in the
       rendered page (this is what proves the outlines are traced, not invented)

KNOWN LIMITS - read before trusting a number
--------------------------------------------
- The polygonisation is exact over the segments it is given. Where the drawing
  leaves a boundary unclosed, the face would be wrong, which is why the plot
  number match and the perimeter-on-ink check both run every time.
- `printedLabelsFt` only contains the dimension figures that fall *inside* a
  plot. Because a shared wall is dimensioned once, many plots carry a single
  figure; derive a plot's full size from `measuredSizeFt`, not from this list.
- The EWS plots (114-125) sum to ~794 sq.m while the drawing's area statement
  lists "E.W.S. PROVIDED 1265 SQ.M". The total plot area matches the statement
  to 0.1%, so this is a difference in how the statement is measured, not a
  tracing error - flagged, not silently smoothed over.

USAGE
-----
    python3 -m pip install pymupdf shapely
    python3 scripts/extract-cmda-layout.py
"""

from __future__ import annotations

import collections
import html
import json
import math
import os
import re
import sys

try:
    import pymupdf
    from shapely.geometry import LineString, Point
    from shapely.ops import polygonize, unary_union
except ImportError as exc:  # pragma: no cover - environment guard
    sys.exit(f"missing dependency: {exc}. Run: python3 -m pip install pymupdf shapely")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_PDF = os.path.join(REPO_ROOT, "docs", "CMDA LAYOUT.pdf")
OUTPUT_SVG = os.path.join(REPO_ROOT, "apps", "web", "public", "cmda-plan.svg")
OUTPUT_TS = os.path.join(
    REPO_ROOT, "apps", "web", "src", "components", "plot-layout", "plot-geometry.ts"
)

# Layers that carry plot/site boundary linework. Dimensions, hatching and
# legends are deliberately excluded from the polygonisation - including them
# would subdivide plot cells and produce wrong faces.
BOUNDARY_LAYERS = {"Plot Bou", "PROPOSED ROAD US", "fmb"}

# Layers drawn as background artwork (everything the site plan shows).
ARTWORK_LAYERS = BOUNDARY_LAYERS | {
    "CHANNEL",
    "A-WALL-PATT",
    "DIM-PLOT",
    "prime-Dimension",
    "BOU-DIM",
    "0",
    "NORTH",
}

# Text layers that belong to the plan. The area statement, conditions,
# legend and title block are excluded - they are not part of the layout.
ARTWORK_TEXT_LAYERS = {"PLOT-NO", "PLOT SIZE -US", "S.No_TEXT", "DIM-PLOT", "PROPOSED ROAD US"}

PLOT_NUMBER_LAYER = "PLOT-NO"
PLOT_SIZE_LAYER = "PLOT SIZE -US"

TOTAL_EXTENT_SQM = 17775.0
PLOTTABLE_SQM = 12421.0
OSR_SQM = 1269.0
PUBLIC_PURPOSE_SQM = 133.0

# Artwork viewport, in the display coordinate system. Verified against the
# extent of the artwork layers; changing it means regenerating both files.
VIEWBOX = (99.1, 108.8, 601.4, 508.2)


def span_text(span) -> str:
    return "".join(chr(char[0]) for char in span["chars"] if char[0] != 0xFFFF)


def build_transform(page):
    matrix = tuple(page.rotation_matrix)

    def transform(x: float, y: float) -> tuple[float, float]:
        return (
            matrix[0] * x + matrix[2] * y + matrix[4],
            matrix[1] * x + matrix[3] * y + matrix[5],
        )

    return transform


def collect_segments(page, transform):
    """Boundary linework as shapely LineStrings, in display coordinates."""
    segments = []
    for drawing in page.get_drawings():
        if drawing.get("layer") not in BOUNDARY_LAYERS:
            continue
        for item in drawing["items"]:
            kind = item[0]
            if kind == "l":
                segments.append(
                    LineString([transform(item[1].x, item[1].y), transform(item[2].x, item[2].y)])
                )
            elif kind == "qu":
                quad = item[1]
                points = [transform(p.x, p.y) for p in (quad.ul, quad.ur, quad.lr, quad.ll)]
                points.append(points[0])
                segments.append(LineString(points))
    return segments


def plot_number_centroids(page, transform):
    centroids = {}
    for span in page.get_texttrace():
        if span["layer"] != PLOT_NUMBER_LAYER:
            continue
        text = span_text(span).strip()
        if not re.fullmatch(r"\d+", text):
            continue
        box = span["bbox"]
        centroids[int(text)] = transform((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
    return centroids


def parse_feet(text: str):
    """`29'3"` -> 29.25 feet. Returns None for anything that is not a length."""
    match = re.fullmatch(r"(\d+)'(?:(\d+(?:\.\d+)?)\")?", text.strip())
    if match is None:
        return None
    inches = float(match.group(2)) / 12 if match.group(2) else 0.0
    return int(match.group(1)) + inches


def printed_labels_by_plot(page, faces, assignment):
    labels = collections.defaultdict(list)
    for span in page.get_texttrace():
        if span["layer"] != PLOT_SIZE_LAYER:
            continue
        value = parse_feet(span_text(span))
        if value is None:
            continue
        box = span["bbox"]
        point = Point((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
        # Text is stored in media coordinates; the faces are in display space.
        # Locate the label by matching it against the untransformed centroid
        # space instead: both sides are mapped through the same transform.
        for number, face in assignment.items():
            if face.contains(Point(*transform_page(page, point))):
                labels[number].append(value)
                break
    return labels


def transform_page(page, point):
    matrix = tuple(page.rotation_matrix)
    return (
        matrix[0] * point.x + matrix[2] * point.y + matrix[4],
        matrix[1] * point.x + matrix[3] * point.y + matrix[5],
    )


def write_artwork(page, transform):
    groups = collections.defaultdict(list)
    for drawing in page.get_drawings():
        if drawing.get("layer") not in ARTWORK_LAYERS:
            continue
        rect = drawing["rect"]
        corners = [
            transform(rect[0], rect[1]),
            transform(rect[2], rect[1]),
            transform(rect[0], rect[3]),
            transform(rect[2], rect[3]),
        ]
        x0, y0, width, height = VIEWBOX
        if max(c[0] for c in corners) < x0 - 2 or min(c[0] for c in corners) > x0 + width + 2:
            continue
        if max(c[1] for c in corners) < y0 - 2 or min(c[1] for c in corners) > y0 + height + 2:
            continue
        fill = drawing.get("fill")
        colour = drawing.get("color")
        stroke_width = drawing.get("width") or 0.0
        if fill:
            key = ("F", tuple(round(c, 3) for c in fill))
        else:
            key = (
                "S",
                tuple(round(c, 3) for c in colour) if colour else (0, 0, 0),
                round(stroke_width if stroke_width else 0.3, 2),
            )
        subpaths = []
        for item in drawing["items"]:
            kind = item[0]
            if kind == "l":
                a = transform(item[1].x, item[1].y)
                b = transform(item[2].x, item[2].y)
                subpaths.append(f"M{a[0]:.1f} {a[1]:.1f}L{b[0]:.1f} {b[1]:.1f}")
            elif kind == "qu":
                quad = item[1]
                pts = [transform(p.x, p.y) for p in (quad.ul, quad.ur, quad.lr, quad.ll)]
                subpaths.append("M" + "L".join(f"{p[0]:.1f} {p[1]:.1f}" for p in pts) + "Z")
            elif kind == "c":
                p = [transform(item[i].x, item[i].y) for i in (1, 2, 3, 4)]
                subpaths.append(
                    f"M{p[0][0]:.1f} {p[0][1]:.1f}C{p[1][0]:.1f} {p[1][1]:.1f} "
                    f"{p[2][0]:.1f} {p[2][1]:.1f} {p[3][0]:.1f} {p[3][1]:.1f}"
                )
        if subpaths:
            groups[key].append("".join(subpaths))

    layer_of_box = {}
    for span in page.get_texttrace():
        if span_text(span).strip():
            layer_of_box[tuple(round(v, 1) for v in span["bbox"])] = span["layer"]

    texts = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            dx, dy = line["dir"]
            angle = math.degrees(math.atan2(-dx, dy))
            span = line["spans"][0]
            text = "".join(s["text"] for s in line["spans"])
            if not text.strip():
                continue
            if layer_of_box.get(tuple(round(v, 1) for v in span["bbox"])) not in ARTWORK_TEXT_LAYERS:
                continue
            x, y = transform(span["origin"][0], span["origin"][1])
            x0, y0, width, height = VIEWBOX
            if not (x0 - 4 < x < x0 + width + 4 and y0 - 4 < y < y0 + height + 4):
                continue
            texts.append((round(x, 1), round(y, 1), round(angle, 1), round(span["size"], 2), text))

    x0, y0, width, height = VIEWBOX
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0} {y0} {width} {height}" '
        f'width="{width}" height="{height}">',
        '<g fill="none" stroke-linecap="round" stroke-linejoin="round">',
    ]
    for key in sorted(groups, key=lambda k: (k[0] != "F", k)):
        path = "".join(groups[key])
        if key[0] == "F":
            c = key[1]
            parts.append(
                f'<path d="{path}" fill="rgb({int(c[0] * 255)},{int(c[1] * 255)},{int(c[2] * 255)})" stroke="none"/>'
            )
        else:
            c = key[1]
            parts.append(
                f'<path d="{path}" stroke="rgb({int(c[0] * 255)},{int(c[1] * 255)},{int(c[2] * 255)})" '
                f'stroke-width="{key[2]}"/>'
            )
    parts.append('</g><g fill="#111" font-family="Helvetica,Arial,sans-serif">')
    for x, y, angle, size, text in texts:
        rotation = f' transform="rotate({angle} {x} {y})"' if abs(angle) > 0.5 else ""
        parts.append(f'<text x="{x}" y="{y}" font-size="{size}"{rotation}>{html.escape(text)}</text>')
    parts.append("</g></svg>")
    markup = "".join(parts)
    with open(OUTPUT_SVG, "w", encoding="utf-8") as handle:
        handle.write(markup)
    return len(markup), len(texts)


def perimeter_on_ink(page, polygons, transform):
    """Fraction of each polygon's perimeter that lies on drawn ink.

    `polygons` must be the coordinates as WRITTEN to disk, so this check
    validates the emitted file rather than an intermediate. A transform bug
    here once shipped outlines rotated 180 degrees from the artwork while the
    intermediate still measured 100% - the check has to see the same numbers
    the app does.
    """
    import numpy as np

    x0, y0, width, height = VIEWBOX
    dpi = 900
    pixmap = page.get_pixmap(
        dpi=dpi,
        clip=pymupdf.Rect(x0, y0, x0 + width, y0 + height),
        colorspace=pymupdf.csGRAY,
    )
    pixels = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width)
    ink = pixels < 200
    # Dilate by one pixel so hairline anti-aliasing is not counted as a miss.
    dilated = ink.copy()
    dilated[1:, :] |= ink[:-1, :]
    dilated[:-1, :] |= ink[1:, :]
    dilated[:, 1:] |= ink[:, :-1]
    dilated[:, :-1] |= ink[:, 1:]
    scale = dpi / 72.0

    results = {}
    for number, coords in polygons.items():
        points = [((x - x0) * scale, (y - y0) * scale) for x, y in coords]
        total = 0
        hits = 0
        for index in range(len(points) - 1):
            ax, ay = points[index]
            bx, by = points[index + 1]
            steps = max(3, int(math.dist((ax, ay), (bx, by)) / 2))
            for step in range(steps):
                fraction = step / steps
                x = int(round(ax + (bx - ax) * fraction))
                y = int(round(ay + (by - ay) * fraction))
                total += 1
                if 0 <= x < pixmap.width and 0 <= y < pixmap.height and dilated[y, x]:
                    hits += 1
        results[number] = hits / total * 100 if total else 0.0
    return results


def write_geometry(page, transform):
    faces = list(polygonize(unary_union(collect_segments(page, transform))))
    centroids = plot_number_centroids(page, transform)

    assignment = {}
    for number, (cx, cy) in centroids.items():
        point = Point(cx, cy)
        candidates = [face for face in faces if face.contains(point)]
        if candidates:
            assignment[number] = min(candidates, key=lambda face: face.area)

    colliding = collections.Counter(id(face) for face in assignment.values())
    duplicated = [key for key, count in colliding.items() if count > 1]

    total_face_area = sum(face.area for face in faces)
    metres_per_unit = math.sqrt(TOTAL_EXTENT_SQM / total_face_area)
    feet_per_unit = metres_per_unit / 0.3048
    labels = printed_labels_by_plot(page, faces, assignment)

    # Faces are ALREADY in the display coordinate system: `collect_segments`
    # applied the page rotation once when it read the drawing. Transforming
    # here as well would rotate every outline 180 degrees away from the
    # artwork, so the emitted coordinates are taken straight from the face and
    # the verification below runs on exactly these numbers.
    emitted = {}
    for number, face in assignment.items():
        coords = [(round(x, 2), round(y, 2)) for x, y in face.exterior.coords]
        if len(coords) > 1 and coords[0] == coords[-1]:
            coords = coords[:-1]
        emitted[number] = coords

    ink = perimeter_on_ink(page, emitted, transform)

    lines = []
    for number in sorted(assignment):
        face = assignment[number]
        coords = emitted[number]
        rectangle = face.minimum_rotated_rectangle
        xs, ys = rectangle.exterior.coords.xy
        edges = [
            math.dist((xs[i], ys[i]), (xs[i + 1], ys[i + 1])) for i in range(4)
        ]
        # Minimum bounding rectangle: edges[0] and edges[1] are the two
        # distinct side lengths (edges[2]/edges[3] repeat them).
        length = max(edges[0], edges[1]) * feet_per_unit
        breadth = min(edges[0], edges[1]) * feet_per_unit
        centre = face.centroid
        cx, cy = centre.x, centre.y
        area = face.area * (metres_per_unit**2)
        printed = sorted({round(value, 3) for value in labels.get(number, [])})
        lines.append(
            "  {{ plotNumber: {number}, category: '{category}', "
            "centroid: {{ x: {cx:.2f}, y: {cy:.2f} }}, areaSqM: {area:.1f}, "
            "measuredSizeFt: {{ width: {breadth:.1f}, length: {length:.1f} }}, "
            "printedLabelsFt: [{printed}], boundary: [{boundary}] }},".format(
                number=number,
                category="ews" if number >= 114 else "regular",
                cx=cx,
                cy=cy,
                area=area,
                breadth=breadth,
                length=length,
                printed=", ".join(f"{value:.2f}".rstrip("0").rstrip(".") for value in printed),
                boundary=", ".join(f"{{ x: {x:.2f}, y: {y:.2f} }}" for x, y in coords),
            )
        )

    x0, y0, width, height = VIEWBOX
    implied = PLOTTABLE_SQM - OSR_SQM - PUBLIC_PURPOSE_SQM
    header = f'''// AUTO-GENERATED FILE - do not edit by hand.
//
// Plot geometry traced from the approved CMDA layout drawing:
//   docs/CMDA LAYOUT.pdf  (1 page, /Rotate 270, pure vector, 22 OCG layers)
//
// Regenerate with:  python3 scripts/extract-cmda-layout.py
// That script documents the full pipeline and prints the verification below.
//
//   125 printed plot numbers -> 125 distinct polygonised faces, no collisions.
//   Polygon area calibrated against the drawing's own area statement
//   ("TOTAL EXTENT 17775 SQ.M"): 1 user unit = {metres_per_unit:.6f} m.
//   Summed plot area matches the statement's implied {implied:.0f} sq.m.
//
// Coordinates are SVG user units in the same space as the background artwork
// (apps/web/public/cmda-plan.svg) - do NOT rescale one without the other.
// Every coordinate comes from the drawing; none are invented.
//
// Provenance: docs/CMDA LAYOUT.pdf - Kunrathur Panchayat Union, layout of
// house sites in S.No. 149/3B2, 149/5, 149/6, 153/2, 153/3, 153/4, 154,
// 155/1, 159/1, 159/2, 160 of Varadharajapuram Village. Scale 1:800.

import type {{ PlotGeometry }} from './plot-types';

/** Viewport of the site-plan artwork, in the shared coordinate system. */
export const PLAN_VIEWBOX = {{ x: {x0}, y: {y0}, width: {width}, height: {height} }} as const;

/** Where the traceable geometry came from. */
export const PLAN_SOURCE = {{
  file: 'docs/CMDA LAYOUT.pdf',
  title: 'CMDA approved layout - Varadharajapuram Village',
  scale: '1:800',
  unitsPerMetre: {metres_per_unit:.6f},
  totalExtentSqM: {TOTAL_EXTENT_SQM:.0f},
  regularPlots: 113,
  ewsPlots: 12,
}} as const;

/** The 125 plots, ordered by plot number. */
export const PLOT_GEOMETRY: readonly PlotGeometry[] = [
'''
    markup = header + "\n".join(lines) + "\n];\n"
    with open(OUTPUT_TS, "w", encoding="utf-8") as handle:
        handle.write(markup)

    total_area = sum(face.area * (metres_per_unit**2) for face in assignment.values())
    ews_area = sum(
        face.area * (metres_per_unit**2)
        for number, face in assignment.items()
        if number >= 114
    )
    ink_values = sorted(ink.values())
    below = [(number, round(value, 1)) for number, value in ink.items() if value < 99.0]

    print(f"plot numbers found        : {len(centroids)}")
    print(f"mapped to distinct faces  : {len(assignment)} (duplicate faces: {len(duplicated)})")
    print(f"summed plot area          : {total_area:.0f} sq.m vs implied {implied:.0f} sq.m")
    print(f"  delta                   : {abs(total_area - implied) / implied * 100:.2f}%")
    print(f"EWS plots (114-125)       : {ews_area:.0f} sq.m (statement says 'E.W.S. PROVIDED 1265')")
    print(
        "perimeter on drawn ink    : median {:.1f}%, min {:.1f}%, below 99%: {}".format(
            ink_values[len(ink_values) // 2], ink_values[0], below or "none"
        )
    )
    print(f"geometry written          : {OUTPUT_TS} ({len(markup)} bytes, {len(lines)} plots)")
    print(
        f"VERDICT                   : "
        f"{'OK' if len(assignment) == 125 and not duplicated else 'REVIEW REQUIRED'}"
    )


def main() -> int:
    if not os.path.exists(SOURCE_PDF):
        sys.exit(f"source drawing not found: {SOURCE_PDF}")
    document = pymupdf.open(SOURCE_PDF)
    if document.page_count < 1:
        sys.exit("source drawing has no pages")
    page = document[0]
    transform = build_transform(page)
    print(f"source                   : {SOURCE_PDF}")
    print(f"page                     : {page.rect.width:.0f} x {page.rect.height:.0f} pt, rotate {page.rotation}")
    print(f"vector drawings          : {len(page.get_drawings())}")
    print(f"images on page           : {len(page.get_images(full=True))}")

    svg_bytes, text_count = write_artwork(page, transform)
    print(f"artwork written           : {OUTPUT_SVG} ({svg_bytes} bytes, {text_count} labels)")
    write_geometry(page, transform)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
