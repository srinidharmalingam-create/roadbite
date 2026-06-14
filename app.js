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
function loadGoogle(key) {
  return new Promise((resolve, reject) => {
    if (window.google?.maps?.importLibrary) return resolve();
    window.gm_authFailure = () => reject(new Error('API key rejected by Google'));
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&v=weekly&loading=async`;
    s.async = true;
    s.onerror = () => reject(new Error('Failed to load Google Maps script'));
    s.onload = () => resolve();
    document.head.appendChild(s);
  });
}

async function ensurePlaces() {
  if (state.placesLib) return state.placesLib;
  if (!settings.apiKey) throw new Error('NO_KEY');
  await loadGoogle(settings.apiKey);
  state.placesLib = await google.maps.importLibrary('places');
  return state.placesLib;
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

  // Google caps nearby radius at 50km (~31mi). Use look-ahead, capped.
  const radiusMeters = Math.min(settings.lookAhead, 31) * 1609.34;
  const center = { lat: state.pos.lat, lng: state.pos.lng };
  const fields = ['displayName', 'location', 'rating', 'userRatingCount',
                  'businessStatus', 'regularOpeningHours', 'primaryType',
                  'primaryTypeDisplayName', 'addressComponents', 'id'];

  // One search per selected category so each is well represented in the results.
  const tasks = cats.map(cat => {
    const includedTypes = (cat === 'food' && settings.cuisines.length)
      ? settings.cuisines.slice()
      : CATEGORY_TYPES[cat];
    return Place.searchNearby({
      fields, locationRestriction: { center, radius: radiusMeters }, includedTypes,
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

  state.results = merged.map(rankPlace).filter(Boolean)
    .sort((a, b) => a.score - b.score).slice(0, 40);
  render();
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

  const heading = effectiveHeading();
  let along = haversineMi(state.pos, loc), cross = 0, ahead = true;
  if (heading != null) {
    const t = trackDistances(state.pos, loc, heading);
    along = t.along; cross = Math.abs(t.cross);
    const ad = angleDiff(bearing(state.pos, loc), heading);
    ahead = ad <= 90 && ad >= -90;
  }

  if (heading != null) {
    if (settings.aheadOnly && !ahead) return null;
    if (cross > settings.maxDetour) return null;
    if (along > settings.lookAhead) return null;
    // Don't suggest stops well beyond the destination.
    if (state.destCoords) {
      const distDest = haversineMi(state.pos, state.destCoords);
      if (along > distDest + 5) return null;
    }
  } else {
    if (along > settings.lookAhead) return null;
  }

  const detour = heading != null ? cross * 2 : null;  // off-route and back
  const straight = haversineMi(state.pos, loc);

  // Score: lower is better. Reward rating (food/coffee), penalize detour & distance.
  const ratingPenalty = ratedKind ? (5 - rating) * 4 : 6;
  const detourPenalty = (detour ?? straight) * 3;
  const distPenalty = along * 0.4;
  const score = ratingPenalty + detourPenalty + distPenalty;

  let openNow = null;
  try { openNow = p.regularOpeningHours?.isOpen?.() ?? null; } catch (_) {}

  return {
    id: p.id, name: p.displayName, loc, rating, reviews, kind,
    isCoffee: kind === 'coffee', along, detour, straight, openNow, score,
    city: extractCity(p.addressComponents),
    typeLabel: humanizeType(p, kind),
  };
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

    // line 3: open status · detour off route
    const detourTxt = r.detour != null ? `<span class="detour">+${fmtMi(r.detour)} off route</span>` : '';
    const openTxt = r.openNow == null ? ''
      : `<span class="open ${r.openNow ? '' : 'closed'}">${r.openNow ? 'Open' : 'Closed'}</span>`;
    const line3 = [openTxt, detourTxt].filter(Boolean).join('<span class="mid">·</span>');

    li.innerHTML = `
      <div class="cat-icon">${SVG[r.kind] || SVG.food}</div>
      <div class="info">
        <div class="title">${escapeHtml(r.name)}</div>
        <div class="sub">${sub}</div>
        ${line3 ? `<div class="line3">${line3}</div>` : ''}
      </div>
      <div class="trail">
        <span class="away">${fmtMi(r.straight)}</span>
        <button class="dirs" aria-label="Directions to ${escapeHtml(r.name)}">${SVG.nav}</button>
      </div>`;

    li.querySelector('.dirs').addEventListener('click', () => navigateTo(r));
    els.results.appendChild(li);
  }
}

function showEmpty(msg, emoji) {
  els.results.innerHTML = '';
  els.empty.innerHTML = (emoji ? `<span class="big">${emoji}</span>` : '') + escapeHtml(msg);
  els.empty.classList.remove('hidden');
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
  // With a destination set, show it + remaining distance; else show live heading.
  if (state.destCoords && state.pos) {
    const dist = haversineMi(state.pos, state.destCoords);
    els.headingBanner.classList.remove('hidden');
    els.headingBanner.innerHTML =
      `📍 To <b>${escapeHtml(state.destName || 'destination')}</b>` +
      ` <span class="sep">·</span> ${fmtMi(dist)} away` +
      (state.speedMph != null ? ` <span class="sep">·</span> ${Math.round(state.speedMph)} mph` : '');
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

// ---------- Settings UI ----------
function bindSettings() {
  const map = [
    ['#api-key', 'apiKey', 'value', v => v.trim()],
    ['#rating', 'minRating', 'value', parseFloat, '#rating-val', v => v.toFixed(1)],
    ['#reviews', 'minReviews', 'value', v => parseInt(v, 10), '#reviews-val'],
    ['#detour', 'maxDetour', 'value', parseFloat, '#detour-val'],
    ['#ahead', 'lookAhead', 'value', parseFloat, '#ahead-val'],
    ['#ahead-only', 'aheadOnly', 'checked', v => v],
    ['#starbucks-only', 'starbucksOnly', 'checked', v => v],
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
  // Re-run search when filters that affect ranking change & we have a fix.
  ['#rating', '#reviews', '#detour', '#ahead', '#ahead-only', '#starbucks-only'].forEach(sel =>
    $(sel).addEventListener('change', () => state.pos && search()));

  $('#api-key').addEventListener('change', () => {
    state.placesLib = null; // force reload with new key
    if (state.pos) search();
  });

  // Destination
  const dest = $('#dest');
  dest.value = settings.destination;
  if (settings.destination) setDestStatus('…');
  dest.addEventListener('change', () => {
    settings.destination = dest.value.trim();
    state.destResolvedFor = '';   // force re-resolve
    saveSettings();
    if (state.pos) search(); else updateHeadingBanner();
  });

  buildCuisineChips();
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

// ---------- Wire up ----------
function init() {
  loadSettings();
  bindSettings();
  setupCategories();

  els.start.addEventListener('click', start);
  $('#settings-btn').addEventListener('click', () => els.settings.classList.remove('hidden'));
  $('#settings-done').addEventListener('click', () => els.settings.classList.add('hidden'));
  $('#sim-btn').addEventListener('click', () => { els.settings.classList.add('hidden'); startSim(); });

  if (!settings.apiKey) showEmpty('Welcome to RoadBite\n\nTap ⚙︎ to add your Google Places API key, then "Start driving".', '🚗');
  else showEmpty('Tap "Start driving" to find food, coffee, gas & EV charging ahead of you.', '🍔☕');

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);

// Expose a few internals for testing in the preview harness.
window.RoadBite = { state, settings, onPosition, search, startSim, render };
