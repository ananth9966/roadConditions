"""Port of the client's snapToRoad() so the geometry can be checked offline.

Run:  python tools/verify_snap.py
"""
import json
import math
import pathlib

LAT_M = 111320.0
REF_COSLAT = math.cos(math.radians(48.77))
SNAP_BASE_M, SNAP_CAP_M = 25.0, 60.0

root = pathlib.Path(__file__).resolve().parent.parent
fc = json.loads((root / "data" / "rolette_segments.geojson").read_text(encoding="utf-8"))

segs = []
for f in fc["features"]:
    c = f["geometry"]["coordinates"]
    xy = [(lon * REF_COSLAT * LAT_M, lat * LAT_M) for lon, lat in c]
    segs.append((f["properties"].get("segmentId", ""), f["properties"].get("name", ""), xy))


def snap(lat, lon, limit):
    px, py = lon * REF_COSLAT * LAT_M, lat * LAT_M
    best = (float("inf"), 0, 0, None)
    for sid, name, xy in segs:
        for i in range(len(xy) - 1):
            ax, ay = xy[i]
            bx, by = xy[i + 1]
            abx, aby = bx - ax, by - ay
            s2 = abx * abx + aby * aby
            t = 0.0 if s2 == 0 else max(0.0, min(1.0, ((px - ax) * abx + (py - ay) * aby) / s2))
            qx, qy = ax + t * abx, ay + t * aby
            d2 = (px - qx) ** 2 + (py - qy) ** 2
            if d2 < best[0]:
                best = (d2, qx, qy, (sid, name))
    d = math.sqrt(best[0])
    if best[3] is None or d > limit:
        return None
    return {"lat": best[2] / LAT_M, "lon": best[1] / (REF_COSLAT * LAT_M),
            "segmentId": best[3][0], "roadName": best[3][1], "distanceM": d}


def limit_for(acc):
    return min(SNAP_CAP_M, SNAP_BASE_M + acc)


print("segments loaded: %d\n" % len(segs))

# Real reports pulled from the live Firestore collection.
cases = [
    ("live report 1", 48.89229406666667, -99.67319968333335, 10.0),
    ("live report 2", 48.88376007960324, -99.75141820837963, 19.0),
    ("live report 3", 48.89232471666666, -99.65866811666669, 10.0),
    ("map default centre", 48.839428, -99.744865, 10.0),
]
for name, lat, lon, acc in cases:
    r = snap(lat, lon, limit_for(acc))
    if r:
        print("%-20s -> %-28s %5.1f m  moved to %.6f,%.6f"
              % (name, (r["roadName"] or r["segmentId"])[:28], r["distanceM"], r["lat"], r["lon"]))
    else:
        print("%-20s -> REJECTED (no road within %.0f m)" % (name, limit_for(acc)))

# Somewhere deliberately off-road: middle of Lake Metigoshe / open country
print()
for name, lat, lon in [("open country", 48.700000, -99.900000),
                       ("far outside county", 47.500000, -97.000000)]:
    r = snap(lat, lon, limit_for(10))
    print("%-20s -> %s" % (name, "REJECTED (correct)" if r is None
                           else "accepted at %.1f m (check this)" % r["distanceM"]))
