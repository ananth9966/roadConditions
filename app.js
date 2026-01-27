// Firebase modular SDK (CDN)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, addDoc,
  query, where, orderBy, limit, onSnapshot,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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

// GPS restriction + snapping
const REQUIRED_ACCURACY_M = 35;     // tighten to reduce indoor submits (try 25–50)
const ROAD_SNAP_MAX_M = 20;         // your “20m”
const ROADS_GEOJSON_URL = "./rolette_segments.geojson";

// Condition model (solid vs striped for "Scattered ...")
const CONDITIONS = [
  { key:"closedBlocked",         label:"Closed / Blocked",         color:"#e53935", style:"solid",   severity:3 },
  { key:"noTravelAdvised",       label:"No Travel Advised",        color:"#e53935", style:"striped", severity:3 },

  { key:"iceCompactedSnow",      label:"Ice / Compacted Snow",     color:"#f4d000", style:"solid",   severity:3 },
  { key:"scatteredIce",          label:"Scattered Ice",            color:"#f4d000", style:"striped", severity:1 },

  { key:"snowCovered",           label:"Snow Covered",             color:"#b000ff", style:"solid",   severity:2 },
  { key:"scatteredSnowDrifts",   label:"Scattered Snow Drifts",    color:"#b000ff", style:"striped", severity:1 },

  { key:"frost",                 label:"Frost",                    color:"#28c8ff", style:"solid",   severity:2 },
  { key:"scatteredFrost",        label:"Scattered Frost",          color:"#28c8ff", style:"striped", severity:1 },

  { key:"wetSlush",              label:"Wet / Slush",              color:"#1565c0", style:"solid",   severity:2 },
  { key:"scatteredWetSlush",     label:"Scattered Wet / Slush",    color:"#1565c0", style:"striped", severity:1 },

  { key:"seasonalGood",          label:"Seasonal / Good",          color:"#00c853", style:"solid",   severity:1 },
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

// We’ll primarily render ROAD LINES now (not markers)
let roadsLayer = null;
const roadLayerById = new Map(); // segmentId -> Leaflet layer
let roadsLoaded = false;

let lastReports = [];

// =========================
// Road helpers (snap-to-road)
// =========================
function toRad(d){ return d * Math.PI/180; }
function haversineMeters(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Equirectangular projection around origin (good for short distances)
function project(lat, lon, lat0){
  const x = toRad(lon) * Math.cos(toRad(lat0)) * 6371000;
  const y = toRad(lat) * 6371000;
  return {x, y};
}
function unproject(x, y, lat0){
  const lat = (y / 6371000) * (180/Math.PI);
  const lon = (x / (6371000 * Math.cos(toRad(lat0)))) * (180/Math.PI);
  return {lat, lon};
}

// Closest point on polyline (LineString) to a lat/lon
function closestPointOnLineString(lat, lon, coords){
  // coords: [[lon,lat], ...] in GeoJSON
  const lat0 = lat;
  const p = project(lat, lon, lat0);

  let best = null; // {lat, lon, distM, tSeg, segIndex}
  for (let i = 0; i < coords.length - 1; i++){
    const aLL = coords[i];
    const bLL = coords[i+1];
    const a = project(aLL[1], aLL[0], lat0);
    const b = project(bLL[1], bLL[0], lat0);

    const abx = b.x - a.x, aby = b.y - a.y;
    const apx = p.x - a.x, apy = p.y - a.y;
    const ab2 = abx*abx + aby*aby || 1e-9;
    let t = (apx*abx + apy*aby) / ab2;
    t = Math.max(0, Math.min(1, t));

    const cx = a.x + t*abx;
    const cy = a.y + t*aby;

    const cp = unproject(cx, cy, lat0);
    const d = Math.hypot(p.x - cx, p.y - cy);

    if (!best || d < best.distM){
      best = { lat: cp.lat, lon: cp.lon, distM: d, segIndex: i, tSeg: t };
    }
  }
  return best;
}

function featureToSegmentId(feature, idx){
  // Prefer a stable ID if your GeoJSON has it
  const p = feature?.properties || {};
  return p.segmentId ?? p.id ?? p.NAME ?? p.name ?? String(idx);
}

function snapToRoad(lat, lon){
  if (!roadsLayer || !roadsLoaded) return null;

  let best = null; // {segmentId, snapLat, snapLon, distM}

  let idx = 0;
  roadsLayer.eachLayer((layer) => {
    const feature = layer.feature;
    const segId = featureToSegmentId(feature, idx);

    if (!feature?.geometry) { idx++; return; }

    if (feature.geometry.type === "LineString"){
      const cp = closestPointOnLineString(lat, lon, feature.geometry.coordinates);
      if (cp && (!best || cp.distM < best.distM)){
        best = { segmentId: segId, snapLat: cp.lat, snapLon: cp.lon, distM: cp.distM };
      }
    } else if (feature.geometry.type === "MultiLineString"){
      for (const ls of feature.geometry.coordinates){
        const cp = closestPointOnLineString(lat, lon, ls);
        if (cp && (!best || cp.distM < best.distM)){
          best = { segmentId: segId, snapLat: cp.lat, snapLon: cp.lon, distM: cp.distM };
        }
      }
    }

    idx++;
  });

  if (!best) return null;
  if (best.distM > ROAD_SNAP_MAX_M) return null;
  return best;
}

// =========================
// Roads rendering (color lines by report)
// =========================
function baseRoadStyle(){
  return {
    color: "#333",
    weight: 4,
    opacity: 0.35
  };
}

function styleForCondition(conditionKey){
  const c = condByKey.get(conditionKey) || condByKey.get("seasonalGood");
  const isStriped = c.style === "striped";

  return {
    color: c.color,
    weight: 7,
    opacity: 0.9,
    dashArray: isStriped ? "8 8" : null
  };
}

function applyRoadStyles(segmentState){
  if (!roadsLayer) return;

  let idx = 0;
  roadsLayer.eachLayer((layer) => {
    const segId = featureToSegmentId(layer.feature, idx);
    const st = segmentState.get(segId);

    if (!st){
      layer.setStyle(baseRoadStyle());
      layer.unbindPopup();
    } else {
      layer.setStyle(styleForCondition(st.condition));

      const label = (condByKey.get(st.condition)?.label) || st.condition;
      layer.bindPopup(`
        <div class="popup-title">${label}</div>
        <div class="popup-meta">
          Severity: ${st.severity}<br/>
          Reports (24h): ${st.count}<br/>
          Latest: ${new Date(st.latestAt).toLocaleString()}
        </div>
      `);
    }
    idx++;
  });
}

async function loadRoads(){
  try {
    statusText.textContent = "Loading road segments…";
    const res = await fetch(ROADS_GEOJSON_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`Roads fetch failed: ${res.status}`);
    const geo = await res.json();

    roadsLayer = L.geoJSON(geo, {
      style: baseRoadStyle(),
      onEachFeature: (feature, layer) => {
        const segId = featureToSegmentId(feature, roadLayerById.size);
        roadLayerById.set(segId, layer);
      }
    }).addTo(map);

    roadsLoaded = true;
    statusText.textContent = "Roads loaded.";
  } catch (e){
    console.warn(e);
    roadsLoaded = false;
    statusText.textContent = "Roads NOT loaded (snap disabled).";
    gpsHint.textContent = "Tip: run a local server (not file://) so GeoJSON can load.";
  }
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

        if (!best || acc < (best.pos.coords.accuracy ?? Infinity)) {
          best = { pos, t: Date.now() };
        }

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
      ? "Tip: for better accuracy, step outside (open sky) and disable battery saver."
      : "";
  } catch (e) {
    console.warn(e);
    statusText.textContent = "Location blocked/denied. Enable location and refresh.";
    gpsHint.textContent = "";
    alert("Location blocked/denied. Please enable location permission for this site.");
  }
}

btnCurrent.addEventListener("click", centerOnBestLocation);

// Ask location on load
window.addEventListener("load", () => {
  centerOnBestLocation();
});

// =========================
// Modal + submit
// =========================
function openModal(){
  modalBackdrop.style.display = "flex";
  gpsText.textContent = "GPS: checking…";
  btnSubmit.disabled = true;

  getBestPosition({ maxWaitMs: 9000, desiredAccuracyM: 25 })
    .then((pos) => {
      const { accuracy, latitude, longitude } = pos.coords;

      gpsText.textContent = `GPS accuracy: ±${accuracy.toFixed(0)} m`;

      // tighter gating helps block indoor reports
      if (accuracy > REQUIRED_ACCURACY_M) {
        btnSubmit.disabled = true;
        gpsText.textContent += ` (too low — need ≤ ${REQUIRED_ACCURACY_M}m; step outside)`;
        return;
      }

      // If roads loaded, also pre-check snap feasibility
      if (roadsLoaded) {
        const snap = snapToRoad(latitude, longitude);
        if (!snap) {
          btnSubmit.disabled = true;
          gpsText.textContent += ` (not within ${ROAD_SNAP_MAX_M}m of a road)`;
          return;
        }
        gpsText.textContent += ` (snaps to road: ${snap.segmentId}, d=${snap.distM.toFixed(1)}m)`;
      }

      btnSubmit.disabled = false;
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
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal();
});

async function submitReport(){
  btnSubmit.disabled = true;
  btnSubmit.textContent = "Submitting…";

  try {
    const pos = await getBestPosition({ maxWaitMs: 9000, desiredAccuracyM: 25 });
    const { latitude, longitude, accuracy } = pos.coords;

    if (accuracy > REQUIRED_ACCURACY_M) {
      throw new Error(`GPS too inaccurate (±${accuracy.toFixed(0)}m). Need ≤ ${REQUIRED_ACCURACY_M}m. Step outside.`);
    }

    const c = condByKey.get(conditionSelect.value);
    if (!c) throw new Error("Invalid condition.");

    let snap = null;
    if (roadsLoaded) {
      snap = snapToRoad(latitude, longitude);
      if (!snap) {
        throw new Error(`Not within ${ROAD_SNAP_MAX_M}m of a road segment (snap blocked).`);
      }
    }

    await addDoc(collection(db, "reports"), {
      condition: c.key,
      severity: c.severity,

      // raw gps
      lat: latitude,
      lon: longitude,
      accuracyM: accuracy,

      // snapped-to-road (preferred for rendering)
      segmentId: snap ? snap.segmentId : null,
      snapLat: snap ? snap.snapLat : null,
      snapLon: snap ? snap.snapLon : null,
      snapDistM: snap ? snap.distM : null,

      createdAt: serverTimestamp()
    });

    closeModal();
    map.setView([latitude, longitude], Math.max(map.getZoom(), 14));
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
// Firestore stream (last 24 hours)
// Render as colored ROAD LINES
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
      const createdAt = data.createdAt?.toDate ? data.createdAt.toDate() : null;

      out.push({
        id: d.id,
        condition: data.condition,
        severity: Number(data.severity ?? 0),
        createdAt,
        segmentId: data.segmentId ?? null,
      });
    }

    // Filter TTL
    const now = Date.now();
    lastReports = out.filter(r => {
      if (!r.createdAt) return true;
      return (now - r.createdAt.getTime()) <= TTL_HOURS*3600*1000;
    });

    // Aggregate by segmentId (latest + worst-ish)
    const segmentState = new Map(); // segId -> {condition,severity,count,latestAt}
    for (const r of lastReports) {
      if (!r.segmentId) continue;

      const prev = segmentState.get(r.segmentId);
      const t = r.createdAt ? r.createdAt.getTime() : 0;

      if (!prev) {
        segmentState.set(r.segmentId, {
          condition: r.condition,
          severity: r.severity,
          count: 1,
          latestAt: t
        });
      } else {
        prev.count += 1;

        // keep latest report for display
        if (t >= prev.latestAt) {
          prev.latestAt = t;
          prev.condition = r.condition;
          prev.severity = r.severity;
        } else {
          // optionally bump severity if a worse condition exists
          prev.severity = Math.max(prev.severity, r.severity);
        }
      }
    }

    applyRoadStyles(segmentState);
    statusText.textContent = `Showing road conditions for ${segmentState.size} segments (last 24h).`;
  }, (err) => {
    console.error("Firestore error:", err);
    statusText.textContent = `Firestore error: ${err.message || err}`;
  });
}

// =========================
// Boot
// =========================
buildLegendAndSelect();
await loadRoads();
startFirestore();
statusText.textContent = "Ready.";
