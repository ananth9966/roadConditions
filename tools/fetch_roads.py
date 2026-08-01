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


def _node(pt):
    return (round(pt[0], 5), round(pt[1], 5))


def _length_m(coords, coslat):
    import math
    return sum(
        math.hypot((coords[i + 1][0] - coords[i][0]) * coslat * LAT_SCALE,
                   (coords[i + 1][1] - coords[i][1]) * LAT_SCALE)
        for i in range(len(coords) - 1)
    )


def merge_roads(features):
    """Join OSM ways that are really one road.

    OSM splits a road wherever a tag changes, and again at every intersection.
    Reports can only be joined along a shared way, so an un-merged network
    means two reports on the same highway often fail to connect.

    Two rules, both conservative:

    * Named ways sharing an endpoint merge when exactly two ways *of that name*
      meet there. Crossing traffic does not matter -- staying on 102nd Street
      through a crossroads is still 102nd Street.
    * Unnamed ways merge only at a true continuation node: exactly two way-ends
      total and no other way passing through. Without a name there is nothing
      else to prove the road continues.

    Anything that branches or forms a loop is left alone, because "distance
    along the road" stops being well defined.
    """
    from collections import Counter, defaultdict

    ends = Counter()
    interior = set()
    touching = defaultdict(list)

    for i, f in enumerate(features):
        c = f["geometry"]["coordinates"]
        a, b = _node(c[0]), _node(c[-1])
        ends[a] += 1
        ends[b] += 1
        touching[a].append(i)
        touching[b].append(i)
        for p in c[1:-1]:
            interior.add(_node(p))

    name_of = [f["properties"].get("name", "") for f in features]
    parent = list(range(len(features)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for node, members in touching.items():
        by_name = defaultdict(set)
        for i in set(members):
            by_name[name_of[i]].add(i)

        for name, idxs in by_name.items():
            if len(idxs) != 2:
                continue
            a, b = sorted(idxs)
            if name:
                union(a, b)
            elif ends[node] == 2 and node not in interior:
                union(a, b)

    groups = defaultdict(list)
    for i in range(len(features)):
        groups[find(i)].append(i)

    merged, kept_apart = [], 0
    for members in groups.values():
        if len(members) == 1:
            merged.append(features[members[0]])
            continue

        chained = _chain(features, members)
        if chained is None:
            # Branching or looping: ship the pieces rather than guess an order.
            kept_apart += 1
            merged.extend(features[i] for i in members)
        else:
            merged.append(chained)

    return merged, kept_apart


def _chain(features, members):
    """Order a group of ways nose-to-tail into one LineString, or None."""
    from collections import defaultdict

    adj = defaultdict(list)
    for i in members:
        c = features[i]["geometry"]["coordinates"]
        a, b = _node(c[0]), _node(c[-1])
        if a == b:
            return None                     # closed loop
        adj[a].append(i)
        adj[b].append(i)

    if any(len(v) > 2 for v in adj.values()):
        return None                         # branches

    tips = [n for n, v in adj.items() if len(v) == 1]
    if len(tips) != 2:
        return None                         # ring, or disconnected

    start = tips[0]
    remaining = set(members)
    coords = []
    node = start

    while remaining:
        nxt = next((i for i in adj[node] if i in remaining), None)
        if nxt is None:
            return None
        remaining.discard(nxt)

        c = list(features[nxt]["geometry"]["coordinates"])
        if _node(c[0]) != node:
            c.reverse()
        if _node(c[0]) != node:
            return None                     # geometry does not actually meet

        coords.extend(c if not coords else c[1:])
        node = _node(c[-1])

    first = features[members[0]]["properties"]
    props = {"segmentId": first["segmentId"]}
    if first.get("name"):
        props["name"] = first["name"]

    return {
        "type": "Feature",
        "properties": props,
        "geometry": {"type": "LineString", "coordinates": coords},
    }


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

    before = len(features)
    features, kept_apart = merge_roads(features)

    fc = {"type": "FeatureCollection", "features": features}
    out = pathlib.Path(__file__).resolve().parent.parent / "data" / "rolette_segments.geojson"
    out.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")

    pts = sum(len(f["geometry"]["coordinates"]) for f in features)
    print("ways:     %d -> %d roads after merging (%d groups left unmerged)"
          % (before, len(features), kept_apart))
    print("vertices: %d -> %d (%.0f%% removed by %.0f m simplify)"
          % (raw_vertices, pts, 100 * (1 - pts / max(raw_vertices, 1)), SIMPLIFY_M))
    print("size:     %.0f KB" % (out.stat().st_size / 1024))

    lens = sorted(_length_m(f["geometry"]["coordinates"], coslat) for f in features)
    n = len(lens)
    print("length:   p50 %.0f m   p75 %.0f m   max %.0f m"
          % (lens[n // 2], lens[int(n * 0.75)], lens[-1]))


if __name__ == "__main__":
    main()
