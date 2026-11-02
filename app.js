// Brown Shuttle: trip planner on Brown's Passio GO feed (system 1067).
// Static network and named buildings: data/. Map: basemap.svg (OpenStreetMap).
// Live: vehicle positions and per-stop ETAs, polled straight from Passio (CORS is open).

const NETWORK_URL = 'data/network.json';
const BUILDINGS_URL = 'data/buildings.json';
const MAX_RESULTS = 40;
const REACH_STEP = 4;                                // reach grid cell, in map px (about 20 m)
const REACH_BANDS = [[5, 0.46], [10, 0.32], [15, 0.2], [20, 0.1]];  // minutes, fill opacity
const RUN_SPEEDUP = 1.8;                             // running covers ground this much faster than walking
const AT_STOP_MIN = 0.75;                            // this close (in walking minutes) counts as at the stop
const OFF_CAMPUS_M = 2500;
const PASSIO = 'https://passiogo.com/mapGetData.php';
const SYSTEM_ID = '1067';
const POLL_MS = 15000;
const MAX_ETA_MIN = 90;                             // Passio ETAs past this are dropped as unreliable

const LNG_PX = 17003.9, LAT_PX = 22782.1;          // same projection as the network builder
const RIDE_M_PER_MIN = 300, DWELL_MIN = 0.35;       // fallback ride model when Passio has no ETA pair
const WALK_M_PER_MIN = 80, WALK_DETOUR = 1.25, MAX_WALK_MIN = 15;
const CATCH_SLACK_MIN = 0.5;                        // a bus this close to your arrival is still catchable
const BASEMAP = { src: 'basemap.svg', frame: [-160, -40, 720, 800] };  // map px covered by basemap.svg
// Brown dining locations, placed on their OpenStreetMap buildings.
const DINING = [
  { name: 'Sharpe Refectory', alias: 'The Ratty', address: '144 Thayer St, upper level', lat: 41.825056, lng: -71.400885 },
  { name: 'Ivy Room', alias: '', address: '144 Thayer St, lower level', lat: 41.825056, lng: -71.400885 },
  { name: 'Verney-Woolley', alias: 'V-Dub', address: '135 Cushing St', lat: 41.829589, lng: -71.401575 },
  { name: 'Andrews Commons', alias: '', address: '211 Bowen St', lat: 41.830407, lng: -71.402529 },
  { name: 'Blue Room', alias: '', address: '75 Waterman St', lat: 41.826838, lng: -71.402957 },
  { name: "Josiah's", alias: "Jo's", address: '114 Power St', lat: 41.823358, lng: -71.399777 },
  { name: 'Engineering Café', alias: '', address: '184 Hope St', lat: 41.82647, lng: -71.397844 },
];
const DEMO = { id: 'demo', name: 'Main Green', lat: 41.8265, lng: -71.403, ids: [], lines: 'Your location (demo)' };

let NET, PLACES, PLACE_BY_ID, STOP_PLACE, ALL_STOP_IDS;
const HERE = { id: 'here', name: 'Your location', ids: [], lines: '', lat: 0, lng: 0, x: 0, y: 0 };
const state = { screen: 'home', fromId: 'demo', destId: null, query: '', fromQuery: '', live: null, liveError: false,
  geo: 'off', geoAcc: null, wantHere: false, reach: false, go: null };

// ---------- geometry ----------
function proj(lat, lng) { return { x: 205 + (lng + 71.403) * LNG_PX, y: 300 - (lat - 41.8245) * LAT_PX }; }
function metres(a, b) { return Math.hypot((a.lat - b.lat) * 111132, (a.lng - b.lng) * 82946); }
function walkMin(a, b) { return metres(a, b) * WALK_DETOUR / WALK_M_PER_MIN; }
function cleanName(n) { return n.replace(/\s*\(to [^)]*\)/, '').replace(/\s+(CW|CCW)$/, '').trim(); }
function mins(v) { return Math.max(1, Math.round(v)); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function clock(d) { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

function stopPt(id) {
  const s = NET.stops[id];
  return { id, name: cleanName(s.name), place: STOP_PLACE[id], lat: s.lat, lng: s.lng, x: s.x, y: s.y };
}

function buildPlaces(buildings) {
  const by = {};
  for (const [id, s] of Object.entries(NET.stops)) {
    const nm = cleanName(s.name);
    (by[nm] = by[nm] || { name: nm, ids: [] }).ids.push(id);
  }
  PLACES = Object.keys(by).sort().map((nm, i) => {
    const p = by[nm];
    p.lat = p.ids.reduce((t, id) => t + NET.stops[id].lat, 0) / p.ids.length;
    p.lng = p.ids.reduce((t, id) => t + NET.stops[id].lng, 0) / p.ids.length;
    Object.assign(p, proj(p.lat, p.lng), { id: 'p' + i });
    p.lines = NET.routes.filter((r) => r.stops.some((s) => p.ids.includes(s.stop))).map((r) => r.short).join(' · ');
    return p;
  });
  DINING.forEach((d, i) => {
    PLACES.push(Object.assign({ id: 'd' + i, ids: [], dining: true, lines: (d.alias ? d.alias + ' · ' : '') + d.address }, d, proj(d.lat, d.lng)));
  });
  const taken = new Set(PLACES.map((p) => p.name.toLowerCase()));
  buildings.forEach((b, i) => {
    if (taken.has(b.name.toLowerCase())) return;
    PLACES.push(Object.assign({ id: 'b' + i, ids: [], building: true, alias: b.alt,
      lines: b.address || (b.alt ? 'Also ' + b.alt : 'Building') }, b, proj(b.lat, b.lng)));
  });
  Object.assign(DEMO, proj(DEMO.lat, DEMO.lng));
  PLACE_BY_ID = { demo: DEMO, here: HERE };
  STOP_PLACE = {};
  PLACES.forEach((p) => { PLACE_BY_ID[p.id] = p; p.ids.forEach((id) => { STOP_PLACE[id] = p; }); });
  ALL_STOP_IDS = Object.keys(NET.stops);
}

// ---------- live feed ----------
async function fetchLive() {
  const body = new URLSearchParams({ json: JSON.stringify({ s0: SYSTEM_ID, sA: 1 }) });
  const [busRes, etaRes] = await Promise.all([
    fetch(PASSIO + '?getBuses=2', { method: 'POST', body }),
    fetch(PASSIO + '?eta=3&deviceId=0&userId=' + SYSTEM_ID + '&stopIds=' + ALL_STOP_IDS.join(',')),
  ]);
  const busJson = await busRes.json();
  const etaJson = await etaRes.json();
  const at = Date.now();

  const buses = [];
  for (const list of Object.values(busJson.buses || {})) {
    for (const b of list) {
      if (b.outOfService) continue;
      buses.push({ id: String(b.deviceId), name: b.busName, routeId: String(b.routeId), lat: +b.latitude, lng: +b.longitude, course: +b.calculatedCourse || 0 });
    }
  }
  const etas = {};
  for (const [stopId, list] of Object.entries(etaJson.ETAs || {})) {
    etas[stopId] = list
      .filter((e) => e.busName && e.secondsSpent != null && e.secondsSpent <= MAX_ETA_MIN * 60 && !e.OOS && !e.outdated)
      .map((e) => ({ routeId: String(e.routeId), busId: String(e.deviceId), bus: e.busName, sec: +e.secondsSpent }))
      .sort((a, b) => a.sec - b.sec);
  }
  return { at, buses, etas };
}

async function poll() {
  try {
    state.live = await fetchLive();
    state.liveError = false;
  } catch (err) {
    state.liveError = true;
  }
  render();
}

// minutes from now until each bus on `routeId` reaches `stopId`, aged since the fetch
function arrivals(stopId, routeId) {
  if (!state.live) return [];
  const aged = (Date.now() - state.live.at) / 60000;
  return (state.live.etas[stopId] || [])
    .filter((e) => e.routeId === routeId)
    .map((e) => ({ busId: e.busId, bus: e.bus, min: Math.max(0, e.sec / 60 - aged) }));
}
function liveRoutes() {
  if (!state.live) return [];
  const ids = new Set(state.live.buses.map((b) => b.routeId));
  return NET.routes.filter((r) => ids.has(r.id));
}

// ---------- planning ----------
// Every ride you could take from O right now: walk to a stop, catch the first bus you can make, get off anywhere.
function rides(O) {
  const out = [];
  for (const r of liveRoutes()) {
    const n = r.stops.length;
    for (let i = 0; i < n; i++) {
      const a = stopPt(r.stops[i].stop);
      const w1 = walkMin(O, a);
      if (w1 > MAX_WALK_MIN) continue;
      const atA = arrivals(a.id, r.id);
      const catchIdx = atA.findIndex((e) => e.min >= w1 - CATCH_SLACK_MIN);
      if (catchIdx < 0) continue;
      const bus = atA[catchIdx];
      for (let k = 1; k < n; k++) {
        const j = (i + k) % n;
        const b = stopPt(r.stops[j].stop);
        if (b.place === a.place) continue;
        const sameBusAtB = arrivals(b.id, r.id).find((e) => e.busId === bus.busId && e.min > bus.min);
        let ride;
        if (sameBusAtB) ride = sameBusAtB.min - bus.min;
        else {
          const rideM = ((r.stops[j].at_m - r.stops[i].at_m) % r.length_m + r.length_m) % r.length_m;
          ride = rideM / RIDE_M_PER_MIN + DWELL_MIN * (k - 1) + 0.3;
        }
        const board = Math.max(bus.min, w1);
        out.push({ r, a, b, w1, ride, bus, board, arrive: board + ride, wait: board - w1, k,
          following: atA[catchIdx + 1], toward: stopPt(r.stops[(i + 1) % n].stop) });
      }
    }
  }
  return out;
}

function plan(O, D) {
  let best = null;
  for (const x of rides(O)) {
    const w2 = walkMin(x.b, D);
    const total = x.arrive + w2;
    if (!best || total < best.total) best = Object.assign({}, x, { w2, total });
  }
  return { walk: walkMin(O, D), best };
}

// ---------- reach ----------
// Minutes to every point on the map: walking, or the best live ride then walking.
let reachCache = { key: '', url: '' };
function reachImage(O) {
  const key = [O.lat, O.lng, state.live ? state.live.at : 0, Math.floor(Date.now() / 30000)].join('|');
  if (reachCache.key === key) return reachCache.url;
  const byStop = {};
  for (const x of rides(O)) {
    if (!byStop[x.b.id] || x.arrive < byStop[x.b.id].t) byStop[x.b.id] = { t: x.arrive, p: x.b };
  }
  const exits = Object.values(byStop);
  const [fx, fy, fw, fh] = BASEMAP.frame;
  const cw = Math.round(fw / REACH_STEP), ch = Math.round(fh / REACH_STEP);
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cw, ch);
  for (let row = 0; row < ch; row++) {
    const lat = 41.8245 - (fy + (row + 0.5) * REACH_STEP - 300) / LAT_PX;
    for (let col = 0; col < cw; col++) {
      const pt = { lat, lng: (fx + (col + 0.5) * REACH_STEP - 205) / LNG_PX - 71.403 };
      let t = walkMin(O, pt);
      for (const e of exits) if (e.t < t) t = Math.min(t, e.t + walkMin(e.p, pt));
      const band = REACH_BANDS.find(([m]) => t <= m);
      if (!band) continue;
      const o = (row * cw + col) * 4;
      img.data[o] = 168; img.data[o + 1] = 67; img.data[o + 2] = 42; img.data[o + 3] = Math.round(band[1] * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  reachCache = { key, url: canvas.toDataURL() };
  return reachCache.url;
}

// ---------- go ----------
// Where you are on a started trip and what to do about it.
function goStatus(from) {
  const g = state.go;
  const r = NET.routes.find((x) => x.id === g.routeId);
  const a = stopPt(g.aId), b = stopPt(g.bId);
  const live = state.fromId === 'here' && state.geo === 'on';
  const wRem = live ? walkMin(HERE, a) : Math.max(0, g.w1 - (Date.now() - g.t0) / 60000);
  const atA = arrivals(a.id, r.id);
  const bus = atA.find((e) => e.busId === g.busId);
  const atStop = wRem <= AT_STOP_MIN;

  if (!g.onBoard && atStop && (!bus || bus.min <= 0.3)) { g.onBoard = true; g.boardedAt = Date.now(); }
  if (g.onBoard) {
    // Passio lists only a bus's next pass at a stop; fall back to the planned ride time when it has none
    const off = arrivals(b.id, r.id).find((e) => e.busId === g.busId);
    const modelLeft = g.rideMin - (Date.now() - g.boardedAt) / 60000;
    const left = off && off.min > 0.3 ? off.min : modelLeft;
    if (left > 0.3) return { r, a, b, live, mode: 'ride', head: `Get off at ${b.name}`, detail: `in about ${mins(left)} min`, bus: g.busName };
    return { r, a, b, live, mode: 'done', head: `Get off here`, detail: `then walk ${mins(walkMin(b, PLACE_BY_ID[state.destId]))} min`, bus: g.busName };
  }
  if (!bus || bus.min < wRem / RUN_SPEEDUP) {
    const next = atA.find((e) => e.busId !== g.busId && e.min >= wRem - CATCH_SLACK_MIN);
    if (next) { g.busId = next.busId; g.busName = next.bus; }
    return { r, a, b, live, mode: 'letgo', head: 'Let it go', detail: next ? `Bus ${next.bus} comes in ${mins(next.min)} min. No rush.` : 'No later bus is listed yet.', bus: g.busName };
  }
  if (atStop) return { r, a, b, live, mode: 'relax', head: "You're at the stop", detail: `Bus ${g.busName} in ${etaText(bus.min)}`, bus: g.busName };
  const margin = bus.min - wRem;
  if (margin >= 3) return { r, a, b, live, mode: 'relax', head: 'Relax', detail: `Walk easy. You'll have about ${mins(margin)} min to spare.`, bus: g.busName };
  if (margin >= AT_STOP_MIN) return { r, a, b, live, mode: 'walk', head: 'Walk steadily', detail: `About ${mins(margin)} min to spare.`, bus: g.busName };
  return { r, a, b, live, mode: 'run', head: 'Run', detail: `Bus ${g.busName} reaches ${a.name} in ${etaText(bus.min)}.`, bus: g.busName };
}

// ---------- map ----------
function fit(pts, R) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
  const bw = Math.max(x2 - x1, 70), bh = Math.max(y2 - y1, 70);
  const s = Math.min((R[2] - R[0]) / bw, (R[3] - R[1]) / bh, 2.6);
  const vbx = (x1 + x2) / 2 - (R[0] + R[2]) / 2 / s;
  const vby = (y1 + y2) / 2 - (R[1] + R[3]) / 2 / s;
  return { s, vbx, vby };
}
function scr(p, f) { return { x: (p.x - f.vbx) * f.s, y: (p.y - f.vby) * f.s }; }

function renderMap(view) {
  const el = document.getElementById('map');
  const W = el.clientWidth, H = el.clientHeight;
  const f = view.fit(W, H);
  const k = 1 / f.s;
  const liveIds = new Set(liveRoutes().map((r) => r.id));
  const op = (r) => view.trip ? (view.trip.r === r ? 1 : 0.14) : (liveIds.has(r.id) || !state.live ? 1 : 0.2);

  let svg = `<svg viewBox="${f.vbx} ${f.vby} ${W * k} ${H * k}" aria-hidden="true">`;
  const order = view.trip ? NET.routes.filter((r) => r !== view.trip.r).concat([view.trip.r]) : NET.routes;
  for (const r of order) {
    svg += `<path d="${r.d}" fill="none" stroke="${r.color}" stroke-width="${4.2 * k}" stroke-linejoin="round" stroke-linecap="round" opacity="${op(r)}"/>`;
  }
  for (const s of Object.values(NET.stops)) {
    svg += `<circle cx="${s.x}" cy="${s.y}" r="${3.2 * k}" fill="#FBFAF7" stroke="#6B655C" stroke-width="${1.5 * k}"/>`;
  }
  for (const [p, q] of view.walks || []) {
    svg += `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="#1A1815" stroke-opacity="0.75" stroke-width="${2.4 * k}" stroke-dasharray="${0.1 * k} ${6 * k}" stroke-linecap="round"/>`;
  }
  svg += '</svg>';

  const [fx, fy, fw, fh] = BASEMAP.frame;
  const frameStyle = `left:${(fx - f.vbx) * f.s}px; top:${(fy - f.vby) * f.s}px; width:${fw * f.s}px; height:${fh * f.s}px`;
  let html = `<img class="basemap" src="${BASEMAP.src}" alt="" style="${frameStyle}">`;
  if (view.reach) html += `<img class="basemap reach" src="${reachImage(view.from)}" alt="" style="${frameStyle}">`;
  html += svg;
  const seen = new Set();
  for (const d of PLACES.filter((p) => p.dining)) {
    const key = d.lat + ',' + d.lng;
    if (seen.has(key)) continue;
    seen.add(key);
    const names = PLACES.filter((p) => p.dining && p.lat + ',' + p.lng === key).map((p) => p.alias || p.name).join(' · ');
    const q = scr(d, f);
    const isDest = view.dest && view.dest.dining && view.dest.lat + ',' + view.dest.lng === key;
    if (isDest) continue;
    html += `<div class="marker" style="left:${q.x}px; top:${q.y}px; opacity:${view.trip ? 0.55 : 1}" title="${esc(names)}">
      <div class="dine-pin">${ICON.fork}</div>${f.s >= 1.15 || !view.trip ? `<div class="dine-label">${esc(names)}</div>` : ''}</div>`;
  }
  for (const b of state.live ? state.live.buses : []) {
    const r = NET.routes.find((x) => x.id === b.routeId);
    if (!r) continue;
    const p = scr(proj(b.lat, b.lng), f);
    const dim = view.trip && view.trip.r !== r ? 0.25 : 1;
    html += `<div class="marker bus" style="transform: translate(${p.x}px, ${p.y}px); opacity: ${dim}" title="Bus ${esc(b.name)}">
      <div style="position:absolute; left:-11px; top:-11px; width:22px; height:22px; border-radius:50%; background:${r.color}; border:2.5px solid #FBFAF7; box-shadow:0 1px 5px rgba(0,0,0,.28); transform: rotate(${b.course}deg)">
        <div style="position:absolute; left:50%; top:-7px; margin-left:-4px; width:0; height:0; border-left:4px solid transparent; border-right:4px solid transparent; border-bottom:6px solid ${r.color}"></div>
      </div></div>`;
  }
  const you = scr(view.from, f);
  html += `<div class="marker" style="left:${you.x}px; top:${you.y}px">
    <div style="position:absolute; left:-16px; top:-16px; width:32px; height:32px; border-radius:50%; background:rgba(26,24,21,.12)"></div>
    <div style="position:absolute; left:-8px; top:-8px; width:16px; height:16px; border-radius:50%; background:#1A1815; border:3px solid #FBFAF7; box-shadow:0 1px 4px rgba(0,0,0,.25)"></div></div>`;
  for (const [p, label, color] of view.tags || []) {
    const q = scr(p, f), flip = q.x > W - 120;
    html += `<div class="marker" style="left:${q.x}px; top:${q.y}px">
      <div style="position:absolute; left:-7px; top:-7px; width:14px; height:14px; border-radius:50%; background:#FBFAF7; border:3px solid ${color}"></div>
      <div class="tag" style="left:${flip ? -12 : 12}px; transform:${flip ? 'translateX(-100%)' : 'none'}">${label}</div></div>`;
  }
  if (view.dest) {
    const d = scr(view.dest, f);
    html += `<div class="marker" style="left:${d.x}px; top:${d.y}px">
      <div style="position:absolute; left:-13px; top:-34px; width:26px; height:26px; border-radius:13px 13px 13px 3px; transform:rotate(-45deg); background:var(--accent); box-shadow:0 2px 6px rgba(60,20,10,.3)"></div>
      <div style="position:absolute; left:-4px; top:-25px; width:8px; height:8px; border-radius:50%; background:#FBFAF7"></div></div>`;
  }
  el.innerHTML = html;
}

// ---------- panels ----------
const ICON = {
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1A1815" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  search: (c) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" style="flex-shrink:0"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`,
  pin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#3D3832" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2"/></svg>',
  swap: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3D3832" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M7 4L3.5 7.5M7 4l3.5 3.5M17 20V4M17 20l-3.5-3.5M17 20l3.5-3.5"/></svg>',
  building: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#3D3832" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V8l8-5 8 5v13"/><path d="M9 21v-6h6v6"/><path d="M3 21h18"/></svg>',
  reach: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" opacity=".6"/><circle cx="12" cy="12" r="10.5" opacity=".3"/></svg>',
  locate: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FBFAF7" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  fork: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FBFAF7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3v8M4.5 3v5a2.5 2.5 0 0 0 5 0V3M7 11v10M17 21V3c-2.2 1.2-3.5 3.6-3.5 7v3H17"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1A1815" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Selected"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  mark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FBFAF7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 10h14"/><path d="M8 20l1.5-3M16 20l-1.5-3"/></svg>',
};

function liveChip() {
  if (state.liveError) return `<div class="chip"><span class="pulse off"></span>Offline</div>`;
  if (!state.live) return `<div class="chip"><span class="pulse off"></span>Connecting</div>`;
  return `<div class="chip num" aria-label="Live, updated ${clock(new Date(state.live.at))}"><span class="pulse"></span>${clock(new Date(state.live.at))}</div>`;
}
function etaText(m) { return m < 1 ? 'now' : mins(m) + ' min'; }

function homeView(from) {
  const live = liveRoutes();
  const rows = live.map((r) => {
    let near = null;
    for (const s of r.stops) {
      const pt = stopPt(s.stop), w = walkMin(from, pt);
      if (!near || w < near.w) near = { pt, w };
    }
    const next = arrivals(near.pt.id, r.id).find((e) => e.min >= near.w - CATCH_SLACK_MIN);
    return `<div class="route-row">
      <div class="route-bar" style="background:${r.color}"></div>
      <div class="grow"><div class="value">${esc(r.name)}</div><div class="sub">${esc(near.pt.name)} · ${mins(near.w)} min walk</div></div>
      <div class="right"><div class="num big-num">${next ? etaText(next.min) : '–'}</div><div class="label-sm">${next ? 'next you can catch' : 'no ETA yet'}</div></div>
    </div>`;
  }).join('');
  const empty = state.live && !live.length ? `<div class="note"><div class="value">No shuttles on the road right now.</div>
    <div class="muted">Daytime routes run weekdays 7 AM to 7 PM. Evening loops run from 7 PM to 2 AM, 3 AM Thursday to Saturday. OnCall picks up from 5 PM.</div></div>` : '';
  const offline = state.liveError ? `<div class="note muted">Couldn't reach the tracker. Retrying.</div>` : '';

  return `
  <div class="top">
    <div class="brand-row">
      <div class="brand"><div class="mark">${ICON.mark}</div>Brown Shuttle</div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="chip reach-btn ${state.reach ? 'on' : ''}" data-reach aria-pressed="${state.reach}">${ICON.reach}Reach</button>
        ${liveChip()}
      </div>
    </div>
    <div class="card od">
      <button class="row" data-go="from">
        <div class="you-dot"></div>
        <div class="grow"><div class="label-sm">You're at</div><div class="value">${esc(from.name)}</div></div>
        <div class="sub">Change</div>
      </button>
      <div class="divider"></div>
      <button class="row" data-go="search">${ICON.search('#1A1815')}<div class="muted" style="font-size:15px">Where to?</div></button>
    </div>
    ${state.reach ? `<div class="legend card">
      <div class="legend-title">How far you get from here, walking plus the next bus</div>
      <div class="legend-row">${REACH_BANDS.map(([m, o]) => `<span class="legend-item"><span class="swatch" style="background:rgba(168,67,42,${o})"></span>${m} min</span>`).join('')}</div>
    </div>` : ''}
  </div>
  <div class="sheet" id="sheet" style="max-height:44%">
    <div class="handle"></div>
    <div class="sheet-head"><div class="sheet-title">Running now</div><div class="sub">${live.length ? 'Nearest stop to you' : ''}</div></div>
    ${rows}${empty}${offline}
    <div class="credit">Brown Shuttle redesign prototype. Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>.</div>
  </div>`;
}

// Empty query: dining and stops only (buildings would bury them). Typed query: everything.
function search(query, exclude, emptyFilter) {
  const q = query.trim().toLowerCase();
  const hay = (p) => (p.name + ' ' + (p.alias || '') + ' ' + (p.address || '')).toLowerCase();
  const rank = (p) => p.dining ? 0 : p.building ? 2 : 1;
  return PLACES.filter((p) => p !== exclude && (q ? hay(p).includes(q) : emptyFilter(p)))
    .map((p) => ({ p, starts: p.name.toLowerCase().startsWith(q) || (p.alias || '').toLowerCase().startsWith(q) }))
    .sort((a, b) => q ? (b.starts - a.starts) || (rank(a.p) - rank(b.p)) || a.p.name.localeCompare(b.p.name) : 0)
    .slice(0, q ? MAX_RESULTS : Infinity)
    .map((r) => r.p);
}
function tileFor(p) {
  return p.dining ? `<div class="tile dine">${ICON.fork}</div>` : `<div class="tile">${p.building ? ICON.building : ICON.pin}</div>`;
}

function resultsHtml(from) {
  const q = state.query.trim();
  const list = search(q, from, (p) => !p.building)
    .map((p) => ({ p, d: walkMin(from, p) }))
    .sort((a, b) => q ? 0 : (b.p.dining - a.p.dining) || b.d - a.d);
  if (!list.length) return `<div style="padding:20px; font-size:15px; line-height:1.5" class="muted">Nothing matches that. Try a building, a dining hall, or a street address.</div>`;
  return `<div class="list-title">${q ? 'Matches' : 'Dining, then stops by distance'}</div>` + list.map(({ p, d }) => `
    <button class="item" data-dest="${p.id}">
      ${tileFor(p)}
      <div class="grow"><div class="value">${esc(p.name)}</div><div class="sub">${esc(p.lines)}</div></div>
      <div class="num sub">${mins(d)} min walk</div>
    </button>`).join('');
}

function searchView(from) {
  return `<div class="full">
    <div class="full-head">
      <div class="head-row">
        <button class="icon-btn" data-go="home" aria-label="Back">${ICON.back}</button>
        <div class="search">${ICON.search('#6B655C')}
          <label for="dest" class="sr">Destination</label>
          <input id="dest" type="search" autocomplete="off" placeholder="Building, dining hall, or stop" value="${esc(state.query)}">
        </div>
      </div>
      <div class="sub" style="padding-left:52px">From ${esc(from.name)}</div>
    </div>
    <div class="list" id="results">${resultsHtml(from)}</div>
  </div>`;
}

function hereStatus() {
  if (state.geo === 'on') return metres(HERE, DEMO) > OFF_CAMPUS_M ? 'Off campus right now' : `Within about ${Math.round(state.geoAcc)} m`;
  if (state.geo === 'asking') return 'Finding you…';
  if (state.geo === 'denied') return 'Location is off for this site';
  if (state.geo === 'unavailable') return "Couldn't get a fix. Try again";
  return "Use this device's location";
}

function fromListHtml(from) {
  const q = state.fromQuery.trim();
  const pinned = q ? '' : `
    <button class="item" data-from="here">
      <div class="tile dark">${ICON.locate}</div>
      <div class="grow"><div class="value">Your location</div><div class="sub">${hereStatus()}</div></div>
      ${from === HERE ? ICON.check : ''}
    </button>
    <button class="item" data-from="demo">
      <div class="tile"><div class="dot" style="background:#1A1815"></div></div>
      <div class="grow"><div class="value">Main Green</div><div class="sub">Demo starting point</div></div>
      ${from === DEMO ? ICON.check : ''}
    </button>
    <div class="list-title">Shuttle stops</div>`;
  const list = search(q, null, (p) => !p.dining && !p.building);
  return pinned + (q && !list.length ? `<div style="padding:20px" class="muted">Nothing matches that.</div>` : '') + list.map((p) => `
    <button class="item" data-from="${p.id}">
      ${tileFor(p)}
      <div class="grow"><div class="value">${esc(p.name)}</div><div class="sub">${esc(p.lines)}</div></div>
      ${p === from ? ICON.check : ''}
    </button>`).join('');
}

function fromView(from) {
  return `<div class="full">
    <div class="full-head">
      <div class="head-row">
        <button class="icon-btn" data-go="home" aria-label="Back">${ICON.back}</button>
        <div class="search">${ICON.search('#6B655C')}
          <label for="origin" class="sr">Where are you?</label>
          <input id="origin" type="search" autocomplete="off" placeholder="Where are you?" value="${esc(state.fromQuery)}">
        </div>
      </div>
    </div>
    <div class="list" id="fromResults">${fromListHtml(from)}</div>
  </div>`;
}

function tripView(from, dest, p) {
  const b = p.best;
  const useShuttle = b && b.total < p.walk - 1;
  const head = `<div class="card trip-head">
    <button class="icon-btn" data-go="search" aria-label="Back to search">${ICON.back}</button>
    <div class="grow"><div class="label-sm" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">From ${esc(from.name)}</div><div class="value" style="font-weight:600">${esc(dest.name)}</div></div>
    <button class="icon-btn" data-swap aria-label="Swap start and destination">${ICON.swap}</button>
  </div>`;
  const arrive = (m) => clock(new Date(Date.now() + m * 60000));

  if (state.go) {
    const st = goStatus(from);
    const c = st.r.color;
    return head + `<div class="sheet" style="height:min(330px, 44%)">
      <div class="handle"></div>
      <div class="status ${st.mode}">
        <div class="status-head">${esc(st.head)}</div>
        <div class="status-detail">${esc(st.detail)}</div>
      </div>
      <div class="live-row" style="align-items:flex-start">
        <span class="dot" style="background:${c};margin-top:5px"></span>
        <div class="grow"><div style="font-weight:600">${esc(st.r.short)} · bus ${esc(st.bus)}</div><div class="sub" style="white-space:normal">${esc(st.a.name)} to ${esc(st.b.name)}</div></div>
      </div>
      <div class="sub" style="margin-top:12px;white-space:normal;line-height:1.45">${st.live ? 'Following your location.' : 'Timing assumes you set off when you pressed Go.'}</div>
      <button class="go-btn stop" data-stop>End trip</button>
    </div>`;
  }

  if (useShuttle) {
    const c = b.r.color;
    const then = b.following ? `, then ${etaText(b.following.min)}` : '';
    const slack = b.bus.min - b.w1;
    const leave = slack >= 1 ? `Leave in ${mins(slack)} min` : slack > -CATCH_SLACK_MIN ? 'Leave now' : 'Leave now, briskly';
    const by = slack >= 1 ? `by ${clock(new Date(Date.now() + slack * 60000))}` : `${mins(b.w1)} min walk to the stop`;
    return head + `<div class="sheet" style="height:min(400px, 50%)">
      <div class="handle"></div>
      <div class="total">
        <div><div style="display:flex;align-items:baseline;gap:6px"><div class="num n">${mins(b.total)}</div><div style="font-size:17px;font-weight:500">min</div></div>
        <div class="sub">Arrive around ${arrive(b.total)}</div></div>
        <div class="pill"><span class="dot" style="background:${c}"></span>${esc(b.r.short)}</div>
      </div>
      <div class="leave">
        <div><div class="leave-head">${leave}</div><div class="sub">${by}</div></div>
        <button class="go-btn" data-start>Go</button>
      </div>
      <div class="live-row"><div>Bus ${esc(b.bus.bus)} reaches ${esc(b.a.name)} in</div><div class="num" style="font-weight:600">${etaText(b.bus.min)}<span class="muted" style="font-weight:400">${then}</span></div></div>
      <div class="steps">
        <div class="step"><div class="rail"><div class="dot" style="background:#1A1815;margin-top:4px"></div><div class="walk"></div></div>
          <div class="step-body"><div class="step-title">Walk to ${esc(b.a.name)}</div><div class="step-sub num">${mins(b.w1)} min${b.wait >= 1 ? ` · about ${mins(b.wait)} min wait` : ''}</div></div></div>
        <div class="step"><div class="rail"><div class="ring" style="border-color:${c}"></div><div class="ride" style="background:${c}"></div></div>
          <div class="step-body"><div class="step-title">Ride the ${esc(b.r.short)} toward ${esc(b.toward.name)}</div><div class="step-sub num">${b.k === 1 ? 'Next stop' : b.k + ' stops'} · ${mins(b.ride)} min</div></div></div>
        <div class="step"><div class="rail"><div class="ring" style="border-color:${c}"></div><div class="walk"></div></div>
          <div class="step-body"><div class="step-title">Get off at ${esc(b.b.name)}</div><div class="step-sub num">then walk ${mins(b.w2)} min</div></div></div>
        <div class="step"><div class="rail"><div style="width:12px;height:12px;border-radius:4px;background:var(--accent);margin-top:3px"></div></div>
          <div class="step-title">${esc(dest.name)}</div></div>
      </div>
    </div>`;
  }

  const reason = b ? 'Walking gets you there sooner than the next shuttle would.'
    : !state.live ? (state.liveError ? "Couldn't reach the tracker, so this is the walk." : 'Checking the shuttles…')
    : liveRoutes().length ? 'No bus on the road right now gets you closer than walking.'
    : 'No shuttles are on the road right now. OnCall picks up from 5 PM.';
  return head + `<div class="sheet" style="height:min(300px, 40%)">
    <div class="handle"></div>
    <div class="total"><div><div style="display:flex;align-items:baseline;gap:6px"><div class="num n">${mins(p.walk)}</div><div style="font-size:17px;font-weight:500">min</div></div>
      <div class="sub">On foot · arrive around ${arrive(p.walk)}</div></div></div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:18px">
      <div style="font-size:15px;line-height:1.5">${reason}</div>
      ${b ? `<div class="alt"><span class="dot" style="background:${b.r.color}"></span><div style="flex:1">${esc(b.r.short)} from ${esc(b.a.name)}</div><div class="num muted">${mins(b.total)} min</div></div>` : ''}
    </div>
  </div>`;
}

// ---------- render ----------
function render() {
  if (!NET) return;
  const from = PLACE_BY_ID[state.fromId] || DEMO;
  const dest = state.destId ? PLACE_BY_ID[state.destId] : null;
  if (state.screen === 'trip' && !dest) state.screen = 'home';
  const panel = document.getElementById('panel');

  // keep typing undisturbed: on the search screen, live updates only touch the map
  if ((state.screen === 'search' && document.getElementById('dest')) || (state.screen === 'from' && document.getElementById('origin'))) {
    renderMap(homeMapView(from));
    return;
  }

  if (state.screen === 'trip') {
    const p = plan(from, dest);
    let b = p.best && p.best.total < p.walk - 1 ? p.best : null;
    if (state.go) {
      const g = state.go;
      b = { r: NET.routes.find((x) => x.id === g.routeId), a: stopPt(g.aId), b: stopPt(g.bId) };
    }
    const prevScroll = panel.querySelector('.sheet') ? panel.querySelector('.sheet').scrollTop : 0;
    panel.innerHTML = tripView(from, dest, p);
    panel.querySelector('.sheet').scrollTop = prevScroll;
    const sheetH = panel.querySelector('.sheet').offsetHeight;
    renderMap({
      from, dest, trip: b,
      walks: b ? [[from, b.a], [b.b, dest]] : [[from, dest]],
      tags: b ? [[b.a, 'Board', b.r.color], [b.b, 'Get off', b.r.color]] : [],
      fit: (W, H) => fit(b ? [from, dest, b.a, b.b] : [from, dest], [28, 110, W - 28, H - sheetH - 24]),
    });
  } else {
    panel.innerHTML = state.screen === 'search' ? searchView(from) : state.screen === 'from' ? fromView(from) : homeView(from);
    renderMap(homeMapView(from));
    if (state.screen === 'search') document.getElementById('dest').focus();
  }
}

function homeMapView(from) {
  const sheet = document.getElementById('sheet');
  const sheetH = sheet ? sheet.offsetHeight : 240;
  const top = document.querySelector('.top');
  const topH = top ? top.offsetHeight + 8 : 196;
  return { from, reach: state.reach && state.screen === 'home',
    fit: (W, H) => fit([{ x: 36, y: 153 }, { x: 308, y: 597 }, from], [20, topH, W - 20, H - sheetH - 10]) };
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if ('reach' in t.dataset) {
    state.reach = !state.reach;
  } else if ('start' in t.dataset) {
    const from = PLACE_BY_ID[state.fromId] || DEMO;
    const b = plan(from, PLACE_BY_ID[state.destId]).best;
    if (!b) return;
    state.go = { routeId: b.r.id, aId: b.a.id, bId: b.b.id, busId: b.bus.busId, busName: b.bus.bus, w1: b.w1, rideMin: b.ride, t0: Date.now(), onBoard: false };
  } else if ('stop' in t.dataset) {
    state.go = null;
  } else if (t.dataset.go) {
    state.screen = t.dataset.go;
    state.go = null;
    if (t.dataset.go === 'home') { state.destId = null; state.query = ''; }
  } else if (t.dataset.dest) {
    state.destId = t.dataset.dest; state.screen = 'trip'; state.query = '';
  } else if (t.dataset.from === 'here' && state.geo !== 'on') {
    state.wantHere = true;
    startGeo();
    document.getElementById('fromResults').innerHTML = fromListHtml(PLACE_BY_ID[state.fromId] || DEMO);
    return;
  } else if (t.dataset.from) {
    const id = t.dataset.from;
    state.fromQuery = '';
    if (state.destId === id) state.destId = null;
    state.fromId = id;
    state.screen = state.destId ? 'trip' : 'home';
  } else if ('swap' in t.dataset) {
    [state.fromId, state.destId] = [state.destId, state.fromId];
    state.go = null;
  } else return;
  render();
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'origin') {
    state.fromQuery = e.target.value;
    document.getElementById('fromResults').innerHTML = fromListHtml(PLACE_BY_ID[state.fromId] || DEMO);
    return;
  }
  if (e.target.id !== 'dest') return;
  state.query = e.target.value;
  document.getElementById('results').innerHTML = resultsHtml(PLACE_BY_ID[state.fromId] || DEMO);
});
window.addEventListener('resize', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

// ---------- location ----------
let geoWatch = null;
function startGeo() {
  if (!('geolocation' in navigator)) { state.geo = 'unavailable'; return; }
  if (geoWatch !== null) return;
  state.geo = 'asking';
  geoWatch = navigator.geolocation.watchPosition((pos) => {
    const moved = state.geo !== 'on' || metres(HERE, { lat: pos.coords.latitude, lng: pos.coords.longitude }) > 10;
    Object.assign(HERE, { lat: pos.coords.latitude, lng: pos.coords.longitude }, proj(pos.coords.latitude, pos.coords.longitude));
    state.geo = 'on';
    state.geoAcc = pos.coords.accuracy;
    if (state.wantHere) {
      state.wantHere = false;
      if (state.destId === 'here') state.destId = null;
      state.fromId = 'here';
      state.fromQuery = '';
      if (state.screen === 'from') state.screen = state.destId ? 'trip' : 'home';
      render();
    } else if (moved && state.fromId === 'here') render();
  }, (err) => {
    navigator.geolocation.clearWatch(geoWatch);
    geoWatch = null;
    state.geo = err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable';
    state.wantHere = false;
    const box = document.getElementById('fromResults');
    if (box) box.innerHTML = fromListHtml(PLACE_BY_ID[state.fromId] || DEMO);
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
}

(async function start() {
  const [net, buildings] = await Promise.all([fetch(NETWORK_URL), fetch(BUILDINGS_URL)].map((r) => r.then((x) => x.json())));
  NET = net;
  buildPlaces(buildings);
  // permission already granted: start from where you are, without asking
  if (navigator.permissions) {
    navigator.permissions.query({ name: 'geolocation' }).then((p) => {
      if (p.state === 'granted') { state.wantHere = state.fromId === 'demo'; startGeo(); }
    }).catch(() => {});
  }
  render();
  poll();
  setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  // countdowns age between polls; a started trip needs its advice kept current
  setInterval(() => { if (!document.hidden && state.screen === 'trip') render(); }, 5000);
})();
