"""Draw the site's contour motif from a real season.

The field is how settled each place in the table was, matchday by matchday:
for every snapshot of the season and every place, the largest chance any
club had of finishing there. Early on no place is anyone's; by the end every
place is somebody's. Contour lines of that field, smoothed, make the faint
map behind the hero.

    .venv/Scripts/python tools/brand/contours.py [season] [division]

writes public/contours.svg (lines only; the page colours it through a CSS
mask). Reads the built report, public/data/report-<season>.json.
"""

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
WIDTH, HEIGHT = 1600, 640       # the SVG's viewBox
GRID = 4                        # field samples per 4 viewBox units
LEVELS = 14
SMOOTH = 3.0                    # Gaussian sigma, in field samples


def field(season, division):
    report = json.loads((ROOT / "public" / "data" / f"report-{season}.json").read_text(encoding="utf-8"))
    teams = report[division]["history"]["teams"]
    # snapshots x places: the most settled club's chance of each place.
    stack = np.array([team["positions"] for team in teams])     # teams, snapshots, places
    return stack.max(axis=0)


def resample(values, width, height):
    """Bilinear resampling of a small grid onto width x height samples."""
    rows, cols = values.shape
    y = np.linspace(0, rows - 1, height)
    x = np.linspace(0, cols - 1, width)
    y0 = np.clip(np.floor(y).astype(int), 0, rows - 2)
    x0 = np.clip(np.floor(x).astype(int), 0, cols - 2)
    fy = (y - y0)[:, None]
    fx = (x - x0)[None, :]
    a = values[y0][:, x0]
    b = values[y0][:, x0 + 1]
    c = values[y0 + 1][:, x0]
    d = values[y0 + 1][:, x0 + 1]
    return a * (1 - fy) * (1 - fx) + b * (1 - fy) * fx + c * fy * (1 - fx) + d * fy * fx


def blur(values, sigma):
    radius = int(3 * sigma)
    kernel = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    kernel /= kernel.sum()
    padded = np.pad(values, radius, mode="reflect")
    rows = np.apply_along_axis(lambda r: np.convolve(r, kernel, mode="valid"), 1, padded)
    return np.apply_along_axis(lambda c: np.convolve(c, kernel, mode="valid"), 0, rows)


def contour(values, level):
    """Marching squares: polylines (lists of (x, y) in sample units) at one level."""
    rows, cols = values.shape
    above = values >= level
    segments = []

    def cross(p, q, vp, vq):
        t = (level - vp) / (vq - vp) if vq != vp else 0.5
        return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)

    for i in range(rows - 1):
        for j in range(cols - 1):
            tl, tr, br, bl = values[i, j], values[i, j + 1], values[i + 1, j + 1], values[i + 1, j]
            case = (above[i, j] << 3) | (above[i, j + 1] << 2) | (above[i + 1, j + 1] << 1) | above[i + 1, j]
            if case in (0, 15):
                continue
            # Each edge is keyed so that neighbouring cells name it the same way.
            edges = {
                "t": (("h", i, j), cross((j, i), (j + 1, i), tl, tr)),
                "r": (("v", i, j + 1), cross((j + 1, i), (j + 1, i + 1), tr, br)),
                "b": (("h", i + 1, j), cross((j, i + 1), (j + 1, i + 1), bl, br)),
                "l": (("v", i, j), cross((j, i), (j, i + 1), tl, bl)),
            }
            centre = (tl + tr + br + bl) / 4 >= level
            pairs = {
                1: ["lb"], 2: ["br"], 3: ["lr"], 4: ["tr"], 6: ["tb"], 7: ["tl"],
                8: ["tl"], 9: ["tb"], 11: ["tr"], 12: ["lr"], 13: ["br"], 14: ["lb"],
                5: ["tl", "br"] if not centre else ["tr", "lb"],
                10: ["tr", "lb"] if not centre else ["tl", "br"],
            }[case]
            for pair in pairs:
                segments.append((edges[pair[0]], edges[pair[1]]))

    # Join the segments into polylines through their shared edges.
    by_edge = {}
    for n, (a, b) in enumerate(segments):
        by_edge.setdefault(a[0], []).append(n)
        by_edge.setdefault(b[0], []).append(n)
    used = set()
    lines = []
    for start in range(len(segments)):
        if start in used:
            continue
        used.add(start)
        a, b = segments[start]
        line = [a, b]
        for forward in (True, False):
            while True:
                end = line[-1] if forward else line[0]
                nxt = [n for n in by_edge.get(end[0], []) if n not in used]
                if not nxt:
                    break
                used.add(nxt[0])
                p, q = segments[nxt[0]]
                step = q if p[0] == end[0] else p
                if forward:
                    line.append(step)
                else:
                    line.insert(0, step)
        lines.append([point for _, point in line])
    return lines


def chaikin(points, rounds=2):
    closed = len(points) > 2 and np.allclose(points[0], points[-1])
    pts = np.array(points)
    for _ in range(rounds):
        q = 0.75 * pts[:-1] + 0.25 * pts[1:]
        r = 0.25 * pts[:-1] + 0.75 * pts[1:]
        smooth = np.empty((len(q) * 2, 2))
        smooth[0::2], smooth[1::2] = q, r
        pts = np.vstack([smooth, smooth[:1]]) if closed else np.vstack([pts[:1], smooth, pts[-1:]])
    return pts


def simplify(points, tolerance):
    """Ramer-Douglas-Peucker: drop points within `tolerance` of the line."""
    keep = np.zeros(len(points), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        p, q = points[a], points[b]
        seg = q - p
        rest = points[a + 1:b] - p
        length = np.hypot(*seg)
        dist = np.abs(seg[0] * rest[:, 1] - seg[1] * rest[:, 0]) / length if length else np.hypot(rest[:, 0], rest[:, 1])
        k = int(np.argmax(dist))
        if dist[k] > tolerance:
            keep[a + 1 + k] = True
            stack += [(a, a + 1 + k), (a + 1 + k, b)]
    return points[keep]


def main():
    season = sys.argv[1] if len(sys.argv) > 1 else "2025"
    division = sys.argv[2] if len(sys.argv) > 2 else "eliteserien"
    raw = field(season, division)                 # snapshots x places
    # Time runs left to right, the table top to bottom.
    values = blur(resample(raw.T, WIDTH // GRID, HEIGHT // GRID), SMOOTH)
    lo, hi = values.min(), values.max()
    paths = []
    for level in np.linspace(lo, hi, LEVELS + 2)[1:-1]:
        for line in contour(values, level):
            if len(line) < 4:
                continue
            pts = simplify(chaikin(line) * GRID, 0.6)
            d = "M" + " ".join(f"{x:.0f} {y:.0f}" for x, y in pts)
            paths.append(f'<path d="{d}"/>')
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}" '
        f'fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="round">'
        f"<!-- Contours of how settled each place was, {division} {season}: tools/brand/contours.py -->"
        + "".join(paths)
        + "</svg>\n"
    )
    out = ROOT / "public" / "contours.svg"
    out.write_text(svg, encoding="utf-8")
    print(f"{out.relative_to(ROOT)}: {len(paths)} lines, {len(svg) // 1024} KB")


if __name__ == "__main__":
    main()
