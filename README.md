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

### Checking the geometry

```
python tools/verify_snap.py
```

Ports `snapToRoad()` to Python and runs it against known coordinates, so the
snapping can be checked without a browser.

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
