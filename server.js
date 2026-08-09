/**
 * Movie Business 3 — Save/Load Backend
 * ------------------------------------
 * Zero external dependencies. Uses only Node's built-in "http" and "fs" modules.
 *
 * Run:   node server.js
 * (optional) PORT env var to change the port, defaults to 3000.
 *
 * Storage: a single JSON file (database.json) next to this script, keyed by
 * lowercased/trimmed email address. Each entry holds one player's complete
 * saved gameState object exactly as sent by the client.
 *
 * Endpoints:
 *   POST /api/login  { email }                -> { isNewUser, hasSave, gameState|null }
 *   POST /api/load    { email }                -> { hasSave, gameState|null }
 *   POST /api/save    { email, gameState }     -> { success: true, savedAt }
 *
 * Writes are atomic (write to a temp file, then rename) so a crash mid-write
 * can never corrupt the database file.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const TMP_FILE = DB_FILE + '.tmp';

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;

// ---------- tiny "database" ----------

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {}; // first run, no file yet
    console.error('Failed to read database.json, starting with an empty DB:', err.message);
    return {};
  }
}

function saveDB(db) {
  const json = JSON.stringify(db, null, 2);
  fs.writeFileSync(TMP_FILE, json, 'utf8');
  fs.renameSync(TMP_FILE, DB_FILE); // atomic on POSIX filesystems
}

// In-memory cache, persisted to disk on every write. Simple + fine for a
// single-process indie-game backend. Swap loadDB/saveDB for a real DB later
// without touching any of the route handlers below.
let db = loadDB();

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// ---------- HTTP plumbing ----------

function sendJSON(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const MAX_BYTES = 25 * 1024 * 1024; // 25MB safety cap per save
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Browsers send a CORS "preflight" OPTIONS request before the actual
  // POST when the request has a JSON body — it must get a bare 204 with
  // no body, otherwise the browser blocks the real request that follows.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch (err) {
    sendJSON(res, 400, { error: 'Bad request' });
    return;
  }

  try {
    // ---- POST /api/login ----
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      if (!EMAIL_RE.test(email)) {
        sendJSON(res, 400, { error: 'Please provide a valid Gmail address' });
        return;
      }
      const entry = db[email];
      if (entry) {
        sendJSON(res, 200, { isNewUser: false, hasSave: true, gameState: entry.gameState });
      } else {
        // IMPORTANT: do NOT create anything here. Per spec, only NEW STUDIO
        // (after the player fills the create-studio form) creates a save.
        sendJSON(res, 200, { isNewUser: true, hasSave: false, gameState: null });
      }
      return;
    }

    // ---- POST /api/load ----
    if (req.method === 'POST' && url.pathname === '/api/load') {
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      if (!EMAIL_RE.test(email)) {
        sendJSON(res, 400, { error: 'Please provide a valid Gmail address' });
        return;
      }
      const entry = db[email];
      if (entry) {
        sendJSON(res, 200, { hasSave: true, gameState: entry.gameState });
      } else {
        sendJSON(res, 200, { hasSave: false, gameState: null });
      }
      return;
    }

    // ---- POST /api/save ----
    if (req.method === 'POST' && url.pathname === '/api/save') {
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      if (!EMAIL_RE.test(email)) {
        sendJSON(res, 400, { error: 'Please provide a valid Gmail address' });
        return;
      }
      if (typeof body.gameState !== 'object' || body.gameState === null) {
        sendJSON(res, 400, { error: 'Missing gameState' });
        return;
      }
      db[email] = {
        email,
        gameState: body.gameState,
        updatedAt: new Date().toISOString()
      };
      saveDB(db);
      sendJSON(res, 200, { success: true, savedAt: db[email].updatedAt });
      return;
    }

    // ---- health check ----
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJSON(res, 200, { ok: true, players: Object.keys(db).length });
      return;
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: err.message || 'Server error' });
  }
});

// Bind explicitly to 0.0.0.0 (not just "localhost") so the VPS accepts
// connections coming from the public internet, not only from itself.
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Movie Business 3 save server listening on ${HOST}:${PORT}`);
  console.log(`Database file: ${DB_FILE}`);
});
