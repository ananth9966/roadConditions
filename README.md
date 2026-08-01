# roadConditions

TMC Local Road Conditions project — a crowd-sourced winter road map for the
Turtle Mountain area, Rolette County, North Dakota.

Reports are pinned to the nearest mapped road, so a marker can never land on a
building, a field or a tree line. If you are not near a road, you cannot file a
report.

## Running locally

No build step and no dependencies to install:

```
python -m http.server 8000
```

Then open <http://localhost:8000>. The `.vscode/launch.json` config launches
Chrome against the same port.

Geolocation needs a secure context. `localhost` counts as secure; if you serve
it from another host it must be over HTTPS or the browser will refuse to give
out a position.

## How snapping works

`data/rolette_segments.geojson` holds the drivable road network for Rolette
County, pulled from OpenStreetMap. On load the client projects every vertex
into a local metric plane, and `snapToRoad()` finds the nearest point on the
nearest segment.

A report is accepted only when that distance is within
`min(60, 25 + gpsAccuracy)` metres — the allowance widens when the GPS fix is
poor, but never past 60 m. The stored coordinates are the *snapped* ones, not
the raw GPS reading.

### Refreshing the road data

```
python tools/fetch_roads.py
```

Re-queries Overpass and rewrites the GeoJSON. Geometry is simplified with a 4 m
Douglas-Peucker tolerance, which removes about 70% of vertices — far below the
±10–25 m noise floor of a phone GPS. Current output is 2,476 segments, ~615 KB
raw and ~107 KB gzipped.

To cover a different area, edit `BBOX` at the top of that script.

## How conditions are drawn

Reports are not pins. Each one is placed along its road by distance from the
road's start, and then drawn as the road itself, the way a DOT road-conditions
map does it:

- Two or more reports of the **same condition on the same road**, each within
  `JOIN_MAX_M` (2 km) of the next, colour the whole stretch between them.
- A report with no neighbour in range is drawn as a `STUB_M` (150 m) piece of
  road centred on it.
- Lines follow the road's vertices, so they bend with the road rather than
  cutting across a curve.
- "Scattered …" conditions are dashed, matching their striped legend swatch.
- A dark casing sits under each stroke so pale colours such as frost stay
  readable on a light basemap.
- Stroke width grows with zoom, standing in for road width.

Reports can only be joined along a shared OpenStreetMap way. OSM splits roads
arbitrarily, so two reports on one physical road may sit on different ways and
stay separate. Way lengths here are a median of 573 m and 1,614 m at the 75th
percentile, so most joins that matter do land on a single way.

### Checking the geometry

```
python tools/verify_snap.py
```

Ports `snapToRoad()` to Python and runs it against known coordinates, so the
snapping can be checked without a browser.

```
python tools/verify_render.py
```

Does the same for the drawing logic: confirms a sub-path traces the road
rather than cutting a chord (it tests against the curviest way in the county —
2,466 m long with its endpoints only 37 m apart) and that run grouping joins,
chains and splits at the right distances.

## Installing on a phone

The app is a PWA, so it installs from the browser with no app store:

- **Android / Chrome** — open the site, then *Add to Home screen* (Chrome
  usually offers an install prompt on its own).
- **iOS / Safari** — Share → *Add to Home Screen*.

It then launches without browser chrome, with its own icon and splash colour.
`tools/make_icons.py` regenerates the icon set from `assets/logo.png`; the
source is photographic, so icons are octree-quantised to 128 colours, which
takes the 512px icon from 420 KB to about 67 KB.

## Working offline

Signal disappears exactly where this app is most needed, so `sw.js` caches:

| Cache | Contents | Strategy |
| --- | --- | --- |
| `rc-shell` | HTML, JS, CSS, icons, road GeoJSON | cache-first, revalidated |
| `rc-vendor` | Leaflet and Firebase (version-pinned) | cache-first |
| `rc-tiles` | Map tiles you have viewed | cache-first, capped at 400 |

Firestore requests are deliberately left alone — the SDK has its own offline
layer, enabled here via `persistentLocalCache`. Previously seen reports render
with no connection, and a report submitted offline is queued and sent when the
connection returns.

Bump `CACHE_VERSION` in `sw.js` whenever the shell or road data changes; old
caches are deleted on activate.

## Firebase setup

Two console steps are required before the security rules will work:

1. **Authentication → Sign-in method → enable Anonymous.** The client signs in
   anonymously so the rules have a `request.auth` to require. Nobody has to
   create an account.
2. **Deploy the rules:**

   ```
   firebase deploy --only firestore:rules
   ```

`firestore.rules` keeps reads public (the map is public) but makes the
`reports` collection append-only and validates every field on create:
condition must be one of the eleven known keys, severity 1–3, coordinates
inside the county bounding box, snap distance ≤ 60 m, and the timestamp must be
the server's own.

Also turn on **App Check** in the Firebase console. The rules stop malformed
writes, but only App Check stops a script writing well-formed junk in bulk.

The `apiKey` in `app.js` is not a secret — Firebase web keys identify the
project rather than authorise access. Rules and App Check are what protect the
data.

## Licence

GPL-3.0. See `LICENSE`.
