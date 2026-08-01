// Firebase modular SDK (CDN)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, addDoc,
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
const db = getFirestore(app);
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
const TTL_HOURS = 24;
const MAX_REPORTS = 500;

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

const markersLayer = L.layerGroup().addTo(map);
let lastReports = [];
// Kept out of the report count line so a road-data failure stays visible.
let roadsStatus = "";

function markerSizeForZoom(z){
  // smaller for road display
  const size = 12 + (z - 10) * 3;
  return Math.max(10, Math.min(34, size));
}

function updateMarkerCssSize(){
  const z = map.getZoom();
  const ms = markerSizeForZoom(z);
  document.documentElement.style.setProperty("--marker-size", `${ms}px`);
}
map.on("zoomend", () => {
  updateMarkerCssSize();
  renderMarkers(lastReports);
});
updateMarkerCssSize();

// =========================
// Road network + snapping
// =========================
// Segments are projected once into a local metric plane so snapping is a
// straight point-to-segment distance rather than repeated trig.
let roadSegments = [];      // [{ id, name, xy: Float64Array }]
let roadsReady = false;

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
      return { id: f.properties?.segmentId || "", name: f.properties?.name || "", xy };
    });

  roadsReady = roadSegments.length > 0;
  return roadSegments.length;
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

function makeDivIcon(conditionKey){
  const c = condByKey.get(conditionKey) || condByKey.get("seasonalGood");
  const cls = `rc-marker ${c.style}`;
  const html = `<div class="${cls}" style="--c:${c.color}"></div>`;
  return L.divIcon({
    className: "",
    html,
    iconSize: [1,1],
    iconAnchor: [0,0]
  });
}

// Built with DOM nodes, not an HTML string: every value here originates in
// Firestore, so interpolating it into innerHTML would be an injection point.
function buildPopup(r, c){
  const wrap = document.createElement("div");

  const title = document.createElement("div");
  title.className = "popup-title";
  title.textContent = c.label;
  wrap.appendChild(title);

  const created = r.createdAt ? new Date(r.createdAt) : null;
  const expires = created ? new Date(created.getTime() + TTL_HOURS*3600*1000) : null;

  const meta = document.createElement("div");
  meta.className = "popup-meta";
  const lines = [];
  if (r.roadName) lines.push(`Road: ${r.roadName}`);
  lines.push(`Severity: ${Number(r.severity) || c.severity}`);
  lines.push(`Time: ${created ? created.toLocaleString() : "--"}`);
  lines.push(`Visible until: ${expires ? expires.toLocaleString() : "--"}`);
  lines.push(`GPS accuracy: ${Number(r.accuracyM ?? 0).toFixed(1)} m`);

  lines.forEach((text, i) => {
    if (i) meta.appendChild(document.createElement("br"));
    meta.appendChild(document.createTextNode(text));
  });
  wrap.appendChild(meta);

  return wrap;
}

function renderMarkers(reports){
  markersLayer.clearLayers();

  for (const r of reports) {
    // Coordinates were snapped to the road network before they were stored,
    // so they are placed exactly as saved. No jitter: displacing a marker
    // would move it back off the road.
    const c = condByKey.get(r.condition);
    if (!c) continue;

    const m = L.marker([r.lat, r.lon], {
      icon: makeDivIcon(r.condition),
      keyboard: false
    });

    m.bindPopup(buildPopup(r, c));
    markersLayer.addLayer(m);
  }

  statusText.textContent = roadsStatus
    ? `Showing ${reports.length} reports (last 24h). ${roadsStatus}`
    : `Showing ${reports.length} reports (last 24h).`;
}

// =========================
// Firestore stream (last 24 hours)
// =========================
function startFirestore(){
  const sinceDate = new Date(Date.now() - TTL_HOURS*3600*1000);
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
      return (now - new Date(r.createdAt).getTime()) <= TTL_HOURS*3600*1000;
    });

    renderMarkers(lastReports);
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

// Ask location on load (your requirement)
window.addEventListener("load", () => {
  centerOnBestLocation();
});

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

async function openModal(){
  modalBackdrop.style.display = "flex";
  gpsText.textContent = "GPS: checking…";
  roadText.textContent = "Road: --";
  btnSubmit.disabled = true;
  pendingFix = null;
  previewLayer.clearLayers();

  if (!roadsReady){
    roadText.textContent = "Road data not loaded yet — try again in a moment.";
    return;
  }

  let pos;
  try {
    pos = await getBestPosition({ maxWaitMs: 9000, desiredAccuracyM: 25 });
  } catch {
    gpsText.textContent = "GPS unavailable (permission denied?)";
    return;
  }

  const { latitude, longitude, accuracy } = pos.coords;
  gpsText.textContent = `GPS accuracy: ±${accuracy.toFixed(0)} m`;

  if (accuracy > 100){
    gpsText.textContent += " (too low — move to open sky and try again)";
    return;
  }

  const snap = snapToRoad(latitude, longitude, snapLimitFor(accuracy));
  if (!snap){
    roadText.textContent = "You are not on a mapped road. Move onto the road to report.";
    return;
  }

  pendingFix = { lat: latitude, lon: longitude, accuracyM: accuracy, snap };
  roadText.textContent = snap.roadName
    ? `Road: ${snap.roadName} — pin moved ${snap.distanceM.toFixed(0)} m`
    : `Snapped to road — pin moved ${snap.distanceM.toFixed(0)} m`;

  showSnapPreview(latitude, longitude, snap);
  map.setView([snap.lat, snap.lon], Math.max(map.getZoom(), 15));
  btnSubmit.disabled = false;
}

function closeModal(){
  modalBackdrop.style.display = "none";
  previewLayer.clearLayers();
  pendingFix = null;
}

btnAdd.addEventListener("click", openModal);
btnCancel.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal();
});

async function submitReport(){
  // Without a snapped fix there is nothing valid to file.
  if (!pendingFix){
    roadText.textContent = "No road match — nothing to submit.";
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
startFirestore();

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
