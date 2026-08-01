// Firebase modular SDK (CDN)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, addDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// =========================
// Firebase config (yours)
// =========================
const firebaseConfig = {
  apiKey: "AIzaSyC1029z5LMX8zc-bg8tCos4pNs63fQdCyE",
  authDomain: "roadconditions-b2c62.firebaseapp.com",
  projectId: "roadconditions-b2c62",
  storageBucket: "roadconditions-b2c62.firebasestorage.app",
  messagingSenderId: "1082012577102",
  appId: "1:1082012577102:web:5625e3cb217b84898e821f",
  measurementId: "G-V9PGGEJWFQ"
};

const app = initializeApp(firebaseConfig);

// IndexedDB-backed cache: previously seen reports still render with no signal,
// and a report submitted offline is queued and sent when the connection comes
// back. Both matter on a county road in bad weather.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const auth = getAuth(app);

// Anonymous sign-in gives firestore.rules a request.auth to require, without
// asking anyone to create an account. Failure is non-fatal: if Anonymous
// sign-in is not yet enabled in the Firebase console the map still reads.
let signedIn = false;
onAuthStateChanged(auth, (user) => { signedIn = !!user; });
signInAnonymously(auth).catch((err) => {
  console.warn("Anonymous auth unavailable:", err?.code || err);
});

// =========================
// CONFIG
// =========================
// Roads here can go unplowed for days, so a report does not stop being true
// after 24 hours. Older reports stay visible but fade, which beats deleting
// information that is still the best anyone has.
const REPORT_WINDOW_HOURS = 48;
const FRESH_HOURS = 3;          // fully opaque up to here, then fades
const MAX_REPORTS = 500;

// Above this speed the UI collapses to four large buttons. 4.5 m/s is about
// 10 mph — walking pace is fine, driving is not.
const DRIVING_SPEED_MPS = 4.5;

// The conditions worth surfacing as one-tap buttons in motion. Everything
// else stays behind "More".
const QUICK_KEYS = ["iceCompactedSnow", "snowCovered", "scatteredSnowDrifts", "seasonalGood"];

// Passive sensing: sustained slow travel is itself a road-condition signal.
const PASSIVE_OPT_IN_KEY = "rc.passive.optin";
const PASSIVE_SLOW_MPS = 8.9;        // ~20 mph
const PASSIVE_MIN_SAMPLES = 6;       // ignore a single slow blip
const PASSIVE_COOLDOWN_MS = 15 * 60 * 1000;  // one signal per road per 15 min

// Snapping: reports are pinned to the nearest mapped road so a marker can
// never land on a building, field or tree line.
const ROADS_URL = "./data/rolette_segments.geojson";
const SNAP_BASE_M = 25;   // slack beyond the reported GPS accuracy
const SNAP_CAP_M  = 60;   // never snap further than this, however bad the fix
const METRES_PER_DEG_LAT = 111320;
// Rolette County spans 48.53-49.01; cos(lat) varies 0.8% across it, which is
// under a metre at snapping range. One reference value keeps the projection
// cheap enough to precompute every vertex once at load.
const REF_COSLAT = Math.cos(48.77 * Math.PI / 180);

// Condition model (solid vs striped for "Scattered ...")
const CONDITIONS = [
  { key:"closedBlocked",         label:"Closed / Blocked",         color:"#e53935", style:"solid",   severity:3 },
  { key:"noTravelAdvised",       label:"No Travel Advised",       color:"#e53935", style:"striped", severity:3 },

  { key:"iceCompactedSnow",      label:"Ice / Compacted Snow",    color:"#f4d000", style:"solid",   severity:3 },
  { key:"scatteredIce",          label:"Scattered Ice",           color:"#f4d000", style:"striped", severity:1 },

  { key:"snowCovered",           label:"Snow Covered",            color:"#b000ff", style:"solid",   severity:2 },
  { key:"scatteredSnowDrifts",   label:"Scattered Snow Drifts",   color:"#b000ff", style:"striped", severity:1 },

  { key:"frost",                 label:"Frost",                   color:"#28c8ff", style:"solid",   severity:2 },
  { key:"scatteredFrost",        label:"Scattered Frost",         color:"#28c8ff", style:"striped", severity:1 },

  { key:"wetSlush",              label:"Wet / Slush",             color:"#1565c0", style:"solid",   severity:2 },
  { key:"scatteredWetSlush",     label:"Scattered Wet / Slush",   color:"#1565c0", style:"striped", severity:1 },

  { key:"seasonalGood",          label:"Seasonal / Good",         color:"#00c853", style:"solid",   severity:1 },
];

const condByKey = new Map(CONDITIONS.map(c => [c.key, c]));

// =========================
// UI refs
// =========================
const statusText = document.getElementById("statusText");
const gpsHint = document.getElementById("gpsHint");

const btnCurrent = document.getElementById("btnCurrent");
const btnAdd = document.getElementById("btnAdd");

const legend = document.getElementById("legend");
const legendToggle = document.getElementById("legendToggle");
const legendClose = document.getElementById("legendClose");
const legendRows = document.getElementById("legendRows");

const modalBackdrop = document.getElementById("modalBackdrop");
const conditionSelect = document.getElementById("conditionSelect");
const severityText = document.getElementById("severityText");
const gpsText = document.getElementById("gpsText");
const roadText = document.getElementById("roadText");
const btnCancel = document.getElementById("btnCancel");
const btnSubmit = document.getElementById("btnSubmit");

const quickSheet = document.getElementById("quickSheet");
const quickGrid = document.getElementById("quickGrid");
const quickRoad = document.getElementById("quickRoad");
const quickHint = document.getElementById("quickHint");
const quickClose = document.getElementById("quickClose");
const quickMore = document.getElementById("quickMore");

const toast = document.getElementById("toast");
const toastText = document.getElementById("toastText");
const toastUndo = document.getElementById("toastUndo");

// =========================
// Legend + Select
// =========================
function buildLegendAndSelect(){
  legendRows.innerHTML = "";
  conditionSelect.innerHTML = "";

  for (const c of CONDITIONS) {
    const row = document.createElement("div");
    row.className = "row";
    const sym = document.createElement("div");
    sym.className = `sym ${c.style}`;
    sym.style.setProperty("--c", c.color);
    row.appendChild(sym);

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = c.label;
    row.appendChild(label);
    legendRows.appendChild(row);

    const opt = document.createElement("option");
    opt.value = c.key;
    opt.textContent = c.label;
    conditionSelect.appendChild(opt);
  }

  // The most important row on the map: grey is not "clear", it is "nobody
  // has said". Roads that go unreported are often the ones nobody could get
  // through, so this distinction has to be explicit.
  const unknown = document.createElement("div");
  unknown.className = "row";
  const usym = document.createElement("div");
  usym.className = "sym solid";
  usym.style.setProperty("--c", "#8d98a8");
  unknown.appendChild(usym);
  const ulabel = document.createElement("div");
  ulabel.className = "label";
  ulabel.innerHTML = "";
  ulabel.textContent = "No report — condition unknown, not necessarily clear";
  unknown.appendChild(ulabel);
  legendRows.appendChild(unknown);

  conditionSelect.value = "seasonalGood";
  updateSeverityText();
}

function updateSeverityText(){
  const c = condByKey.get(conditionSelect.value);
  severityText.textContent = c ? `Severity: ${c.severity}` : "Severity: --";
}
conditionSelect.addEventListener("change", updateSeverityText);

// Legend toggle
legendToggle.addEventListener("click", () => legend.classList.toggle("collapsed"));
legendClose.addEventListener("click", () => legend.classList.add("collapsed"));

// =========================
// Map setup
// =========================
const map = L.map("map", {
  zoomControl: false,
  attributionControl: true
}).setView([48.839428, -99.744865], 12);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// The whole covered network is drawn in grey beneath the reports. Without it
// an unreported road is invisible, and users read "no line" as "clear" — the
// dangerous reading, because the roads nobody reports are often the worst.
// Canvas rather than SVG: 2000+ paths would crawl as DOM nodes on a phone.
map.createPane("networkPane");
map.getPane("networkPane").style.zIndex = 350;
const networkRenderer = L.canvas({ pane: "networkPane", padding: 0.3 });
const networkLayer = L.layerGroup().addTo(map);

const markersLayer = L.layerGroup().addTo(map);
let lastReports = [];
// Kept out of the report count line so a road-data failure stays visible.
let roadsStatus = "";

// Conditions are drawn as the road itself, so stroke width stands in for road
// width and has to grow with zoom the way the basemap's roads do.
function weightForZoom(z){
  return Math.max(4, Math.min(12, Math.round(4 + (z - 10) * 1.1)));
}

map.on("zoomend", () => renderReports(lastReports));

// =========================
// Road network + snapping
// =========================
// Segments are projected once into a local metric plane so snapping is a
// straight point-to-segment distance rather than repeated trig.
let roadSegments = [];      // [{ id, name, xy: Float64Array, cum: Float64Array }]
let segmentById = new Map();
let roadsReady = false;

// Two reports on the same road are joined into one coloured stretch when they
// are no further apart than this along that road.
const JOIN_MAX_M = 2000;
// A report with no neighbour still has to be visible, so it is drawn as a
// short piece of road centred on it rather than a pin.
const STUB_M = 150;

function lonLatToXY(lon, lat){
  return [lon * REF_COSLAT * METRES_PER_DEG_LAT, lat * METRES_PER_DEG_LAT];
}
function xyToLonLat(x, y){
  return [x / (REF_COSLAT * METRES_PER_DEG_LAT), y / METRES_PER_DEG_LAT];
}

async function loadRoads(){
  const res = await fetch(ROADS_URL);
  if (!res.ok) throw new Error(`road data ${res.status}`);
  const fc = await res.json();

  roadSegments = (fc.features || [])
    .filter(f => f?.geometry?.type === "LineString" && f.geometry.coordinates.length >= 2)
    .map(f => {
      const coords = f.geometry.coordinates;
      const xy = new Float64Array(coords.length * 2);
      for (let i = 0; i < coords.length; i++){
        const [x, y] = lonLatToXY(coords[i][0], coords[i][1]);
        xy[i*2] = x;
        xy[i*2+1] = y;
      }

      // Cumulative distance to each vertex, so a report's position along the
      // road is a single number and sub-paths are a slice.
      const cum = new Float64Array(coords.length);
      for (let i = 1; i < coords.length; i++){
        const dx = xy[i*2] - xy[(i-1)*2];
        const dy = xy[i*2+1] - xy[(i-1)*2+1];
        cum[i] = cum[i-1] + Math.hypot(dx, dy);
      }

      return { id: f.properties?.segmentId || "", name: f.properties?.name || "", xy, cum };
    });

  segmentById = new Map(roadSegments.map(s => [s.id, s]));
  roadsReady = roadSegments.length > 0;

  drawNetwork(fc.features);
  return roadSegments.length;
}

// Fixed hairline weight, so zooming never needs 2000 restyle calls.
function drawNetwork(features){
  networkLayer.clearLayers();
  for (const f of features){
    const latlngs = f.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    networkLayer.addLayer(L.polyline(latlngs, {
      renderer: networkRenderer,
      pane: "networkPane",
      color: "#8d98a8",
      weight: 2,
      opacity: 0.5,
      interactive: false
    }));
  }
}

// Distance from the start of a road to the point on it closest to lat/lon.
function alongDistanceOn(seg, lat, lon){
  const [px, py] = lonLatToXY(lon, lat);
  const { xy, cum } = seg;
  let bestD2 = Infinity, bestAlong = 0;

  for (let i = 0; i < xy.length - 2; i += 2){
    const ax = xy[i], ay = xy[i+1];
    const abx = xy[i+2] - ax, aby = xy[i+3] - ay;

    const seg2 = abx*abx + aby*aby;
    let t = seg2 === 0 ? 0 : ((px - ax)*abx + (py - ay)*aby) / seg2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;

    const qx = ax + t*abx, qy = ay + t*aby;
    const d2 = (px - qx)**2 + (py - qy)**2;
    if (d2 < bestD2){
      bestD2 = d2;
      bestAlong = cum[i/2] + t * Math.sqrt(seg2);
    }
  }
  return bestAlong;
}

// The stretch of road between two along-distances, as Leaflet [lat, lon]
// pairs. Following the vertices is what makes the line bend with the road
// instead of cutting the corner.
function subPath(seg, fromM, toM){
  const { xy, cum } = seg;
  const total = cum[cum.length - 1];
  let a = Math.max(0, Math.min(total, Math.min(fromM, toM)));
  let b = Math.max(0, Math.min(total, Math.max(fromM, toM)));

  function pointAt(dist){
    // Locate the vertex pair containing dist, then interpolate.
    let i = 0;
    while (i < cum.length - 2 && cum[i+1] < dist) i++;
    const span = cum[i+1] - cum[i];
    const t = span === 0 ? 0 : (dist - cum[i]) / span;
    const x = xy[i*2] + t * (xy[i*2+2] - xy[i*2]);
    const y = xy[i*2+1] + t * (xy[i*2+3] - xy[i*2+1]);
    const [lon, lat] = xyToLonLat(x, y);
    return [lat, lon];
  }

  const path = [pointAt(a)];
  for (let i = 0; i < cum.length; i++){
    if (cum[i] > a && cum[i] < b){
      const [lon, lat] = xyToLonLat(xy[i*2], xy[i*2+1]);
      path.push([lat, lon]);
    }
  }
  path.push(pointAt(b));
  return path;
}

// Nearest point on the road network. Returns null when nothing is close
// enough, which is what stops a report being filed off-road.
function snapToRoad(lat, lon, limitM){
  if (!roadsReady) return null;

  const [px, py] = lonLatToXY(lon, lat);
  let bestD2 = Infinity, bestX = 0, bestY = 0, bestSeg = null;

  for (const seg of roadSegments){
    const xy = seg.xy;
    for (let i = 0; i < xy.length - 2; i += 2){
      const ax = xy[i], ay = xy[i+1];
      const abx = xy[i+2] - ax, aby = xy[i+3] - ay;

      const seg2 = abx*abx + aby*aby;
      let t = seg2 === 0 ? 0 : ((px - ax)*abx + (py - ay)*aby) / seg2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;

      const qx = ax + t*abx, qy = ay + t*aby;
      const dx = px - qx, dy = py - qy;
      const d2 = dx*dx + dy*dy;

      if (d2 < bestD2){ bestD2 = d2; bestX = qx; bestY = qy; bestSeg = seg; }
    }
  }

  if (!bestSeg) return null;
  const distanceM = Math.sqrt(bestD2);
  if (distanceM > limitM) return null;

  const [snapLon, snapLat] = xyToLonLat(bestX, bestY);
  return { lat: snapLat, lon: snapLon, segmentId: bestSeg.id, roadName: bestSeg.name, distanceM };
}

// How far from a road we still accept, widened by how poor the GPS fix is.
function snapLimitFor(accuracyM){
  return Math.min(SNAP_CAP_M, SNAP_BASE_M + (Number(accuracyM) || 0));
}

// =========================
// Live position
// =========================
// A continuous watch runs for as long as the app is open, so filing a report
// is instant instead of waiting up to nine seconds for a fresh fix. At speed
// that wait is the difference between a usable app and a dangerous one.
let lastFix = null;          // { lat, lon, accuracyM, speedMps, at }
let watchId = null;
const fixListeners = new Set();

function onFix(fn){ fixListeners.add(fn); return () => fixListeners.delete(fn); }

function startPositionWatch(){
  if (watchId !== null || !navigator.geolocation) return;

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy, speed } = pos.coords;
      lastFix = {
        lat: latitude,
        lon: longitude,
        accuracyM: accuracy ?? 999,
        // speed is null on hardware that does not supply it; treat as stopped
        speedMps: Number.isFinite(speed) && speed !== null ? speed : 0,
        at: Date.now()
      };
      fixListeners.forEach(fn => fn(lastFix));
    },
    (err) => console.warn("position watch:", err?.message || err),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

function stopPositionWatch(){
  if (watchId === null) return;
  navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

// A fix older than this is not worth filing a report against.
const FIX_MAX_AGE_MS = 20000;

function freshFix(){
  if (!lastFix) return null;
  return (Date.now() - lastFix.at) <= FIX_MAX_AGE_MS ? lastFix : null;
}

function isDriving(){
  const f = freshFix();
  return !!f && f.speedMps >= DRIVING_SPEED_MPS;
}

function relativeTime(date){
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
}

// Built with DOM nodes, not an HTML string: every value here originates in
// Firestore, so interpolating it into innerHTML would be an injection point.
function buildPopup(run, c, seg, lengthM){
  const wrap = document.createElement("div");

  const title = document.createElement("div");
  title.className = "popup-title";
  title.textContent = c.label;
  wrap.appendChild(title);

  const times = run
    .map(r => (r.createdAt ? new Date(r.createdAt) : null))
    .filter(Boolean)
    .sort((a, b) => b - a);

  const meta = document.createElement("div");
  meta.className = "popup-meta";

  const lines = [];
  const roadName = seg?.name || run.find(r => r.roadName)?.roadName;
  if (roadName) lines.push(`Road: ${roadName}`);
  lines.push(`Severity: ${c.severity}`);

  if (run.length > 1){
    lines.push(`${run.length} reports over ${(lengthM / 1000).toFixed(1)} km`);
    if (times.length) lines.push(`Most recent: ${relativeTime(times[0])}`);
  } else if (times.length){
    lines.push(`Reported: ${relativeTime(times[0])}`);
  }

  const worstAccuracy = Math.max(...run.map(r => Number(r.accuracyM ?? 0)));
  lines.push(`GPS accuracy: ±${worstAccuracy.toFixed(0)} m`);

  lines.forEach((text, i) => {
    if (i) meta.appendChild(document.createElement("br"));
    meta.appendChild(document.createTextNode(text));
  });
  wrap.appendChild(meta);

  return wrap;
}

// Reports are drawn as the road itself rather than as pins. Two reports of the
// same condition on the same road, within JOIN_MAX_M of each other, colour the
// stretch between them; a lone report colours a short stub.
function renderReports(reports){
  markersLayer.clearLayers();

  const weight = weightForZoom(map.getZoom());

  // Locate every report along its road.
  const placed = [];
  for (const r of reports){
    const c = condByKey.get(r.condition);
    if (!c) continue;

    let seg = r.segmentId ? segmentById.get(r.segmentId) : null;
    if (!seg){
      // Legacy reports predate segmentId, so fall back to a fresh snap.
      const snap = snapToRoad(r.lat, r.lon, SNAP_CAP_M);
      if (snap) seg = segmentById.get(snap.segmentId);
    }
    if (!seg) continue;

    placed.push({ r, c, seg, alongM: alongDistanceOn(seg, r.lat, r.lon) });
  }

  // Group by road + condition: a stretch may only be claimed for one condition.
  const groups = new Map();
  for (const p of placed){
    const key = `${p.seg.id}|${p.r.condition}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  let drawn = 0;
  for (const group of groups.values()){
    group.sort((a, b) => a.alongM - b.alongM);

    // Walk the sorted reports, breaking a run wherever the gap is too wide to
    // claim the road between them.
    let run = [group[0]];
    const runs = [];
    for (let i = 1; i < group.length; i++){
      if (group[i].alongM - run[run.length - 1].alongM <= JOIN_MAX_M) run.push(group[i]);
      else { runs.push(run); run = [group[i]]; }
    }
    runs.push(run);

    for (const members of runs){
      const seg = members[0].seg;
      const c = members[0].c;

      let fromM = members[0].alongM;
      let toM = members[members.length - 1].alongM;
      if (members.length === 1){
        fromM -= STUB_M / 2;
        toM += STUB_M / 2;
      }

      const path = subPath(seg, fromM, toM);
      if (path.length < 2) continue;

      // Age is the information here. A stretch reported twenty hours ago is
      // still worth showing when the plow may not come for days, but it must
      // not look as authoritative as one from ten minutes ago.
      const newest = Math.max(...members.map(m =>
        m.r.createdAt ? new Date(m.r.createdAt).getTime() : 0));
      const ageH = newest ? (Date.now() - newest) / 3600000 : REPORT_WINDOW_HOURS;
      const fade = ageH <= FRESH_HOURS
        ? 1
        : Math.max(0.35, 1 - 0.65 * ((ageH - FRESH_HOURS) /
                                     (REPORT_WINDOW_HOURS - FRESH_HOURS)));

      // Casing first so it sits underneath: pale conditions like frost or
      // scattered ice would otherwise wash out against a light basemap.
      markersLayer.addLayer(L.polyline(path, {
        color: "#1a1a1a",
        weight: weight + 4,
        opacity: 0.28 * fade,
        lineCap: "round",
        lineJoin: "round",
        interactive: false
      }));

      const line = L.polyline(path, {
        color: c.color,
        weight,
        opacity: 0.95 * fade,
        lineCap: "butt",
        lineJoin: "round",
        // "Scattered" conditions are intermittent, so the stroke is too.
        dashArray: c.style === "striped" ? `${weight * 1.6} ${weight * 1.2}` : null,
        interactive: true
      });

      line.bindPopup(buildPopup(members.map(m => m.r), c, seg, Math.abs(toM - fromM)));
      markersLayer.addLayer(line);
      drawn++;
    }
  }

  const summary = reports.length
    ? `${reports.length} reports on ${drawn} stretches (last 24h).`
    : "No reports in the last 24 hours.";
  statusText.textContent = roadsStatus ? `${summary} ${roadsStatus}` : summary;
}

// =========================
// Firestore stream (last 24 hours)
// =========================
function startFirestore(){
  const sinceDate = new Date(Date.now() - REPORT_WINDOW_HOURS*3600*1000);
  const sinceTs = Timestamp.fromDate(sinceDate);

  const q = query(
    collection(db, "reports"),
    where("createdAt", ">=", sinceTs),
    orderBy("createdAt", "desc"),
    limit(MAX_REPORTS)
  );

  onSnapshot(q, (snap) => {
    const out = [];
    for (const d of snap.docs) {
      const data = d.data();
      const createdAt = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : null;

      // Anything whose condition is not one of ours is discarded rather than
      // rendered: the collection is publicly writable until rules land.
      if (!condByKey.has(data.condition)) continue;
      if (!Number.isFinite(Number(data.lat)) || !Number.isFinite(Number(data.lon))) continue;

      out.push({
        id: d.id,
        condition: data.condition,
        severity: data.severity,
        lat: Number(data.lat),
        lon: Number(data.lon),
        accuracyM: Number(data.accuracyM ?? 0),
        roadName: typeof data.roadName === "string" ? data.roadName.slice(0, 80) : "",
        segmentId: typeof data.segmentId === "string" ? data.segmentId.slice(0, 40) : "",
        createdAt
      });
    }

    const now = Date.now();
    lastReports = out.filter(r => {
      if (!r.createdAt) return true;
      return (now - new Date(r.createdAt).getTime()) <= REPORT_WINDOW_HOURS*3600*1000;
    });

    renderReports(lastReports);
  }, (err) => {
    console.error("Firestore error:", err);
    statusText.textContent = `Firestore error: ${err.message || err}`;
  });
}
// Add a logo control (top-left)
const LogoControl = L.Control.extend({
  options: { position: 'topleft' },

  onAdd: function () {
    const img = L.DomUtil.create('img', 'mapLogo');
    img.src = 'assets/logo.png';   // <-- update path/name to your file
    img.alt = 'Logo';
    img.style.width = '56px';
    img.style.height = 'auto';

    // Prevent map drag/zoom when clicking the logo
    L.DomEvent.disableClickPropagation(img);
    L.DomEvent.disableScrollPropagation(img);

    return img;
  }
});

map.addControl(new LogoControl());

// =========================
// HIGH-ACCURACY location strategy
// =========================
// This is the key improvement:
// - Use watchPosition for a few seconds
// - Pick the best (lowest accuracy meters)
// - Resolve early if it reaches desired accuracy
function getBestPosition({
  maxWaitMs = 9000,
  desiredAccuracyM = 25,
  enableHighAccuracy = true
} = {}){
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not supported in this browser."));
      return;
    }

    let best = null;      // { pos }
    let settled = false;
    let watchId = null;
    let timer = null;

    // An independent timer is what actually bounds the wait. Checking elapsed
    // time inside the success callback is not enough: a stationary device can
    // deliver one fix and then go quiet, and the callback never runs again.
    function finish(fn, arg){
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      fn(arg);
    }

    timer = setTimeout(() => {
      if (best) finish(resolve, best.pos);
      else finish(reject, new Error("Timed out waiting for a GPS fix."));
    }, maxWaitMs);

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const acc = pos.coords.accuracy ?? Infinity;

        if (!best || acc < (best.pos.coords.accuracy ?? Infinity)) {
          best = { pos };
        }
        if (acc <= desiredAccuracyM) {
          finish(resolve, best.pos);
        }
      },
      (err) => finish(reject, err),
      {
        enableHighAccuracy,
        timeout: maxWaitMs,
        maximumAge: 0
      }
    );
  });
}

async function centerOnBestLocation(){
  try {
    // The live watch usually already has something good enough, so this is
    // instant rather than a fresh nine-second acquisition.
    const cached = freshFix();
    if (cached && cached.accuracyM <= 50){
      map.setView([cached.lat, cached.lon], Math.max(map.getZoom(), 14));
      statusText.textContent = `GPS OK (±${cached.accuracyM.toFixed(0)}m).`;
      gpsHint.textContent = "";
      return;
    }

    statusText.textContent = "Getting your location…";
    gpsHint.textContent = "";

    const pos = await getBestPosition({ maxWaitMs: 9000, desiredAccuracyM: 25 });
    const { latitude, longitude, accuracy } = pos.coords;

    map.setView([latitude, longitude], Math.max(map.getZoom(), 14));
    statusText.textContent = `GPS OK (±${accuracy.toFixed(0)}m).`;
    gpsHint.textContent = accuracy > 50
      ? "Tip: for better accuracy, wait 5–10s outdoors (open sky), and disable battery saver."
      : "";
  } catch (e) {
    console.warn(e);
    statusText.textContent = "Location blocked/denied. Enable location and refresh.";
    gpsHint.textContent = "";
    alert("Location blocked/denied. Please enable location permission for this site.");
  }
}

btnCurrent.addEventListener("click", centerOnBestLocation);

// The permission prompt is no longer fired blind on load. The watch starts
// once, on the first deliberate action, so the browser dialog arrives with
// context rather than before the map has even drawn.
let locationRequested = false;

function ensureLocation(){
  if (locationRequested) return;
  locationRequested = true;
  startPositionWatch();
}

btnCurrent.addEventListener("click", ensureLocation);
btnAdd.addEventListener("click", ensureLocation);

onFix((fix) => {
  applyDrivingMode();
  refreshQuickTarget();
  passiveObserve(fix);
});

document.addEventListener("visibilitychange", () => {
  // No point burning GPS while the app is in the background, and on iOS it
  // gets suspended anyway.
  if (document.hidden) stopPositionWatch();
  else if (locationRequested) startPositionWatch();
});

// =========================
// Passive sensing (opt-in)
// =========================
// Sustained slow travel on a road is itself a condition signal, and it costs
// the driver nothing. What leaves the device is deliberately *not* a track:
// only "this road was slow", once per road per cooldown. No path, no
// timestamps per point, nothing that reconstructs a journey.
let passiveOptIn = localStorage.getItem(PASSIVE_OPT_IN_KEY) === "1";
const passiveSamples = new Map();   // segmentId -> { slow, total, lastSent }

function setPassiveOptIn(on){
  passiveOptIn = on;
  localStorage.setItem(PASSIVE_OPT_IN_KEY, on ? "1" : "0");
  if (!on) passiveSamples.clear();
}

async function passiveObserve(fix){
  if (!passiveOptIn || !roadsReady) return;
  if (fix.speedMps < DRIVING_SPEED_MPS) return;   // parked or walking

  const snap = snapToRoad(fix.lat, fix.lon, snapLimitFor(fix.accuracyM));
  if (!snap) return;

  let bucket = passiveSamples.get(snap.segmentId);
  if (!bucket){
    bucket = { slow: 0, total: 0, lastSent: 0 };
    passiveSamples.set(snap.segmentId, bucket);
  }

  bucket.total += 1;
  if (fix.speedMps <= PASSIVE_SLOW_MPS) bucket.slow += 1;

  const enough = bucket.slow >= PASSIVE_MIN_SAMPLES;
  const mostlySlow = bucket.total > 0 && bucket.slow / bucket.total >= 0.7;
  const offCooldown = Date.now() - bucket.lastSent > PASSIVE_COOLDOWN_MS;

  if (!(enough && mostlySlow && offCooldown)) return;

  bucket.lastSent = Date.now();
  bucket.slow = 0;
  bucket.total = 0;

  try {
    await addDoc(collection(db, "traffic"), {
      segmentId: snap.segmentId,
      roadName: snap.roadName,
      lat: snap.lat,
      lon: snap.lon,
      // Rounded hard: the point is "slow here", not how slow, and a coarse
      // number is far less identifying.
      speedBucketMps: Math.round(PASSIVE_SLOW_MPS),
      createdAt: serverTimestamp()
    });
  } catch (e) {
    console.warn("passive signal not sent:", e?.code || e);
  }
}

// =========================
// Modal + submit
// =========================
// Shows the user where their pin is about to land, and how far it moved.
const previewLayer = L.layerGroup().addTo(map);

function showSnapPreview(rawLat, rawLon, snap){
  previewLayer.clearLayers();
  L.polyline([[rawLat, rawLon], [snap.lat, snap.lon]], {
    color: "#111", weight: 2, dashArray: "4,4", opacity: 0.7
  }).addTo(previewLayer);
  L.circleMarker([snap.lat, snap.lon], {
    radius: 6, color: "#111", weight: 2, fillColor: "#fff", fillOpacity: 1
  }).addTo(previewLayer);
}

// The fix captured when the modal opened; submit uses this rather than
// re-acquiring, so what gets stored is exactly what was previewed.
let pendingFix = null;

function setRoadNotice(kind, message){
  roadText.className = `notice ${kind}`;
  roadText.textContent = message;
}

// =========================
// Quick report
// =========================
// Nothing here waits on a fresh GPS fix: the watch has been running since the
// app opened, so a tap files immediately. The safety net is Undo afterwards
// rather than a confirm step in front.
let pendingUndo = null;   // { timer, docRef }

function buildQuickGrid(){
  quickGrid.innerHTML = "";
  for (const key of QUICK_KEYS){
    const c = condByKey.get(key);
    if (!c) continue;

    const btn = document.createElement("button");
    btn.className = "quickBtn";
    btn.type = "button";

    const sw = document.createElement("span");
    sw.className = `swatch ${c.style}`;
    sw.style.setProperty("--c", c.color);
    btn.appendChild(sw);

    const label = document.createElement("span");
    label.textContent = c.label;
    btn.appendChild(label);

    btn.addEventListener("click", () => quickSubmit(c));
    quickGrid.appendChild(btn);
  }
}

function refreshQuickTarget(){
  if (!quickSheet.classList.contains("open")) return;

  const fix = freshFix();
  if (!fix){
    quickRoad.textContent = "Waiting for GPS…";
    return;
  }
  if (!roadsReady){
    quickRoad.textContent = "Road data still loading…";
    return;
  }

  const snap = snapToRoad(fix.lat, fix.lon, snapLimitFor(fix.accuracyM));
  quickRoad.textContent = snap
    ? (snap.roadName || "Unnamed road")
    : "Not on a mapped road";
  quickHint.textContent = snap ? "" : "Move onto the road to report.";
}

function openQuickSheet(){
  quickSheet.classList.add("open");
  refreshQuickTarget();
}

function closeQuickSheet(){
  quickSheet.classList.remove("open");
}

async function quickSubmit(c){
  const fix = freshFix();
  if (!fix){
    quickHint.textContent = "No GPS fix yet — try again in a moment.";
    return;
  }
  if (!roadsReady){
    quickHint.textContent = "Road data still loading.";
    return;
  }

  const snap = snapToRoad(fix.lat, fix.lon, snapLimitFor(fix.accuracyM));
  if (!snap){
    quickHint.textContent = "You are not on a mapped road.";
    return;
  }

  closeQuickSheet();

  try {
    const ref = await addDoc(collection(db, "reports"), {
      condition: c.key,
      severity: c.severity,
      lat: snap.lat,
      lon: snap.lon,
      accuracyM: fix.accuracyM,
      segmentId: snap.segmentId,
      roadName: snap.roadName,
      snapDistanceM: snap.distanceM,
      createdAt: serverTimestamp()
    });
    showUndo(`${c.label} reported on ${snap.roadName || "this road"}`, ref);
  } catch (e) {
    console.error(e);
    showUndo(`Could not file report: ${e.message || e}`, null);
  }
}

function showUndo(message, docRef){
  toastText.textContent = message;
  toastUndo.style.display = docRef ? "" : "none";
  toast.classList.add("show");

  if (pendingUndo?.timer) clearTimeout(pendingUndo.timer);
  pendingUndo = {
    docRef,
    timer: setTimeout(() => {
      toast.classList.remove("show");
      pendingUndo = null;
    }, 6000)
  };
}

toastUndo.addEventListener("click", async () => {
  const ref = pendingUndo?.docRef;
  toast.classList.remove("show");
  if (pendingUndo?.timer) clearTimeout(pendingUndo.timer);
  pendingUndo = null;
  if (!ref) return;

  try {
    await deleteDoc(ref);
  } catch (e) {
    // Rules make reports append-only, so this only succeeds while the write
    // is still queued locally. Tell the truth rather than pretend.
    console.warn("undo failed:", e?.code || e);
    showUndo("Report already filed — it cannot be withdrawn.", null);
  }
});

quickClose.addEventListener("click", closeQuickSheet);
quickMore.addEventListener("click", () => {
  closeQuickSheet();
  openModal();
});

// =========================
// Driving mode
// =========================
// Above walking pace the interface collapses to the four buttons and nothing
// else. No dropdown, no legend, no map fiddling.
let drivingNow = false;

function applyDrivingMode(){
  const driving = isDriving();
  if (driving === drivingNow) return;
  drivingNow = driving;
  document.body.classList.toggle("driving", driving);

  if (driving){
    closeModal();
    legend.classList.add("collapsed");
  }
}

async function openModal(){
  modalBackdrop.style.display = "flex";
  gpsText.textContent = "GPS: checking…";
  setRoadNotice("pending", "Checking for a road…");
  btnSubmit.disabled = true;
  pendingFix = null;
  previewLayer.clearLayers();

  if (!roadsReady){
    setRoadNotice("warn", "Road data not loaded yet — try again in a moment.");
    return;
  }

  let pos;
  try {
    pos = await getBestPosition({ maxWaitMs: 9000, desiredAccuracyM: 25 });
  } catch {
    gpsText.textContent = "GPS unavailable (permission denied?)";
    setRoadNotice("warn", "No GPS fix, so there is nothing to place on a road.");
    return;
  }

  const { latitude, longitude, accuracy } = pos.coords;
  gpsText.textContent = `GPS accuracy: ±${accuracy.toFixed(0)} m`;

  if (accuracy > 100){
    gpsText.textContent += " (too low)";
    setRoadNotice("warn", "GPS accuracy too low — move to open sky and try again.");
    return;
  }

  const snap = snapToRoad(latitude, longitude, snapLimitFor(accuracy));
  if (!snap){
    setRoadNotice("warn", "You are not on a mapped road. Drive onto the road to report.");
    return;
  }

  pendingFix = { lat: latitude, lon: longitude, accuracyM: accuracy, snap };
  setRoadNotice("ok", snap.roadName
    ? `On ${snap.roadName} — pin moved ${snap.distanceM.toFixed(0)} m to the road`
    : `Snapped to the road — pin moved ${snap.distanceM.toFixed(0)} m`);

  showSnapPreview(latitude, longitude, snap);
  map.setView([snap.lat, snap.lon], Math.max(map.getZoom(), 15));
  btnSubmit.disabled = false;
}

function closeModal(){
  modalBackdrop.style.display = "none";
  previewLayer.clearLayers();
  pendingFix = null;
}

// The + button now opens the two-tap sheet. The detailed modal is reachable
// from "More conditions…" inside it, and never while driving.
btnAdd.addEventListener("click", openQuickSheet);
btnCancel.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal();
});

async function submitReport(){
  // Without a snapped fix there is nothing valid to file.
  if (!pendingFix){
    setRoadNotice("warn", "No road match — nothing to submit.");
    return;
  }

  btnSubmit.disabled = true;
  btnSubmit.textContent = "Submitting…";

  const { snap, accuracyM } = pendingFix;

  try {
    const c = condByKey.get(conditionSelect.value);
    if (!c) throw new Error("Invalid condition.");

    await addDoc(collection(db, "reports"), {
      condition: c.key,
      severity: c.severity,
      lat: snap.lat,                 // snapped, not raw
      lon: snap.lon,
      accuracyM,
      segmentId: snap.segmentId,
      roadName: snap.roadName,
      snapDistanceM: snap.distanceM,
      createdAt: serverTimestamp()
    });

    const { lat, lon } = snap;
    closeModal();
    map.setView([lat, lon], Math.max(map.getZoom(), 15));
  } catch (e) {
    console.error(e);
    alert(`Submit failed: ${e.message || e}`);
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.textContent = "Submit";
  }
}

btnSubmit.addEventListener("click", submitReport);

// =========================
// Boot
// =========================
buildLegendAndSelect();
buildQuickGrid();

// Passive sensing consent, off unless explicitly turned on.
const passiveToggle = document.getElementById("passiveToggle");
passiveToggle.checked = passiveOptIn;
passiveToggle.addEventListener("change", () => {
  setPassiveOptIn(passiveToggle.checked);
  if (passiveToggle.checked) ensureLocation();
});

startFirestore();

// Re-render on a timer so age fading advances without needing a new report.
setInterval(() => { if (lastReports.length) renderReports(lastReports); }, 5 * 60 * 1000);

statusText.textContent = "Loading road data…";
loadRoads()
  .then((n) => {
    roadsStatus = "";
    statusText.textContent = `Ready. ${n} road segments loaded.`;
  })
  .catch((err) => {
    console.error("Road data failed:", err);
    // Reporting stays disabled rather than silently allowing off-road pins.
    roadsStatus = "Road data unavailable — reporting disabled.";
    statusText.textContent = roadsStatus;
  });
