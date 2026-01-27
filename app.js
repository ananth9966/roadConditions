// Firebase modular SDK (CDN)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, addDoc,
  query, where, orderBy, limit, onSnapshot,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebasejs/10.12.0/firebase-firestore.js";

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

// =========================
// CONFIG
// =========================
const TTL_HOURS = 24;
const MAX_REPORTS = 500;

// Road restriction (no logins; client-side guard)
// - Loads a local GeoJSON of road centerlines
// - On submit, snaps GPS to nearest road and rejects if too far
const ROAD_GEOJSON_URL = "./rolette_segments.geojson"; // must be served
const ROAD_MAX_DIST_M = 35; // allowed GPS distance from a mapped road (meters)
const REQUIRE_ROAD_GEOMETRY = true; // if true: block submit when roads fail to load

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

const roadLayer = L.layerGroup().addTo(map);
const markersLayer = L.layerGroup().addTo(map);
let lastReports = [];

// =========================
// Roads: load + nearest-point helpers
// =========================
let roadSegments = []; // [{aLat,aLon,bLat,bLon}]
let roadsLoaded = false;

function pushLineSegments(coords){
  // coords: array of [lon,lat]
  for (let i = 0; i < coords.length - 1; i++){
    const a = coords[i];
    const b = coords[i+1];
    if (!a || !b) continue;
    const aLon = Number(a[0]), aLat = Number(a[1]);
    const bLon = Number(b[0]), bLat = Number(b[1]);
    if (!Number.isFinite(aLat) || !Number.isFinite(aLon) || !Number.isFinite(bLat) || !Number.isFinite(bLon)) continue;
    roadSegments.push({ aLat, aLon, bLat, bLon });
  }
}

function extractSegmentsFromGeoJSON(gj){
  roadSegments = [];

  const addGeom = (geom) => {
    if (!geom) return;
    if (geom.type === "LineString") {
      pushLineSegments(geom.coordinates || []);
    } else if (geom.type === "MultiLineString") {
      for (const line of (geom.coordinates || [])) pushLineSegments(line || []);
    } else if (geom.type === "GeometryCollection") {
      for (const g of (geom.geometries || [])) addGeom(g);
    }
  };

  if (gj.type === "FeatureCollection") {
    for (const f of (gj.features || [])) addGeom(f.geometry);
  } else if (gj.type === "Feature") {
    addGeom(gj.geometry);
  } else {
    addGeom(gj);
  }
}

async function loadRoads(){
  try {
    const res = await fetch(ROAD_GEOJSON_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gj = await res.json();

    // draw roads (thin line)
    L.geoJSON(gj, { style: { weight: 2, opacity: 0.6 } }).addTo(roadLayer);

    extractSegmentsFromGeoJSON(gj);
    roadsLoaded = true;

    if (roadSegments.length === 0) {
      console.warn("Road GeoJSON loaded but no LineString segments found.");
      gpsHint.textContent = "Road data loaded, but no segments found (reports will not be road-restricted).";
    }
  } catch (e) {
    console.warn("Road GeoJSON failed to load:", e);
    roadsLoaded = false;
    gpsHint.textContent = REQUIRE_ROAD_GEOMETRY
      ? "Road data failed to load — reporting is disabled until it loads."
      : "Road data failed to load — reports won't be road-restricted.";
  }
}

// Convert a lat/lon delta to meters around a reference latitude
function llToMetersDelta(dLat, dLon, refLat){
  const mPerDegLat = 111111;
  const cos = Math.max(0.1, Math.cos(refLat * Math.PI / 180));
  const mPerDegLon = 111111 * cos;
  return { x: dLon * mPerDegLon, y: dLat * mPerDegLat };
}
function metersDeltaToLL(dx, dy, refLat){
  const degPerMlat = 1 / 111111;
  const cos = Math.max(0.1, Math.cos(refLat * Math.PI / 180));
  const degPerMlon = 1 / (111111 * cos);
  return { dLat: dy * degPerMlat, dLon: dx * degPerMlon };
}

// nearest point on any road segment
function nearestPointOnRoad(lat, lon){
  if (!roadSegments || roadSegments.length === 0) {
    return { ok: false, distM: Infinity, snapLat: lat, snapLon: lon };
  }

  let best = { distM: Infinity, snapLat: lat, snapLon: lon };

  for (const s of roadSegments){
    const A = llToMetersDelta(s.aLat - lat, s.aLon - lon, lat);
    const B = llToMetersDelta(s.bLat - lat, s.bLon - lon, lat);

    const vx = B.x - A.x;
    const vy = B.y - A.y;
    const denom = (vx*vx + vy*vy);
    if (denom <= 1e-9) continue;

    let t = ( (-A.x)*vx + (-A.y)*vy ) / denom;
    t = Math.max(0, Math.min(1, t));

    const cx = A.x + t*vx;
    const cy = A.y + t*vy;

    const dist = Math.hypot(cx, cy);
    if (dist < best.distM) {
      const d = metersDeltaToLL(cx, cy, lat);
      best = { distM: dist, snapLat: lat + d.dLat, snapLon: lon + d.dLon };
    }
  }

  return { ok: true, ...best };
}

function markerSizeForZoom(z){
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

// deterministic jitter (DISPLAY ONLY; tiny so reports don't look stacked)
function jitterLatLng(lat, lon, seed){
  const meters = 2;

  let h = 0;
  for (let i=0;i<seed.length;i++){ h = (h*31 + seed.charCodeAt(i)) | 0; }
  const dx = (((h      ) & 255) - 128) / 128;
  const dy = (((h >> 8 ) & 255) - 128) / 128;

  const dLat = (meters / 111111) * dy;
  const cosLat = Math.max(0.1, Math.cos(Math.abs(lat) * Math.PI/180));
  const dLon = (meters / (111111 * cosLat)) * dx;

  return [lat + dLat, lon + dLon];
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

function renderMarkers(reports){
  markersLayer.clearLayers();

  for (const r of reports) {
    const [pLat, pLon] = jitterLatLng(r.lat, r.lon, r.id);

    const m = L.marker([pLat, pLon], {
      icon: makeDivIcon(r.condition),
      keyboard: false
    });

    const created = r.createdAt ? new Date(r.createdAt) : null;
    const expires = created ? new Date(created.getTime() + TTL_HOURS*3600*1000) : null;

    const c = condByKey.get(r.condition);
    const label = c ? c.label : r.condition;

    m.bindPopup(`
      <div class="popup-title">${label}</div>
      <div class="popup-meta">
        Severity: ${r.severity ?? (c?.severity ?? "--")}<br/>
        Time: ${created ? created.toLocaleString() : "--"}<br/>
        Visible until: ${expires ? expires.toLocaleString() : "--"}<br/>
        Accuracy: ${Number(r.accuracyM ?? 0).toFixed(1)} m<br/>
        ${Number.isFinite(r.snapDistM) ? `Road snap: ${Number(r.snapDistM).toFixed(1)} m` : ""}
      </div>
    `);

    markersLayer.addLayer(m);
  }

  statusText.textContent = `Showing ${reports.length} reports (last 24h).`;
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

      out.push({
        id: d.id,
        condition: data.condition,
        severity: data.severity,
        lat: Number(data.lat),
        lon: Number(data.lon),
        accuracyM: Number(data.accuracyM ?? 0),
        snapDistM: Number.isFinite(Number(data.snapDistM)) ? Number(data.snapDistM) : undefined,
        createdAt
      });
    }

    const now = Date.now();
    lastReports = out.filter(r => !r.createdAt || (now - new Date(r.createdAt).getTime()) <= TTL_HOURS*3600*1000);

    renderMarkers(lastReports);
  }, (err) => {
    console.error("Firestore error:", err);
    statusText.textContent = `Firestore error: ${err.message || err}`;
  });
}

// =========================
// HIGH-ACCURACY location strategy
// =========================
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

    let best = null;
    const t0 = Date.now();

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const acc = pos.coords.accuracy ?? Infinity;

        if (!best || acc < (best.pos.coords.accuracy ?? Infinity)) best = { pos, t: Date.now() };

        if (acc <= desiredAccuracyM) {
          navigator.geolocation.clearWatch(watchId);
          resolve(best.pos);
        }

        if (Date.now() - t0 >= maxWaitMs) {
          navigator.geolocation.clearWatch(watchId);
          if (best) resolve(best.pos);
          else reject(new Error("No GPS fix. Check permissions."));
        }
      },
      (err) => {
        navigator.geolocation.clearWatch(watchId);
        reject(err);
      },
      { enableHighAccuracy, timeout: maxWaitMs, maximumAge: 0 }
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
window.addEventListener("load", () => centerOnBestLocation());

// =========================
// Modal + submit
// =========================
function openModal(){
  modalBackdrop.style.display = "flex";
  gpsText.textContent = "GPS: checking…";
  btnSubmit.disabled = true;

  getBestPosition({ maxWaitMs: 9000, desiredAccuracyM: 25 })
    .then((pos) => {
      const { accuracy } = pos.coords;
      gpsText.textContent = `GPS accuracy: ±${accuracy.toFixed(0)} m`;

      btnSubmit.disabled = accuracy > 100;

      if (accuracy > 100) gpsText.textContent += " (too low — move to open sky and try again)";

      if (REQUIRE_ROAD_GEOMETRY && (!roadsLoaded || roadSegments.length === 0)) {
        btnSubmit.disabled = true;
        gpsText.textContent += " (road data not loaded yet)";
      }
    })
    .catch(() => {
      gpsText.textContent = "GPS unavailable (permission denied?)";
      btnSubmit.disabled = true;
    });
}

function closeModal(){
  modalBackdrop.style.display = "none";
}

btnAdd.addEventListener("click", openModal);
btnCancel.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) closeModal(); });

async function submitReport(){
  btnSubmit.disabled = true;
  btnSubmit.textContent = "Submitting…";

  try {
    if (REQUIRE_ROAD_GEOMETRY && (!roadsLoaded || roadSegments.length === 0)) {
      throw new Error("Road data not loaded yet. Refresh and try again.");
    }

    const pos = await getBestPosition({ maxWaitMs: 9000, desiredAccuracyM: 25 });
    const { latitude, longitude, accuracy } = pos.coords;

    const c = condByKey.get(conditionSelect.value);
    if (!c) throw new Error("Invalid condition.");

    // Road restriction: snap + reject if too far
    let finalLat = latitude;
    let finalLon = longitude;
    let snapDistM = null;

    if (roadSegments.length > 0) {
      const n = nearestPointOnRoad(latitude, longitude);
      snapDistM = n.distM;

      const allowed = Math.max(20, accuracy); // accuracy from GPS in meters
      if (n.distM > allowed) {
      throw new Error(`You appear to be ${n.distM.toFixed(0)}m from a mapped road. Report only from a road (within ${allowed.toFixed(0)}m).`);
    }


      finalLat = n.snapLat;
      finalLon = n.snapLon;
    }

    await addDoc(collection(db, "reports"), {
      condition: c.key,
      severity: c.severity,
      lat: finalLat,
      lon: finalLon,
      accuracyM: accuracy,
      snapDistM,
      createdAt: serverTimestamp()
    });

    closeModal();
    map.setView([finalLat, finalLon], Math.max(map.getZoom(), 14));
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
loadRoads();
startFirestore();
statusText.textContent = "Ready.";
