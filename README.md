# Movie Business 3 — Login + Permanent Per-Email Save

## Files
- **movie-business-3.html** — your complete game (Login → Home → Create Studio → the existing Movie Business 3 engine), now wired together. Nothing about the existing game's UI, systems, or calculations was changed.
- **server.js** — the backend save server. Zero npm dependencies (uses only Node's built-in `http`/`fs`), so there's nothing to `npm install`.

## Running it
1. On your machine or VPS: `node server.js` (defaults to port 3000; set `PORT=xxxx` to change it).
   It creates `database.json` next to itself the first time someone saves — that file *is* your database, one entry per Gmail address.
2. Open `movie-business-3.html` in a browser. If your server isn't on `localhost:3000`, edit the one line near the top of the last `<script>` block:
   ```js
   const API_BASE_URL = 'http://localhost:3000';
   ```
   Change it to your deployed URL, e.g. `https://yourdomain.com`.
3. Serve the HTML file over http(s) (rather than opening it as a bare `file://`) if your browser blocks fetch() from local files — any static file host (or even `npx serve`) works.

## How it fits together
- **Login** checks `/api/login`. If that Gmail has a save, it stays logged in and shows the Home screen with **CONTINUE** ready to load it. If not, it's a first-time player.
- **CONTINUE** pulls the complete saved `gameState` from the server and hands it straight to the existing game engine — same dashboard, same data, exactly where you left off.
- **NEW STUDIO** is the only action that can start over. If a save already exists it asks for confirmation first, then creates and saves a fresh studio using the game's own `gameState` shape (not a second/simplified one).
- **EXIT** only logs out — it flushes any pending save first, then returns to the login screen. It never deletes anything.
- **Autosave**: the existing `gameState` object is wrapped in a JavaScript `Proxy` that detects *any* change to it (cash, hired staff, movies, box office, awards, weeks/years, etc.) and saves automatically ~1 second after the last change, with an immediate flush on exit or tab close. This means every existing game function — hiring, simulating weeks, releasing movies, and so on — is already covered without editing any of that game logic.
- Each Gmail's data is stored under its own key in `database.json`, so different players' saves can never overwrite each other.

## Swapping in a real database later
`server.js` isolates all storage behind two functions, `loadDB()`/`saveDB()`, and the three routes (`/api/login`, `/api/load`, `/api/save`). To move off the JSON file onto Postgres/MySQL/etc., you only need to replace those two functions — the routes and the front-end don't need to change.
