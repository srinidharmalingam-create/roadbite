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
- **Map view** (🗺 in the header): a Google map above the list that draws **driving directions to your destination** plus result pins colored by category. **Tap a pin** to flash its row; **tap a row** to bounce its pin. Toggle it off to save data; fails gracefully (the list always works even if the map can't load).
  - Real road routing needs the **Directions API** enabled in Google Cloud (same project/key). If it's not enabled, the map falls back to a straight line to the destination — enable it for turn-by-turn route shapes.
- **Settings** live behind the **☰ menu** in the header; the filter row holds only the category chips so they stay on one line (they scroll sideways on very narrow/folded screens).
- **Recenter button** (⌖) on the map snaps back to your current location.
- **Address validation**: Destination, Home, and new Favorites are checked against Google as you enter them — you get a ✓ with the matched place name, or a "not found" warning (favorites that don't resolve aren't added).
- **How to use + About** sections in the ☰ menu.
- **ETA + arrival time** in the header when a destination is set (driving time and clock arrival, from the Directions route).
- **Share** button on each row — opens the phone's share sheet with the place name + a Maps link (copies the link as a fallback).
- **Proximity buzz** (opt-in, ☰ menu): vibrates and shows a toast when a ≥4.5★ food/coffee spot is within 1 mile (Android supports the vibration).
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

## Sharing with family & friends
The API key is **injected at deploy time** from a GitHub Actions secret, so anyone who
opens the hosted URL can use the app with nothing to configure — and the key is never in
the source repo.

- **To share:** just send people `https://srinidharmalingam-create.github.io/roadbite/`. They add it to their home screen and go.
- **Security:** the key ends up in the deployed `config.js` (unavoidable for any client-side Maps app) but is **referrer-restricted** to this domain, so it only works from your app.
- **Rotate / change the key:** update the repo secret, then re-run the deploy:
  ```
  gh secret set ROADBITE_KEY --repo <owner>/roadbite --body "NEW_KEY"
  gh workflow run "Deploy to GitHub Pages" --repo <owner>/roadbite
  ```
- **Bound the cost** (recommended for a shared key): in Google Cloud → APIs & Services → set a **daily quota cap** on the Maps JavaScript and Places APIs, and add a **Billing → Budgets & alerts** budget so shared usage can't surprise you.

How it works: `config.js` holds a `__ROADBITE_KEY__` placeholder; `.github/workflows/deploy.yml`
replaces it with the `ROADBITE_KEY` secret and publishes to Pages. The app uses a key entered
in ⚙︎ Settings if present, otherwise the baked-in shared key.

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
