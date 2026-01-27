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

const markersLayer = L.layerGroup().addTo(map);
let lastReports = [];

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

// deterministic jitter
function jitterLatLng(lat, lon, seed){
  const z = map.getZoom();
  const meters = Math.max(8, Math.min(22, 26 - (z * 1.2)));

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
    const [jLat, jLon] = jitterLatLng(r.lat, r.lon, r.id);

    const m = L.marker([jLat, jLon], {
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
        Accuracy: ${Number(r.accuracyM ?? 0).toFixed(1)} m
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

    let best = null; // {pos, t}
    const t0 = Date.now();

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const acc = pos.coords.accuracy ?? Infinity;

        // keep best
        if (!best || acc < (best.pos.coords.accuracy ?? Infinity)) {
          best = { pos, t: Date.now() };
        }

        // resolve early if good enough
        if (acc <= desiredAccuracyM) {
          navigator.geolocation.clearWatch(watchId);
          resolve(best.pos);
        }

        // timeout
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
function openModal(){
  modalBackdrop.style.display = "flex";
  gpsText.textContent = "GPS: checking…";
  btnSubmit.disabled = true;

  getBestPosition({ maxWaitMs: 9000, desiredAccuracyM: 25 })
    .then((pos) => {
      const { accuracy } = pos.coords;
      gpsText.textContent = `GPS accuracy: ±${accuracy.toFixed(0)} m`;
      // Optional: block submit if too inaccurate
      btnSubmit.disabled = accuracy > 100;
      if (accuracy > 100) {
        gpsText.textContent += " (too low — move to open sky and try again)";
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
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal();
});

async function submitReport(){
  btnSubmit.disabled = true;
  btnSubmit.textContent = "Submitting…";

  try {
    const pos = await getBestPosition({ maxWaitMs: 9000, desiredAccuracyM: 25 });
    const { latitude, longitude, accuracy } = pos.coords;

    const c = condByKey.get(conditionSelect.value);
    if (!c) throw new Error("Invalid condition.");

    await addDoc(collection(db, "reports"), {
      condition: c.key,
      severity: c.severity,
      lat: latitude,
      lon: longitude,
      accuracyM: accuracy,
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
// Boot
// =========================
buildLegendAndSelect();
startFirestore();
statusText.textContent = "Ready.";
