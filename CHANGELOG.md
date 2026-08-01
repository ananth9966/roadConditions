# Changelog

## v2 — 2026-08-01

A full second build on the same skeleton as v1 (same map, legend, modal
layout, and Firebase project) — effectively a rewrite rather than an
iteration.

### Added
- **Road snapping**: reports are matched to the nearest road in
  `data/rolette_segments.geojson` and rejected if not within ~25–60 m of one,
  instead of storing raw GPS coordinates.
- **Road-stretch rendering**: reports draw as coloured road segments —
  joining nearby same-condition reports into one stretch, dashing "Scattered…"
  conditions, fading with age — instead of jittered pin markers. The full
  road network is drawn faint grey underneath so an unreported road reads as
  unknown, not clear.
- **Firestore security rules** (`firestore.rules`): append-only writes,
  field/type/range validation, county bounding-box check, snap-distance
  check. Previously the collection had no rules at all.
- **Anonymous Firebase Auth**, required for writes.
- **Offline support / installability**: `manifest.json`, a generated icon
  set, and `sw.js` caching the shell, vendor libraries, and map tiles;
  Firestore's own offline write queue enabled. The app is now an installable
  PWA; previously it was network-only with no manifest or service worker.
- **Driving mode**: a two-tap quick-report sheet with four large buttons,
  automatic UI collapse above ~10 mph, and an Undo toast after filing instead
  of a confirm-before-submit step.
- **Passive sensing** (opt-in): sustained slow travel sends an anonymized
  "this road was slow" signal to a separate `traffic` collection — no path or
  trajectory is ever recorded. Did not exist in v1.
- **Tooling**: `tools/fetch_roads.py` (pulls/simplifies/merges OSM road
  geometry), `tools/verify_snap.py` and `tools/verify_render.py` (offline
  correctness checks for the snapping/rendering math), `tools/make_icons.py`
  (generates the PWA icon set).
- **README**: expanded from two lines to full documentation of local setup,
  snapping/rendering behaviour, offline caching, and Firebase setup.

### Fixed
- GPS acquisition (`getBestPosition()`) could hang indefinitely: the timeout
  was only checked inside the position success callback, so a device that
  never delivered a fix never timed out. Replaced with an independent timer
  that bounds the wait regardless of whether a callback ever fires.
- Location permission was requested unconditionally on page load; now
  requested lazily on the user's first deliberate action.
- Report popups were built from raw HTML template strings
  (`` `<div>${label}</div>` ``), an XSS-prone pattern. Rebuilt with
  `createElement`/`textContent`.
- Report window widened from 24h to 48h, but the status card still read
  "last 24h" — fixed to derive the text from the actual window constant so
  it can't drift out of sync again.
- Dropped the `severity` field from report writes/reads and from
  `firestore.rules` validation — it was stored but never actually used on
  the render path, which always looks severity up fresh from the local
  condition table by key.
- Removed `.drivingBanner` CSS with no corresponding markup anywhere in the
  app (dead code).
- Bumped the service worker's `CACHE_VERSION` so the above client/rules
  changes reach already-installed users promptly.

### Scale
`app.js` grew from 430 to 1,165 lines; 13 new files were added (rules,
manifest, service worker, 6 icons, 4 Python tools).

---

## v1 — 2026-01-27

The original build.

- Map with Leaflet + OpenStreetMap tiles, centered on Rolette County.
- Reports submitted via GPS with a condition/severity dropdown in a modal,
  stored directly to Firestore as raw lat/lon — no road matching.
- Rendered as jittered pin markers (deterministic per-report offset so
  overlapping reports at the same spot don't stack exactly), colour-coded by
  condition, with a 24-hour visibility window.
- `getBestPosition()`: watches GPS and resolves on the best fix seen within
  a bounded wait, retained in v2 with the timeout-hang fix above.
- No Firestore security rules, no auth, no offline support, no PWA manifest,
  no service worker, no icon set.
- README was two lines.
