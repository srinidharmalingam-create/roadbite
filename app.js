/* RoadBite — suggests well-rated food & coffee ahead of you on a long drive.
 * Pure client-side PWA. Uses the browser Geolocation API for position + heading
 * and the Google Maps JS "places" library (Places API New) for ratings.
 */

'use strict';

// ---------- Geometry helpers ----------
const R_MI = 3958.8;            // Earth radius in miles
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

function haversineMi(a, b) {
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.sqrt(s));
}

// Initial bearing (degrees, 0=N) from a -> b
function bearing(a, b) {
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Smallest signed angle difference a-b in [-180,180]
function angleDiff(a, b) {
  let d = ((a - b + 540) % 360) - 180;
  return d;
}

// Along-track and cross-track distance of point `p` relative to the line
// starting at `origin` going along `headingDeg`. Returns miles (cross signed).
function trackDistances(origin, p, headingDeg) {
  const d13 = haversineMi(origin, p) / R_MI;     // angular distance
  const t13 = toRad(bearing(origin, p));
  const t12 = toRad(headingDeg);
  const xt = Math.asin(Math.sin(d13) * Math.sin(t13 - t12));
  const at = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / Math.cos(xt))));
  return { along: at * R_MI, cross: xt * R_MI };
}

const COMPASS = ['N','NE','E','SE','S','SW','W','NW'];
const compass = deg => COMPASS[Math.round(((deg % 360) / 45)) % 8];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Local planar coords (miles) of p relative to origin — fine over short spans.
function toXY(origin, p) {
  const k = Math.cos(toRad(origin.lat));
  return { x: (p.lng - origin.lng) * k * 69.0, y: (p.lat - origin.lat) * 69.0 };
}

// Cumulative distance (miles) at each vertex of a path.
function buildCum(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + haversineMi(path[i - 1], path[i]);
  return cum;
}

// Project a point onto a polyline. Returns {along, perp} in miles:
// `along` = distance from the route start to the nearest point on the route,
// `perp`  = how far the point sits off the route.
function projectToPath(pos, path, cum) {
  let best = { perp: Infinity, along: 0 };
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const B = toXY(a, b), P = toXY(a, pos);
    const bb = B.x * B.x + B.y * B.y;
    const t = bb > 0 ? clamp((P.x * B.x + P.y * B.y) / bb, 0, 1) : 0;
    const proj = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    const perp = haversineMi(pos, proj);
    if (perp < best.perp) best = { perp, along: cum[i] + (cum[i + 1] - cum[i]) * t };
  }
  return best;
}

// The {lat,lng} at a given cumulative distance (miles) along a path.
function pointAlongPath(path, cum, target) {
  const total = cum[cum.length - 1];
  const d = clamp(target, 0, total);
  for (let i = 0; i < path.length - 1; i++) {
    if (cum[i + 1] >= d) {
      const seg = cum[i + 1] - cum[i] || 1;
      const t = (d - cum[i]) / seg;
      return { lat: path[i].lat + (path[i + 1].lat - path[i].lat) * t,
               lng: path[i].lng + (path[i + 1].lng - path[i].lng) * t };
    }
  }
  return path[path.length - 1];
}

// Destination point distMi away from origin along a compass bearing (degrees).
function destPoint(origin, bearingDeg, distMi) {
  const d = distMi / R_MI, br = toRad(bearingDeg), lat1 = toRad(origin.lat), lng1 = toRad(origin.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 = lng1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1),
                                 Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lng: toDeg(lng2) };
}

// Speed used for time estimates: real GPS speed when moving, else a highway default.
function speedEstimate() {
  return (state.speedMph != null && state.speedMph > 8) ? state.speedMph : 50;
}

// What Google Places type(s) each category maps to.
const CATEGORY_TYPES = {
  food: ['restaurant'],            // replaced by chosen cuisines when any are selected
  coffee: ['coffee_shop', 'cafe'],
  gas: ['gas_station'],
  ev: ['electric_vehicle_charging_station'],
};

// Cuisine chips (values are Google Places primary types).
const CUISINES = [
  ['american_restaurant', 'American'], ['italian_restaurant', 'Italian'],
  ['mexican_restaurant', 'Mexican'], ['chinese_restaurant', 'Chinese'],
  ['japanese_restaurant', 'Japanese'], ['sushi_restaurant', 'Sushi'],
  ['thai_restaurant', 'Thai'], ['indian_restaurant', 'Indian'],
  ['pizza_restaurant', 'Pizza'], ['hamburger_restaurant', 'Burgers'],
  ['seafood_restaurant', 'Seafood'], ['steak_house', 'Steakhouse'],
  ['barbecue_restaurant', 'BBQ'], ['mediterranean_restaurant', 'Mediterranean'],
  ['breakfast_restaurant', 'Breakfast'], ['vegetarian_restaurant', 'Vegetarian'],
  ['fast_food_restaurant', 'Fast food'], ['sandwich_shop', 'Sandwiches'],
];

// ---------- State ----------
const state = {
  pos: null,            // {lat,lng}
  heading: null,        // degrees (live GPS)
  speedMph: null,
  lastSearchPos: null,
  running: false,
  watchId: null,
  placesLib: null,
  results: [],
  prevPos: null,
  destCoords: null,     // {lat,lng} resolved destination
  destName: '',
  destResolvedFor: '',  // the query string destCoords was resolved from
};

const settings = {
  apiKey: '',
  categories: ['food', 'coffee'],
  cuisines: [],         // selected cuisine type keys
  destination: '',
  home: '',             // saved home address
  favorites: [],        // saved favorite destination strings
  sort: 'best',         // 'best' | 'closest' | 'cheapest'
  openNowOnly: false,
  timeWindow: 0,        // minutes; 0 = any, else only show stops reachable within N min
  showMap: true,
  alertNearby: false,   // buzz when a top pick is coming up
  starbucksOnly: false,
  minRating: 4.0,
  minReviews: 50,
  maxDetour: 5,     // miles off route
  lookAhead: 25,    // miles forward
  aheadOnly: true,
};

// ---------- Persistence ----------
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('roadbite') || '{}');
    Object.assign(settings, s);
  } catch (_) {}
}
function saveSettings() {
  localStorage.setItem('roadbite', JSON.stringify(settings));
}

// ---------- DOM ----------
const $ = sel => document.querySelector(sel);
const els = {
  gps: $('#gps'), gpsText: $('#gps-text'),
  results: $('#results'), empty: $('#empty'),
  start: $('#start-btn'),
  headingBanner: $('#heading-banner'),
  settings: $('#settings'),
};

// Effective travel direction: toward the chosen destination, else live GPS heading.
function effectiveHeading() {
  if (state.destCoords && state.pos) return bearing(state.pos, state.destCoords);
  return state.heading;
}

// ---------- Google Places loader ----------
// Google's official inline bootstrap. Unlike a plain <script> tag, this defines
// google.maps.importLibrary() synchronously, so awaiting it never races the load.
function loadGoogle(key) {
  if (window.google?.maps?.importLibrary) return;
  ((g) => {
    let h, a, k, p = 'The Google Maps JavaScript API', c = 'google', l = 'importLibrary',
      q = '__ib__', m = document, b = window;
    b = b[c] || (b[c] = {});
    const d = b.maps || (b.maps = {}), r = new Set(), e = new URLSearchParams(),
      u = () => h || (h = new Promise(async (f, n) => {
        await (a = m.createElement('script'));
        e.set('libraries', [...r] + '');
        for (k in g) e.set(k.replace(/[A-Z]/g, t => '_' + t[0].toLowerCase()), g[k]);
        e.set('callback', c + '.maps.' + q);
        a.src = `https://maps.${c}apis.com/maps/api/js?` + e;
        d[q] = f;
        a.onerror = () => h = n(Error(p + ' could not load.'));
        a.nonce = m.querySelector('script[nonce]')?.nonce || '';
        m.head.append(a);
      }));
    d[l] ? console.warn(p + ' only loads once. Ignoring:', g) : (d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)));
  })({ key, v: 'weekly' });
}

// A key baked into the deployed site (config.js), ignored if still the placeholder.
function bakedKey() {
  const k = window.ROADBITE_KEY;
  return (typeof k === 'string' && k && !k.includes('__')) ? k : '';
}
// User-entered key (Settings) takes priority; otherwise the shared baked-in key.
function effectiveKey() {
  return (settings.apiKey && settings.apiKey.trim()) || bakedKey();
}

async function ensurePlaces() {
  if (state.placesLib) return state.placesLib;
  const key = effectiveKey();
  if (!key) throw new Error('NO_KEY');
  loadGoogle(key);
  state.placesLib = await google.maps.importLibrary('places');
  return state.placesLib;
}

// ---------- Map (optional, fails gracefully) ----------
const KIND_COLORS = { food: '#ff9500', coffee: '#a2845e', gas: '#5856d6', ev: '#30b0c7' };

async function ensureMap() {
  if (state.map) return state.map;
  await ensurePlaces();                       // guarantees google is loaded
  const { Map } = await google.maps.importLibrary('maps');
  const el = document.getElementById('map');
  let center = state.pos;
  if (!center && settings.home) center = await geocodeText(settings.home);
  state.map = new Map(el, {
    center: center || { lat: 42.6, lng: -72.5 },   // fallback: New England
    zoom: center ? 11 : 6,
    disableDefaultUI: true,
    zoomControl: true,
    clickableIcons: false,
    gestureHandling: 'greedy',
  });
  return state.map;
}

async function geocodeText(q) {
  try {
    const { Place } = await ensurePlaces();
    const { places } = await Place.searchByText({
      textQuery: q, fields: ['location', 'displayName', 'formattedAddress'], maxResultCount: 1,
    });
    if (places && places[0]) {
      const p = places[0];
      return { lat: p.location.lat(), lng: p.location.lng(), name: p.displayName || p.formattedAddress || q };
    }
  } catch (_) {}
  return null;
}

function updateMapMarkers() {
  if (!state.map || !window.google) return;
  (state.markers || []).forEach(m => m.setMap(null));
  state.markers = [];
  state.markersById = {};
  const pin = (pos, color, scale, z, title) => new google.maps.Marker({
    position: pos, map: state.map, title, zIndex: z,
    icon: { path: google.maps.SymbolPath.CIRCLE, scale, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
  });
  for (const r of state.results) {
    const m = pin(r.loc, KIND_COLORS[r.kind] || '#ff9500', 8, 1, r.name);
    m.addListener('click', () => highlightRow(r.id));   // pin -> row
    state.markers.push(m);
    state.markersById[r.id] = m;
  }
  if (state.pos) state.markers.push(pin(state.pos, '#0a84ff', 6, 999, 'You'));
}

// Fetch driving directions to the destination: updates the ETA banner, and (if the
// map is open) renders the route. Falls back to a straight line if Directions fails.
async function refreshRoute(fit) {
  if (state.dirRenderer) { state.dirRenderer.setMap(null); state.dirRenderer = null; }
  if (state.routeLine) { state.routeLine.setMap(null); state.routeLine = null; }

  if (!state.pos || !state.destCoords || !effectiveKey()) {
    state.routeEta = null; state.routePath = null; state.routeCum = null; updateHeadingBanner();
    if (state.map && fit && state.pos && !state.destCoords) { state.map.setCenter(state.pos); state.map.setZoom(12); }
    return;
  }
  try {
    const routes = await google.maps.importLibrary('routes');
    const res = await new routes.DirectionsService().route({
      origin: state.pos, destination: state.destCoords,
      travelMode: google.maps.TravelMode.DRIVING,
    });
    const leg = res.routes?.[0]?.legs?.[0];
    state.routeEta = leg?.duration ? { dur: leg.duration.text, dist: leg.distance?.text, sec: leg.duration.value } : null;
    // Store the route polyline so "forward only" follows the real road, not a straight line.
    const path = (res.routes?.[0]?.overview_path || []).map(pt => ({ lat: pt.lat(), lng: pt.lng() }));
    if (path.length > 1) { state.routePath = path; state.routeCum = buildCum(path); }
    else { state.routePath = null; state.routeCum = null; }
    updateHeadingBanner();
    if (state.map && settings.showMap) {
      state.dirRenderer = new routes.DirectionsRenderer({
        map: state.map, suppressMarkers: true, preserveViewport: !fit,
        polylineOptions: { strokeColor: '#0a84ff', strokeWeight: 5, strokeOpacity: 0.85 },
      });
      state.dirRenderer.setDirections(res);
    }
  } catch (_) {
    state.routeEta = null; state.routePath = null; state.routeCum = null; updateHeadingBanner();
    if (state.map && settings.showMap) {
      state.routeLine = new google.maps.Polyline({
        map: state.map, path: [state.pos, state.destCoords],
        strokeColor: '#0a84ff', strokeWeight: 4, strokeOpacity: 0.6,
      });
      if (fit) {
        const b = new google.maps.LatLngBounds();
        b.extend(state.pos); b.extend(state.destCoords);
        state.map.fitBounds(b, 60);
      }
    }
  }
}

// Refresh the route/ETA when the destination changes, or every ~10 mi of travel.
function maybeRefreshRoute() {
  if (!state.pos) return;
  const sig = state.destCoords
    ? `${state.destCoords.lat.toFixed(3)},${state.destCoords.lng.toFixed(3)}` : 'none';
  const movedFar = !state.routeOrigin || haversineMi(state.routeOrigin, state.pos) > 10;
  const newDest = sig !== state.routeSig;
  if (newDest || movedFar) {
    state.routeSig = sig;
    state.routeOrigin = state.pos;
    refreshRoute(newDest);   // only re-fit the map viewport for a brand-new destination
  }
}

// row -> pin: bounce the marker and pan to it.
function highlightPin(r) {
  const m = state.markersById && state.markersById[r.id];
  if (!state.map || !m) return;
  state.map.panTo(r.loc);
  m.setAnimation(google.maps.Animation.BOUNCE);
  setTimeout(() => m.setAnimation(null), 1400);
}

// pin -> row: scroll the row into view and flash it.
function highlightRow(id) {
  const li = els.results.querySelector(`[data-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
  if (!li) return;
  li.scrollIntoView({ behavior: 'smooth', block: 'center' });
  li.classList.add('hl');
  setTimeout(() => li.classList.remove('hl'), 1600);
}

async function refreshMap() {
  if (!settings.showMap || !effectiveKey()) return;
  try {
    await ensureMap();
    updateMapMarkers();
    state.routeSig = null;     // force a fresh fit when the map is (re)opened
    maybeRefreshRoute();
  } catch (_) { /* map is best-effort; the list still works */ }
}

// ---------- Search ----------
async function search() {
  if (!state.pos) return;
  let lib;
  try {
    lib = await ensurePlaces();
  } catch (e) {
    if (e.message === 'NO_KEY') showEmpty('Add your Google Places API key in ⚙︎ Settings to see suggestions.');
    else showEmpty('Google Places error: ' + e.message);
    return;
  }
  const { Place, SearchNearbyRankPreference } = lib;

  await resolveDestination(lib);

  const cats = settings.categories;
  if (!cats.length) { showEmpty('Pick at least one category above (Food, Coffee, Gas, EV).', '🧭'); return; }

  // Our current progress along the route (if any) — the cutoff for "ahead".
  state.userAlong = (state.routePath && state.routeCum)
    ? projectToPath(state.pos, state.routePath, state.routeCum).along : null;

  // Where to search. Normally around us. But with a "reach in N min" window we look
  // AROUND the point ~N minutes ahead on the route — Google's radius (≤31mi) can't
  // otherwise reach far enough, which is why it used to only show nearby places.
  let center = { lat: state.pos.lat, lng: state.pos.lng };
  let radiusMi = Math.min(settings.lookAhead, 31);
  state.aheadLimitMiles = settings.lookAhead;

  if (settings.timeWindow > 0) {
    const targetMi = speedEstimate() * settings.timeWindow / 60;   // miles you'll cover in N min
    if (state.routePath && state.routeCum && state.userAlong != null) {
      center = pointAlongPath(state.routePath, state.routeCum, state.userAlong + targetMi);
    } else if (effectiveHeading() != null) {
      center = destPoint(state.pos, effectiveHeading(), targetMi);
    }
    radiusMi = clamp(targetMi * 0.6, 6, 31);     // a band around the future point
    state.aheadLimitMiles = targetMi + radiusMi; // let rankPlace keep these far-ahead stops
  }
  const radiusMeters = radiusMi * 1609.34;
  const fields = ['displayName', 'location', 'rating', 'userRatingCount',
                  'businessStatus', 'regularOpeningHours', 'primaryType',
                  'primaryTypeDisplayName', 'addressComponents', 'id'];

  // One search per selected category so each is well represented in the results.
  const tasks = cats.map(cat => {
    const includedTypes = (cat === 'food' && settings.cuisines.length)
      ? settings.cuisines.slice()
      : CATEGORY_TYPES[cat];
    const catFields = fields.slice();
    if (cat === 'gas') catFields.push('fuelOptions');         // fuel prices
    if (cat === 'ev') catFields.push('evChargeOptions');      // charger speed/plugs
    return Place.searchNearby({
      fields: catFields, locationRestriction: { center, radius: radiusMeters }, includedTypes,
      maxResultCount: 20, rankPreference: SearchNearbyRankPreference.DISTANCE,
    }).then(r => r.places || []).catch(() => []);
  });

  let groups;
  try {
    groups = await Promise.all(tasks);
  } catch (e) {
    showEmpty('Search failed: ' + e.message);
    return;
  }

  // Merge + de-dupe across categories.
  const seen = new Set(), merged = [];
  for (const g of groups) for (const p of g) {
    if (!seen.has(p.id)) { seen.add(p.id); merged.push(p); }
  }

  state.results = sortResults(merged.map(rankPlace).filter(Boolean)).slice(0, 40);
  render();
}

// Apply the active sort. Default "best" = combined score (rating + detour + distance).
function sortResults(list) {
  const by = settings.sort;
  if (by === 'closest') return list.sort((a, b) => a.straight - b.straight);
  if (by === 'cheapest') {
    // Gas with a known price first (cheapest up top), then everything else by score.
    return list.sort((a, b) => {
      const ap = a.fuelValue ?? Infinity, bp = b.fuelValue ?? Infinity;
      if (ap !== bp) return ap - bp;
      return a.score - b.score;
    });
  }
  return list.sort((a, b) => a.score - b.score);
}

// Resolve the destination text into coordinates (only when it changes).
async function resolveDestination(lib) {
  const q = (settings.destination || '').trim();
  if (!q) { state.destCoords = null; state.destName = ''; state.destResolvedFor = ''; setDestStatus(''); return; }
  if (state.destResolvedFor === q && state.destCoords) return;
  try {
    const { places } = await lib.Place.searchByText({
      textQuery: q, fields: ['location', 'displayName', 'formattedAddress'], maxResultCount: 1,
    });
    if (places && places[0]) {
      state.destCoords = { lat: places[0].location.lat(), lng: places[0].location.lng() };
      state.destName = places[0].displayName || q;
      state.destResolvedFor = q;
      setDestStatus('✓ ' + state.destName);
    } else {
      state.destCoords = null; state.destName = ''; setDestStatus('· not found');
    }
  } catch (_) {
    state.destCoords = null; state.destName = ''; setDestStatus('· lookup failed');
  }
}

function setDestStatus(text) {
  const el = document.getElementById('dest-status');
  if (el) el.textContent = text;
}

// Set (or clear) the active destination, validate it, and refresh.
async function setDestination(value) {
  settings.destination = value || '';
  state.destResolvedFor = '';
  const di = $('#dest'); if (di) di.value = settings.destination;
  saveSettings();
  renderQuickDest();

  if (!settings.destination) {
    state.destCoords = null; state.destName = ''; setDestStatus('');
  } else if (effectiveKey()) {
    // Validate right away so the user gets ✓ / not-found even before GPS starts.
    setDestStatus('…');
    try { await resolveDestination(await ensurePlaces()); } catch (_) {}
  }
  updateHeadingBanner();
  if (state.pos) search();
}

// One-tap destination chips (Home + favorites) shown at the top of the home screen.
function renderQuickDest() {
  const wrap = $('#quick-dest');
  const items = [];
  if (settings.home) items.push(['🏠', settings.home, 'Home']);
  for (const f of settings.favorites) items.push(['⭐', f, f]);
  if (!items.length) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }

  wrap.classList.remove('hidden');
  wrap.innerHTML = '';
  const mk = (label, value, active, onClick) => {
    const b = document.createElement('button');
    b.className = 'qd' + (active ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    wrap.appendChild(b);
  };
  mk('📍 Live', '', !settings.destination, () => setDestination(''));
  for (const [icon, value, label] of items) {
    const short = label.length > 16 ? label.slice(0, 16) + '…' : label;
    mk(`${icon} ${short}`, value, settings.destination === value, () => setDestination(value));
  }
}

function placeKind(p) {
  const t = p.primaryType || '';
  if (t === 'gas_station') return 'gas';
  if (t === 'electric_vehicle_charging_station') return 'ev';
  if (/coffee|cafe/.test(t) || /coffee|cafe|starbucks|dunkin/i.test(p.displayName)) return 'coffee';
  return 'food';
}

function rankPlace(p) {
  const loc = { lat: p.location.lat(), lng: p.location.lng() };
  const rating = p.rating || 0;
  const reviews = p.userRatingCount || 0;
  const kind = placeKind(p);
  const ratedKind = kind === 'food' || kind === 'coffee';

  if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') return null;
  // Rating/review thresholds apply to food & coffee only; gas/EV rank on proximity.
  if (ratedKind && rating < settings.minRating) return null;
  if (ratedKind && reviews < settings.minReviews) return null;

  if (state.starbucksOnly && kind === 'coffee' && !/starbucks/i.test(p.displayName)) return null;

  // Decide "ahead vs already passed", plus how far ahead (along) and off-route (cross).
  // Best: project onto the actual route polyline. Fallback: bearing relative to heading.
  const heading = effectiveHeading();
  const haveRoute = state.routePath && state.routeCum && state.userAlong != null;
  let along, cross = 0, ahead = true, directed = true;

  if (haveRoute) {
    const proj = projectToPath(loc, state.routePath, state.routeCum);
    cross = proj.perp;
    along = proj.along - state.userAlong;   // signed: + = ahead on the route, - = passed
    ahead = along > 0.05;                    // strictly further along the route than us
  } else if (heading != null) {
    const t = trackDistances(state.pos, loc, heading);
    cross = Math.abs(t.cross);
    const ad = angleDiff(bearing(state.pos, loc), heading);
    ahead = ad <= 90 && ad >= -90;
    along = ahead ? t.along : -t.along;      // negative when behind us
  } else {
    along = haversineMi(state.pos, loc);     // direction unknown (cold start, no dest)
    directed = false;
  }

  // How far ahead we'll accept: the look-ahead distance, or further when a time window
  // is active (so "reach in 30 min / 1 hr" can surface places well down the road).
  const aheadLimit = state.aheadLimitMiles || settings.lookAhead;
  if (directed) {
    if (settings.aheadOnly && !ahead) return null;   // drop anything already passed
    if (cross > settings.maxDetour) return null;
    if (along > aheadLimit) return null;
    if (state.destCoords) {
      const distDest = haversineMi(state.pos, state.destCoords);
      if (along > distDest + 5) return null;          // don't suggest past the destination
    }
  } else {
    if (along > aheadLimit) return null;
  }

  const detour = directed ? cross * 2 : null;  // off the route and back
  const straight = haversineMi(state.pos, loc);

  // Estimated minutes to reach it: drive along the route to the nearest point, then
  // one-way off the road. Uses current speed (falls back to ~50 mph when stopped/slow).
  const reachMiles = Math.max(0, along) + (directed ? cross : 0);
  const etaMin = Math.round(reachMiles / speedEstimate() * 60);

  // "Reach in N minutes" window (e.g. "can we eat in 30 minutes?"). Small slack so a
  // spot a couple of minutes past the mark still shows.
  if (settings.timeWindow && etaMin > settings.timeWindow + 5) return null;

  // Score: lower is better. Reward rating (food/coffee), penalize detour & distance.
  const ratingPenalty = ratedKind ? (5 - rating) * 4 : 6;
  const detourPenalty = (detour ?? straight) * 3;
  const distPenalty = Math.max(0, along) * 0.4;
  const score = ratingPenalty + detourPenalty + distPenalty;

  let openNow = null;
  try { openNow = p.regularOpeningHours?.isOpen?.() ?? null; } catch (_) {}

  // "Open now only" hides places we know are closed (keeps unknowns).
  if (settings.openNowOnly && openNow === false) return null;

  const fuel = kind === 'gas' ? fuelPriceLabel(p) : null;

  return {
    id: p.id, name: p.displayName, loc, rating, reviews, kind,
    isCoffee: kind === 'coffee', along, detour, straight, etaMin, openNow, score,
    city: extractCity(p.addressComponents),
    typeLabel: humanizeType(p, kind),
    fuelPrice: fuel ? fuel.label : '',
    fuelValue: fuel ? fuel.value : Infinity,
    evInfo: kind === 'ev' ? evInfoLabel(p) : '',
  };
}

// Regular-unleaded fuel price as {label, value}. null if none reported.
function fuelPriceLabel(p) {
  const prices = p.fuelOptions?.fuelPrices;
  if (!prices || !prices.length) return null;
  const chosen = prices.find(x => x.type === 'REGULAR_UNLEADED') || prices[0];
  const m = chosen.price;
  if (!m) return null;
  const val = Number(m.units || 0) + (m.nanos || 0) / 1e9;
  if (!val) return null;
  const cur = m.currencyCode === 'USD' ? '$' : (m.currencyCode || '') + ' ';
  const grade = { REGULAR_UNLEADED: 'reg', MIDGRADE: 'mid', PREMIUM: 'prem', DIESEL: 'diesel' }[chosen.type] || '';
  return { label: `${cur}${val.toFixed(2)}${grade ? ' ' + grade : ''}`, value: val };
}

// Charger speed + plug count (Google does not expose EV pricing). "" if none.
function evInfoLabel(p) {
  const opt = p.evChargeOptions;
  if (!opt) return '';
  let kw = 0;
  for (const a of (opt.connectorAggregation || [])) kw = Math.max(kw, a.maxChargeRateKw || 0);
  const plugs = opt.connectorCount || 0;
  const parts = [];
  if (kw) parts.push(`${Math.round(kw)} kW`);
  if (plugs) parts.push(`${plugs} plug${plugs > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

// City name from the place's address components.
function extractCity(components) {
  if (!components || !components.length) return '';
  const want = ['locality', 'postal_town', 'sublocality',
                'administrative_area_level_3', 'neighborhood'];
  for (const t of want) {
    const c = components.find(c => (c.types || []).includes(t));
    if (c) return c.shortText || c.longText || '';
  }
  return '';
}

// Friendly category label, e.g. "pizza_restaurant" -> "Pizza".
function humanizeType(p, kind) {
  if (kind === 'gas') return 'Gas station';
  if (kind === 'ev') return 'EV charging';
  if (p.primaryTypeDisplayName) {
    return (p.primaryTypeDisplayName.text || p.primaryTypeDisplayName);
  }
  const t = p.primaryType || '';
  if (!t) return kind === 'coffee' ? 'Coffee' : 'Restaurant';
  return t.replace(/_/g, ' ')
    .replace(/\brestaurant\b/i, '')
    .replace(/\bshop\b/i, '')
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase()) || 'Restaurant';
}

// ---------- Render ----------
const SVG = {
  food: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.1 2a.7.7 0 0 0-.7.7v4.9c0 .6-.3 1-.8 1.1V2.7a.7.7 0 0 0-1.4 0v6c-.5-.1-.8-.5-.8-1.1V2.7a.7.7 0 0 0-1.4 0v4.9c0 1.4.8 2.4 2.2 2.6V21a.9.9 0 0 0 1.8 0v-10.8c1.4-.2 2.2-1.2 2.2-2.6V2.7A.7.7 0 0 0 8.1 2zM15.5 2c-1.4 0-2.5 2.2-2.5 5.2 0 2.3.8 3.8 2 4.3V21a.9.9 0 0 0 1.8 0V2.9c0-.5-.4-.9-1.3-.9z"/></svg>',
  coffee: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h13v7.5A4.5 4.5 0 0 1 12.5 16h-4A4.5 4.5 0 0 1 4 11.5V4zm13 1.8h1.3a2.1 2.1 0 0 1 0 4.2H17V5.8zM4.5 19h12a.9.9 0 0 1 0 1.8h-12a.9.9 0 0 1 0-1.8z"/></svg>',
  gas: '<svg viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M3.5 3.2c0-.7.6-1.2 1.2-1.2h6c.7 0 1.2.5 1.2 1.2V21H3.5V3.2zM5.4 4.6h5.2v3.4H5.4V4.6z"/><path d="M13 6.2l2.6 2.6c.3.3.4.6.4 1v7.3a1.4 1.4 0 0 0 2.8 0V11h-1.3c-.5 0-.9-.4-.9-.9V7.6L15.1 6 13 6.2z"/><path d="M3 21.1h10a.9.9 0 0 1 0 1.8H3a.9.9 0 0 1 0-1.8z"/></svg>',
  ev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.2 2L4.5 13.4c-.4.5 0 1.3.6 1.3h5L9 21.3c-.1.8.9 1.2 1.4.6l8.6-11.4c.4-.5 0-1.3-.6-1.3h-5l1-6.5c.1-.8-.9-1.2-1.4-.6z"/></svg>',
  nav: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.6 3.4a1 1 0 0 0-1.1-.2L4 9.6c-1 .4-.9 1.8.1 2.1l6.3 1.9 1.9 6.3c.3 1 1.7 1.1 2.1.1l6.4-15.5a1 1 0 0 0-.2-1.1z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/></svg>',
};

function fmtMi(mi) {
  if (mi == null) return '—';
  if (mi < 0.1) return '<0.1 mi';
  return (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
}

function fmtCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace('.0', '') + 'k';
  return String(n);
}

function render() {
  els.results.innerHTML = '';
  if (!state.results.length) {
    showEmpty('No matching spots ahead yet. Loosen filters in ⚙︎ or keep driving.');
    return;
  }
  els.empty.classList.add('hidden');
  $('#controls').classList.remove('hidden');

  for (const r of state.results) {
    const li = document.createElement('li');
    li.className = 'row ' + r.kind;

    // line 2: rating (if any) · category · city
    const ratingPart = r.rating > 0
      ? `<span class="stars">★ ${r.rating.toFixed(1)}</span> <span class="count">(${fmtCount(r.reviews)})</span>`
      : '';
    const sub = [
      ratingPart,
      r.typeLabel && escapeHtml(r.typeLabel),
      r.city && escapeHtml(r.city),
    ].filter(Boolean).join('<span class="mid">·</span>');

    // line 3: price/charge info · open status · detour off route
    const detourTxt = r.detour != null ? `<span class="detour">+${fmtMi(r.detour)} off route</span>` : '';
    const openTxt = r.openNow == null ? ''
      : `<span class="open ${r.openNow ? '' : 'closed'}">${r.openNow ? 'Open' : 'Closed'}</span>`;
    const priceTxt = r.fuelPrice ? `<span class="price">${escapeHtml(r.fuelPrice)}</span>` : '';
    const evTxt = r.evInfo ? `<span class="evinfo">${escapeHtml(r.evInfo)}</span>` : '';
    const line3 = [priceTxt, evTxt, openTxt, detourTxt].filter(Boolean).join('<span class="mid">·</span>');

    li.innerHTML = `
      <div class="cat-icon">${SVG[r.kind] || SVG.food}</div>
      <div class="info">
        <div class="title">${escapeHtml(r.name)}</div>
        <div class="sub">${sub}</div>
        ${line3 ? `<div class="line3">${line3}</div>` : ''}
      </div>
      <div class="trail">
        <span class="away">${fmtMi(r.straight)}</span>
        ${r.etaMin != null ? `<span class="eta">~${r.etaMin} min</span>` : ''}
        <div class="trail-btns">
          <button class="share" aria-label="Share ${escapeHtml(r.name)}">${SVG.share}</button>
          <button class="dirs" aria-label="Directions to ${escapeHtml(r.name)}">${SVG.nav}</button>
        </div>
      </div>`;

    li.dataset.id = r.id;
    li.querySelector('.dirs').addEventListener('click', (e) => { e.stopPropagation(); navigateTo(r); });
    li.querySelector('.share').addEventListener('click', (e) => { e.stopPropagation(); sharePlace(r); });
    li.addEventListener('click', () => highlightPin(r));   // row -> pin
    els.results.appendChild(li);
  }

  if (state.map) updateMapMarkers();
  maybeRefreshRoute();   // updates ETA banner even when the map is off
  maybeAlert();
}

function showEmpty(msg, emoji) {
  els.results.innerHTML = '';
  els.empty.innerHTML = (emoji ? `<span class="big">${emoji}</span>` : '') + escapeHtml(msg);
  els.empty.classList.remove('hidden');
  $('#controls').classList.add('hidden');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function navigateTo(r) {
  const isApple = /iPhone|iPad|Macintosh/.test(navigator.userAgent);
  const q = `${r.loc.lat},${r.loc.lng}`;
  const url = isApple
    ? `https://maps.apple.com/?daddr=${q}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`;
  window.open(url, '_blank');
}

// Share a place via the OS share sheet, falling back to copying a Maps link.
async function sharePlace(r) {
  const url = `https://www.google.com/maps/search/?api=1&query=${r.loc.lat},${r.loc.lng}`;
  const text = `${r.name}${r.city ? ' — ' + r.city : ''}${r.rating ? ` (★${r.rating.toFixed(1)})` : ''}`;
  try {
    if (navigator.share) { await navigator.share({ title: r.name, text, url }); return; }
  } catch (_) { return; }  // user cancelled the share sheet
  try { await navigator.clipboard.writeText(`${text} ${url}`); toast('Link copied'); }
  catch (_) { window.open(url, '_blank'); }
}

// Brief bottom toast.
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// Optional: buzz + toast once when a top-rated stop is coming up (Android supports vibrate).
function maybeAlert() {
  if (!settings.alertNearby || !state.running) return;
  state.alerted = state.alerted || new Set();
  for (const r of state.results) {
    if ((r.kind === 'food' || r.kind === 'coffee') && r.rating >= 4.5 &&
        r.straight <= 1.0 && !state.alerted.has(r.id)) {
      state.alerted.add(r.id);
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      toast(`${r.isCoffee ? '☕' : '🍔'} ${r.name} coming up · ★${r.rating.toFixed(1)}`);
      break;
    }
  }
}

// ---------- Position handling ----------
function onPosition(coords) {
  const pos = { lat: coords.latitude, lng: coords.longitude };

  // Heading: prefer GPS course; fall back to bearing between fixes.
  let heading = (coords.heading != null && !Number.isNaN(coords.heading)) ? coords.heading : null;
  if (heading == null && state.prevPos && haversineMi(state.prevPos, pos) > 0.02) {
    heading = bearing(state.prevPos, pos);
  }
  if (heading != null) state.heading = heading;

  state.speedMph = coords.speed != null && !Number.isNaN(coords.speed) ? coords.speed * 2.237 : null;
  state.prevPos = state.pos;
  state.pos = pos;

  setGps('on', 'GPS live');
  updateHeadingBanner();

  // Re-search when we first get a fix or have moved meaningfully (>1 mi).
  if (!state.lastSearchPos || haversineMi(state.lastSearchPos, pos) > 1) {
    state.lastSearchPos = pos;
    search();
  }
}

function updateHeadingBanner() {
  // With a destination set, show it + ETA (from the route) or straight-line distance.
  if (state.destCoords && state.pos) {
    const sep = ' <span class="sep">·</span> ';
    let parts = [`📍 To <b>${escapeHtml(state.destName || 'destination')}</b>`];
    if (state.routeEta) {
      parts.push(state.routeEta.dist || fmtMi(haversineMi(state.pos, state.destCoords)));
      const arrive = new Date(Date.now() + state.routeEta.sec * 1000)
        .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      parts.push(`${state.routeEta.dur} · arrive ${arrive}`);
    } else {
      parts.push(`${fmtMi(haversineMi(state.pos, state.destCoords))} away`);
    }
    if (state.speedMph != null) parts.push(`${Math.round(state.speedMph)} mph`);
    els.headingBanner.classList.remove('hidden');
    els.headingBanner.innerHTML = parts.join(sep);
    return;
  }
  if (state.heading == null) { els.headingBanner.classList.add('hidden'); return; }
  els.headingBanner.classList.remove('hidden');
  els.headingBanner.innerHTML =
    `🧭 Heading <b>${compass(state.heading)} (${Math.round(state.heading)}°)</b>` +
    ` <span class="sep">·</span> ${state.speedMph != null ? Math.round(state.speedMph) + ' mph' : 'parked'}`;
}

function setGps(cls, text) {
  els.gps.className = 'gps ' + cls;
  els.gpsText.textContent = text;
}

function start() {
  if (state.running) return stop();
  // First time starting without a destination, ask for one (precise forward-only).
  if (!settings.destination && !state.destPromptDismissed) { openDestPrompt(); return; }
  startTracking();
}

function startTracking() {
  if (state.running) return;
  if (!('geolocation' in navigator)) { setGps('error', 'No GPS'); return; }
  state.running = true;
  els.start.textContent = 'Stop';
  els.start.classList.add('running');
  setGps('on', 'Locating…');
  state.watchId = navigator.geolocation.watchPosition(
    p => onPosition(p.coords),
    err => setGps('error', err.code === 1 ? 'Location denied' : 'GPS error'),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

// Destination prompt shown from Start driving when none is set.
function openDestPrompt() {
  const wrap = $('#prompt-quick');
  wrap.innerHTML = '';
  const items = [];
  if (settings.home) items.push(['🏠', settings.home, 'Home']);
  for (const f of settings.favorites) items.push(['⭐', f, f]);
  for (const [icon, value, label] of items) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'qd';
    b.textContent = `${icon} ${label.length > 18 ? label.slice(0, 18) + '…' : label}`;
    b.addEventListener('click', () => promptGo(value));   // one tap: set + drive
    wrap.appendChild(b);
  }
  wrap.classList.toggle('hidden', !items.length);
  $('#prompt-dest').value = '';
  $('#dest-prompt').classList.remove('hidden');
  setTimeout(() => $('#prompt-dest').focus(), 150);
}

async function promptGo(value) {
  $('#dest-prompt').classList.add('hidden');
  state.destPromptDismissed = true;
  if (value) await setDestination(value);
  startTracking();
}

function stop() {
  state.running = false;
  els.start.textContent = 'Start driving';
  els.start.classList.remove('running');
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  if (state.simTimer) { clearInterval(state.simTimer); state.simTimer = null; }
  setGps('off', 'GPS off');
}

// ---------- Simulation (testing without moving) ----------
function startSim() {
  stop();
  state.running = true;
  els.start.textContent = 'Stop';
  els.start.classList.add('running');
  // Coarse Philly -> Lewiston ME waypoints (I-95 corridor).
  const route = [
    { lat: 39.9526, lng: -75.1652 }, // Philadelphia
    { lat: 40.2206, lng: -74.7597 }, // Trenton
    { lat: 40.7357, lng: -74.1724 }, // Newark
    { lat: 41.0534, lng: -73.5387 }, // Stamford
    { lat: 41.3083, lng: -72.9279 }, // New Haven
    { lat: 41.7658, lng: -72.6734 }, // Hartford
    { lat: 42.1015, lng: -72.5898 }, // Springfield
    { lat: 42.3601, lng: -71.0589 }, // Boston
    { lat: 42.9956, lng: -70.9662 }, // Portsmouth NH
    { lat: 43.6591, lng: -70.2568 }, // Portland ME
    { lat: 44.1004, lng: -70.2148 }, // Lewiston ME
  ];
  let i = 0, f = 0;
  setGps('on', 'SIM driving');
  const tick = () => {
    const a = route[i], b = route[Math.min(i + 1, route.length - 1)];
    const lat = a.lat + (b.lat - a.lat) * f;
    const lng = a.lng + (b.lng - a.lng) * f;
    onPosition({ latitude: lat, longitude: lng, heading: bearing(a, b), speed: 29 }); // ~65mph
    f += 0.34;
    if (f >= 1) { f = 0; i++; }
    if (i >= route.length - 1) { clearInterval(state.simTimer); state.simTimer = null; }
  };
  tick();
  state.simTimer = setInterval(tick, 4000);
}

// Numeric tuners rendered as tap steppers (no sliders to drag while scrolling).
const STEPPERS = [
  { key: 'minRating', label: 'Minimum rating', min: 0, max: 5, step: 0.5, fmt: v => v.toFixed(1) + '★', note: 'Applies to food & coffee. Gas & EV rank by proximity.' },
  { key: 'minReviews', label: 'Minimum reviews', min: 0, max: 500, step: 25, fmt: v => String(v) },
  { key: 'maxDetour', label: 'Max detour off route', min: 0.5, max: 20, step: 0.5, fmt: v => v + ' mi' },
  { key: 'lookAhead', label: 'Look-ahead distance', min: 5, max: 50, step: 5, fmt: v => v + ' mi' },
];

function buildSteppers() {
  const wrap = $('#stepper-list');
  wrap.innerHTML = '';
  for (const s of STEPPERS) {
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `
      <div class="stepper">
        <span class="stepper-label">${s.label}</span>
        <div class="stepper-ctl">
          <button type="button" class="step-btn" aria-label="Decrease ${s.label}">−</button>
          <span class="stepper-val"></span>
          <button type="button" class="step-btn" aria-label="Increase ${s.label}">+</button>
        </div>
      </div>${s.note ? `<small>${s.note}</small>` : ''}`;
    const valEl = row.querySelector('.stepper-val');
    const draw = () => valEl.textContent = s.fmt(settings[s.key]);
    draw();
    const btns = row.querySelectorAll('.step-btn');
    const change = dir => {
      let v = settings[s.key] + dir * s.step;
      v = parseFloat(Math.min(s.max, Math.max(s.min, v)).toFixed(2));
      settings[s.key] = v; saveSettings(); draw();
      if (state.pos) search();
    };
    btns[0].addEventListener('click', () => change(-1));
    btns[1].addEventListener('click', () => change(1));
    wrap.appendChild(row);
  }
}

// ---------- Settings UI ----------
function bindSettings() {
  const map = [
    ['#api-key', 'apiKey', 'value', v => v.trim()],
    ['#ahead-only', 'aheadOnly', 'checked', v => v],
    ['#starbucks-only', 'starbucksOnly', 'checked', v => v],
    ['#alert-nearby', 'alertNearby', 'checked', v => v],
  ];
  for (const [sel, key, prop, parse, labelSel, fmt] of map) {
    const el = $(sel);
    el[prop] = settings[key];
    if (labelSel) $(labelSel).textContent = (fmt || String)(settings[key]);
    el.addEventListener('input', () => {
      settings[key] = parse(el[prop]);
      if (labelSel) $(labelSel).textContent = (fmt || String)(settings[key]);
      saveSettings();
    });
  }
  buildSteppers();
  // Re-run search when filters that affect ranking change & we have a fix.
  ['#ahead-only', '#starbucks-only'].forEach(sel =>
    $(sel).addEventListener('change', () => state.pos && search()));

  $('#api-key').addEventListener('change', () => {
    // Google Maps loads once per page; a new key only takes effect after reload.
    if (window.google?.maps) { saveSettings(); location.reload(); return; }
    state.placesLib = null;
    if (state.pos) search();
  });

  // Destination
  const dest = $('#dest');
  dest.value = settings.destination;
  if (settings.destination) setDestStatus('…');
  dest.addEventListener('change', () => setDestination(dest.value.trim()));

  // Home (validated on entry)
  const home = $('#home');
  home.value = settings.home;
  home.addEventListener('change', async () => {
    settings.home = home.value.trim();
    saveSettings();
    renderQuickDest();
    if (!settings.home) { setStatus('#home-status', ''); return; }
    if (!effectiveKey()) { setStatus('#home-status', ''); return; }
    setStatus('#home-status', '…');
    const c = await geocodeText(settings.home);
    setStatus('#home-status', c ? '✓ ' + c.name : '· not found', !c);
  });
  if (settings.home && effectiveKey()) {
    setStatus('#home-status', '…');
    geocodeText(settings.home).then(c => setStatus('#home-status', c ? '✓ ' + c.name : '· not found', !c));
  }

  // Favorites (validated before adding)
  renderFavList();
  const addFav = async () => {
    const inp = $('#fav-input');
    const v = inp.value.trim();
    if (!v || settings.favorites.includes(v)) { inp.value = ''; return; }
    if (effectiveKey()) {
      setFavMsg('Checking address…');
      const c = await geocodeText(v);
      if (!c) { setFavMsg('Couldn’t find “' + v + '”. Try a more specific name.', true); return; }
    }
    settings.favorites.push(v);
    saveSettings();
    renderFavList();
    renderQuickDest();
    inp.value = '';
    setFavMsg('Saved places show as one-tap chips at the top of the home screen.');
  };
  $('#fav-add-btn').addEventListener('click', addFav);
  $('#fav-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFav(); } });

  buildCuisineChips();
}

function setStatus(sel, text, isError) {
  const el = $(sel);
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--red)' : '';
}
function setFavMsg(text, isError) {
  const el = $('#fav-msg');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--red)' : '';
}

function renderFavList() {
  const wrap = $('#fav-list');
  wrap.innerHTML = '';
  if (!settings.favorites.length) { wrap.classList.add('empty-favs'); return; }
  wrap.classList.remove('empty-favs');
  settings.favorites.forEach((fav, i) => {
    const row = document.createElement('div');
    row.className = 'fav-row';
    row.innerHTML = `<span>⭐ ${escapeHtml(fav)}</span>`;
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'fav-del'; del.textContent = '✕';
    del.setAttribute('aria-label', 'Remove ' + fav);
    del.addEventListener('click', () => {
      settings.favorites.splice(i, 1);
      saveSettings(); renderFavList(); renderQuickDest();
    });
    row.appendChild(del);
    wrap.appendChild(row);
  });
}

function buildCuisineChips() {
  const wrap = $('#cuisine-list');
  wrap.innerHTML = '';
  for (const [type, label] of CUISINES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cuisine-chip' + (settings.cuisines.includes(type) ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      const i = settings.cuisines.indexOf(type);
      if (i >= 0) settings.cuisines.splice(i, 1); else settings.cuisines.push(type);
      btn.classList.toggle('active');
      saveSettings();
      if (state.pos && settings.categories.includes('food')) search();
    });
    wrap.appendChild(btn);
  }
}

function setupCategories() {
  document.querySelectorAll('#cat-list .cat-chip').forEach(btn => {
    const cat = btn.dataset.cat;
    btn.classList.toggle('active', settings.categories.includes(cat));
    btn.addEventListener('click', () => {
      const i = settings.categories.indexOf(cat);
      if (i >= 0) settings.categories.splice(i, 1); else settings.categories.push(cat);
      btn.classList.toggle('active', settings.categories.includes(cat));
      saveSettings();
      if (state.pos) search();
    });
  });
}

// Sort segmented control + "Open now" toggle (above the results list).
function setupControls() {
  document.querySelectorAll('#sort-seg .sort-btn').forEach(btn => {
    btn.classList.toggle('active', settings.sort === btn.dataset.sort);
    btn.addEventListener('click', () => {
      settings.sort = btn.dataset.sort;
      document.querySelectorAll('#sort-seg .sort-btn').forEach(b => b.classList.toggle('active', b === btn));
      saveSettings();
      // Re-sort what we already have (no new API call needed).
      state.results = sortResults(state.results);
      render();
    });
  });

  const openBtn = $('#opennow-toggle');
  openBtn.classList.toggle('active', settings.openNowOnly);
  openBtn.addEventListener('click', () => {
    settings.openNowOnly = !settings.openNowOnly;
    openBtn.classList.toggle('active', settings.openNowOnly);
    saveSettings();
    if (state.pos) search();
  });

  // "Reach in" time window — show only stops you can get to within N minutes.
  document.querySelectorAll('#time-seg .time-btn').forEach(btn => {
    const mins = parseInt(btn.dataset.min, 10);
    btn.classList.toggle('active', settings.timeWindow === mins);
    btn.addEventListener('click', () => {
      settings.timeWindow = mins;
      document.querySelectorAll('#time-seg .time-btn').forEach(b => b.classList.toggle('active', b === btn));
      saveSettings();
      // Needs a direction to look ahead: a destination, or movement (GPS heading).
      if (mins > 0 && !state.destCoords && state.heading == null) {
        toast('Set a destination or start driving to find stops ' + mins + ' min ahead.');
      }
      if (state.pos) search();
    });
  });
}

function setupMap() {
  const btn = $('#map-toggle');
  const wrap = document.getElementById('map-wrap');
  const apply = () => {
    const visible = settings.showMap && !!effectiveKey();
    btn.classList.toggle('active', settings.showMap);
    wrap.classList.toggle('hidden', !visible);
  };
  apply();
  btn.addEventListener('click', () => {
    if (!effectiveKey()) { els.settings.classList.remove('hidden'); return; }  // need a key first
    settings.showMap = !settings.showMap;
    saveSettings();
    apply();
    if (settings.showMap) refreshMap();
  });
  $('#recenter-btn').addEventListener('click', () => {
    if (state.map && state.pos) { state.map.panTo(state.pos); state.map.setZoom(14); }
  });
  if (settings.showMap && effectiveKey()) refreshMap();
}

// ---------- Wire up ----------
function init() {
  loadSettings();
  bindSettings();
  setupCategories();
  setupControls();
  setupMap();
  renderQuickDest();

  // Surface Google auth/referrer problems instead of failing silently.
  window.gm_authFailure = () =>
    showEmpty('Google rejected the API key. Check the key and that this site’s domain is allowed in the key’s restrictions.', '⚠️');

  els.start.addEventListener('click', start);
  $('#prompt-go').addEventListener('click', () => promptGo($('#prompt-dest').value.trim()));
  $('#prompt-dest').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); promptGo($('#prompt-dest').value.trim()); } });
  $('#prompt-skip').addEventListener('click', () => { state.destPromptDismissed = true; $('#dest-prompt').classList.add('hidden'); startTracking(); });
  $('#menu-btn').addEventListener('click', () => els.settings.classList.remove('hidden'));
  $('#settings-done').addEventListener('click', () => els.settings.classList.add('hidden'));
  $('#sim-btn').addEventListener('click', () => { els.settings.classList.add('hidden'); startSim(); });

  if (!effectiveKey()) showEmpty('Welcome to Hino’s RoadBite\n\nTap ⚙︎ to add your Google Places API key, then "Start driving".', '🚗');
  else showEmpty('Tap "Start driving" to find food, coffee, gas & EV charging ahead of you.', '🍔☕');

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);

// Expose a few internals for testing in the preview harness.
window.RoadBite = { state, settings, onPosition, search, startSim, render, renderQuickDest, sortResults, updateHeadingBanner, toast };
