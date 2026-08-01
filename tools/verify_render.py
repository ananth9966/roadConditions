"""Port of the client's along-distance / sub-path / run-grouping logic so the
road-stretch rendering can be checked without a browser.

Run:  python tools/verify_render.py
"""
import json
import math
import pathlib

LAT_M = 111320.0
REF_COSLAT = math.cos(math.radians(48.77))
JOIN_MAX_M = 2000
STUB_M = 150

root = pathlib.Path(__file__).resolve().parent.parent
fc = json.loads((root / "data" / "rolette_segments.geojson").read_text(encoding="utf-8"))


def to_xy(lon, lat):
    return lon * REF_COSLAT * LAT_M, lat * LAT_M


segments = {}
for f in fc["features"]:
    coords = f["geometry"]["coordinates"]
    xy = [to_xy(lo, la) for lo, la in coords]
    cum = [0.0]
    for i in range(1, len(xy)):
        cum.append(cum[-1] + math.dist(xy[i - 1], xy[i]))
    segments[f["properties"]["segmentId"]] = {
        "name": f["properties"].get("name", ""), "xy": xy, "cum": cum,
    }


def snap(lat, lon):
    px, py = to_xy(lon, lat)
    best = (float("inf"), None, 0.0)
    for sid, s in segments.items():
        xy, cum = s["xy"], s["cum"]
        for i in range(len(xy) - 1):
            ax, ay = xy[i]
            bx, by = xy[i + 1]
            abx, aby = bx - ax, by - ay
            s2 = abx * abx + aby * aby
            t = 0.0 if s2 == 0 else max(0.0, min(1.0, ((px - ax) * abx + (py - ay) * aby) / s2))
            qx, qy = ax + t * abx, ay + t * aby
            d2 = (px - qx) ** 2 + (py - qy) ** 2
            if d2 < best[0]:
                best = (d2, sid, cum[i] + t * math.sqrt(s2))
    return math.sqrt(best[0]), best[1], best[2]


def sub_path(sid, a, b):
    s = segments[sid]
    xy, cum = s["xy"], s["cum"]
    total = cum[-1]
    a, b = max(0.0, min(total, min(a, b))), max(0.0, min(total, max(a, b)))

    def point_at(d):
        i = 0
        while i < len(cum) - 2 and cum[i + 1] < d:
            i += 1
        span = cum[i + 1] - cum[i]
        t = 0.0 if span == 0 else (d - cum[i]) / span
        return (xy[i][0] + t * (xy[i + 1][0] - xy[i][0]),
                xy[i][1] + t * (xy[i + 1][1] - xy[i][1]))

    path = [point_at(a)]
    path += [xy[i] for i in range(len(cum)) if a < cum[i] < b]
    path.append(point_at(b))
    return path, b - a


def path_length(p):
    return sum(math.dist(p[i], p[i + 1]) for i in range(len(p) - 1))


# --- pick a genuinely curved road so "follows the road" is actually tested ---
curviest, best_ratio = None, 1.0
for sid, s in segments.items():
    if len(s["xy"]) < 6 or s["cum"][-1] < 800:
        continue
    straight = math.dist(s["xy"][0], s["xy"][-1])
    if straight == 0:
        continue
    ratio = straight / s["cum"][-1]
    if ratio < best_ratio:
        best_ratio, curviest = ratio, sid

s = segments[curviest]
print("curviest way: %s (%s)" % (curviest, s["name"] or "unnamed"))
print("  vertices %d, length %.0f m, straight-line %.0f m"
      % (len(s["xy"]), s["cum"][-1], math.dist(s["xy"][0], s["xy"][-1])))

path, span = sub_path(curviest, 0, s["cum"][-1])
print("  sub-path vertices: %d  length %.0f m" % (len(path), path_length(path)))
print("  follows road (not a chord): %s"
      % (len(path) > 2 and abs(path_length(path) - s["cum"][-1]) < 1.0))

# a slice from the middle should keep interior vertices
mid_a, mid_b = s["cum"][-1] * 0.3, s["cum"][-1] * 0.7
mp, mspan = sub_path(curviest, mid_a, mid_b)
print("  middle slice: %d vertices, %.0f m requested, %.0f m drawn"
      % (len(mp), mid_b - mid_a, path_length(mp)))

# --- run grouping ---
print("\nrun grouping (JOIN_MAX_M = %d):" % JOIN_MAX_M)


def runs_for(alongs):
    alongs = sorted(alongs)
    out, run = [], [alongs[0]]
    for a in alongs[1:]:
        if a - run[-1] <= JOIN_MAX_M:
            run.append(a)
        else:
            out.append(run)
            run = [a]
    out.append(run)
    return out


for label, alongs in [
    ("two close (300 m apart)", [1000, 1300]),
    ("two far (5 km apart)", [1000, 6000]),
    ("chain of three", [1000, 2500, 4000]),
    ("two close + one far", [1000, 1200, 9000]),
    ("single", [1000]),
]:
    rs = runs_for(alongs)
    desc = ", ".join(
        ("stub %d m" % STUB_M) if len(r) == 1 else ("joined %.0f m" % (r[-1] - r[0]))
        for r in rs
    )
    print("  %-24s -> %d stretch(es): %s" % (label, len(rs), desc))

# --- live reports, if any are still inside the window ---
print("\nagainst the three stored reports:")
for lat, lon in [(48.89229406666667, -99.67319968333335),
                 (48.88376007960324, -99.75141820837963),
                 (48.89232471666666, -99.65866811666669)]:
    d, sid, along = snap(lat, lon)
    name = segments[sid]["name"] or sid
    print("  %.5f,%.5f -> %-26s %6.1f m off-road, %7.0f m along"
          % (lat, lon, name[:26], d, along))
