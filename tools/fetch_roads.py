"""Fetch drivable road geometry for the Turtle Mountain / Rolette County area
from OpenStreetMap and write it as GeoJSON for client-side snapping.

Re-run this to refresh the data:
    python tools/fetch_roads.py

Output: data/rolette_segments.geojson
"""
import json
import pathlib
import urllib.error
import urllib.parse
import urllib.request

# Rolette County, North Dakota. North edge is the Canadian border.
BBOX = (48.53, -100.10, 49.01, -99.35)  # south, west, north, east

DRIVABLE = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|residential"
    "|living_street|motorway_link|trunk_link|primary_link|secondary_link"
    "|tertiary_link|track"
)

QUERY = """
[out:json][timeout:180];
way["highway"~"^(%s)$"](%s,%s,%s,%s);
out geom;
""" % ((DRIVABLE,) + BBOX)

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    last = None
    for url in ENDPOINTS:
        try:
            req = urllib.request.Request(
                url, data=body,
                headers={"User-Agent": "roadConditions/1.0 (TMC road conditions map)"})
            with urllib.request.urlopen(req, timeout=240) as r:
                print("fetched from", url)
                return json.load(r)
        except Exception as exc:
            print("failed:", url, exc)
            last = exc
    raise SystemExit("all Overpass endpoints failed: %s" % last)


# Douglas-Peucker tolerance in metres. Roads here are largely straight, so a
# few metres of tolerance removes most vertices. GPS is +/-10-25 m, so this is
# far below the noise floor of what we are snapping.
SIMPLIFY_M = 4.0
LAT_SCALE = 111_320.0


def _perp_distance_m(pt, a, b, coslat):
    """Perpendicular distance from pt to segment a-b, in metres."""
    px, py = (pt[0] - a[0]) * coslat * LAT_SCALE, (pt[1] - a[1]) * LAT_SCALE
    bx, by = (b[0] - a[0]) * coslat * LAT_SCALE, (b[1] - a[1]) * LAT_SCALE
    seg2 = bx * bx + by * by
    if seg2 == 0:
        return (px * px + py * py) ** 0.5
    t = max(0.0, min(1.0, (px * bx + py * by) / seg2))
    dx, dy = px - t * bx, py - t * by
    return (dx * dx + dy * dy) ** 0.5


def simplify(coords, coslat, tol=SIMPLIFY_M):
    """Iterative Douglas-Peucker (no recursion limit worries on long ways)."""
    if len(coords) < 3:
        return coords
    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi - lo < 2:
            continue
        worst, worst_i = -1.0, -1
        for i in range(lo + 1, hi):
            d = _perp_distance_m(coords[i], coords[lo], coords[hi], coslat)
            if d > worst:
                worst, worst_i = d, i
        if worst > tol:
            keep[worst_i] = True
            stack.append((lo, worst_i))
            stack.append((worst_i, hi))
    return [c for c, k in zip(coords, keep) if k]


def main():
    data = fetch()
    import math
    coslat = math.cos(math.radians((BBOX[0] + BBOX[2]) / 2))

    features = []
    raw_vertices = 0
    for el in data.get("elements", []):
        geom = el.get("geometry")
        if not geom or len(geom) < 2:
            continue
        tags = el.get("tags", {})
        # round to ~1.1 m; keeps the file small without hurting snap accuracy
        coords = [[round(p["lon"], 5), round(p["lat"], 5)] for p in geom]
        # drop consecutive duplicates introduced by rounding
        deduped = [coords[0]]
        for c in coords[1:]:
            if c != deduped[-1]:
                deduped.append(c)
        if len(deduped) < 2:
            continue
        raw_vertices += len(deduped)
        deduped = simplify(deduped, coslat)
        props = {"segmentId": "osm_%s" % el["id"]}
        if tags.get("name"):
            props["name"] = tags["name"]
        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "LineString", "coordinates": deduped},
        })

    fc = {"type": "FeatureCollection", "features": features}
    out = pathlib.Path(__file__).resolve().parent.parent / "data" / "rolette_segments.geojson"
    out.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")

    pts = sum(len(f["geometry"]["coordinates"]) for f in features)
    print("segments: %d" % len(features))
    print("vertices: %d -> %d (%.0f%% removed by %.0f m simplify)"
          % (raw_vertices, pts, 100 * (1 - pts / max(raw_vertices, 1)), SIMPLIFY_M))
    print("size:     %.0f KB" % (out.stat().st_size / 1024))


if __name__ == "__main__":
    main()
