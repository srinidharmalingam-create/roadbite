# RoadBite 🚗

Finds **well-rated restaurants and coffee ahead of you** on a long drive (built for the
Philly ⇄ Lewiston, ME run) and ranks them by **how little they add to your route** — not just
by raw distance. Open it on your phone, hit **Start driving**, and it watches your GPS + heading,
searches only places in front of you, filters out anything behind you or too far off the road, and
gives a one-tap **Go** button that hands off to Apple/Google Maps.

It's a installable web app (PWA) — no App Store, works on iPhone and Android.

## What it does
- Uses your phone's **GPS position + travel direction** (falls back to computing heading from movement when the GPS course isn't reported).
- **Categories** (multi-select chips): 🍔 Food, ☕ Coffee, ⛽ Gas, ⚡ EV charging — toggle any combination.
- **Cuisine multi-select** (Settings): narrow food to Italian, Mexican, Sushi, BBQ, etc. — pick any number, or none for all restaurants.
- **Set a destination** (Settings, e.g. "Lewiston, ME") to fix your travel direction toward it — more reliable than live heading, and works while stopped. Leave blank to use live GPS heading. The header then shows distance remaining to the destination.
- **Home + Favorite destinations** (Settings): save a Home and any number of favorites; they appear as one-tap chips at the top of the home screen (plus a "📍 Live" chip to switch back to live heading).
- **Gas prices** on gas-station rows (from Google's `fuelOptions`, where reported) and **EV charger speed + plug count** on charging rows (Google does not expose EV pricing).
- **Sort**: Best (rating + detour + distance), Closest (distance from you), or Cheapest (gas price first).
- **Open now** toggle hides places that are currently closed.
- **Map view** (🗺 in the top bar): a Google map above the list showing your location and the result pins, colored by category. Toggle it off to save data. Requires the API key; fails gracefully (the list always works even if the map can't load).
- Filters food & coffee by **minimum rating** (default 4.0★) and **minimum review count** (default 50). Gas and EV are ranked by **proximity** instead (ratings there are sparse).
- Estimates **detour** as roughly 2× the perpendicular distance from your route line (off the road and back) and drops anything beyond your max-detour setting.
- Shows each spot's **distance from you** and **city**, plus open/closed status.
- **Starbucks-only** toggle for when you specifically want Starbucks.
- Re-searches automatically every ~1 mile as you drive.
- **Simulate driving** mode (Settings → Simulate driving) runs a mock Philly→Lewiston trip so you can try it at your desk.

The destination lookup uses Places **Text Search**, and category searches use **Nearby Search** — both part of Places API (New), already covered by the key you enabled.

## One-time setup: Google Places API key
1. Go to <https://console.cloud.google.com/>, create a project (or reuse one).
2. Enable **Maps JavaScript API** and **Places API (New)**.
3. Create an **API key** (APIs & Services → Credentials).
4. Restrict it (recommended): under *Application restrictions* → **Websites**, add the domain you'll host on (e.g. `https://yourname.github.io/*`). Under *API restrictions*, limit it to the two APIs above.
5. In RoadBite, tap **⚙︎** and paste the key. It's stored only on your device (localStorage).

> Google's free tier covers a generous monthly volume; a billing account must be on file but typical personal use stays within the free allowance.

## Hosting it (so you can open it on your phone)
Geolocation requires **HTTPS** (or `localhost`). Easiest free options:

**GitHub Pages**
```
# from this folder
git init && git add . && git commit -m "RoadBite"
# create a repo, push, then enable Pages on the main branch
```
Your app lives at `https://<user>.github.io/<repo>/`.

**Or Netlify / Vercel / Cloudflare Pages** — drag-and-drop this folder, no build step needed.

**Local test on your computer:**
```
python3 -m http.server 4178
# open http://localhost:4178
```
(Geolocation works on `localhost` but for use *on your phone* you need an HTTPS host.)

## Install to your home screen
- **iPhone (Safari):** open the hosted URL → Share → **Add to Home Screen**.
- **Android (Chrome):** open the URL → menu → **Install app / Add to Home Screen**.

It then launches full-screen like a native app, including offline shell caching.

## Files
| File | Purpose |
|------|---------|
| `index.html` | Markup + settings sheet |
| `app.js` | GPS handling, route geometry, Places search, ranking, simulator |
| `style.css` | Dark, driving-friendly UI with big tap targets |
| `manifest.webmanifest` / `sw.js` | PWA install + offline shell |
| `icon-*.png` | App icons |

## Notes & limits
- The "detour" is an estimate based on your current heading, not a full routing calculation — it's accurate for nearby spots (the search radius is capped at ~31 mi and re-runs every mile) and is meant to compare options, not to be turn-by-turn precise.
- Open/closed status and ratings come straight from Google Places.
- Keep your phone mounted and let your passenger tap **Go** — don't interact while driving.
