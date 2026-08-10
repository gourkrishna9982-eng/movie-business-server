/**
 * Movie Business 3 — Save/Load Backend (Render web service + Supabase PostgreSQL)
 * ---------------------------------------------------------------------------
 * Persistent storage: PostgreSQL, hosted on Supabase. The web service itself
 * still runs on Render — only the database moved off Render's ephemeral
 * filesystem to Supabase's managed, persistent Postgres.
 *
 * The HTTP endpoints, request bodies, and response shapes are UNCHANGED
 * from the previous versions — only the storage layer's connection changed.
 *
 * Required env var (set on Render, never in the frontend):
 *   DATABASE_URL   - Supabase connection string (see setup notes below)
 * Optional:
 *   PORT           - Render sets this automatically; do not hardcode it.
 *
 * Endpoints:
 *   POST /api/login  { email }                -> { isNewUser, hasSave, gameState|null }
 *   POST /api/load    { email }                -> { hasSave, gameState|null }
 *   POST /api/save    { email, gameState }     -> { success: true, savedAt, saveVersion }
 *   GET  /api/health                           -> { ok, database, timestamp }
 */

const http = require('http');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is not set.');
  console.error('Add it in Render → your web service → Environment, using the');
  console.error('connection string from your Supabase project (Project Settings');
  console.error('→ Database → Connection string → "Connection pooling" URI).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase's Postgres is reached over the public internet (Render and
  // Supabase are different providers), so unlike Render's own internal
  // Postgres, this connection MUST use SSL. Supabase's certificate chain
  // isn't in Node's default trust store, so rejectUnauthorized is disabled
  // here the same way Supabase's own connection examples show.
  ssl: { rejectUnauthorized: false }
});

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saves (
      email TEXT PRIMARY KEY,
      game_state JSONB NOT NULL,
      save_version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Lightweight backup table: keeps the previous version of each save
  // before it's overwritten, so a bad save is always recoverable.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saves_backup (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      game_state JSONB NOT NULL,
      save_version INTEGER NOT NULL,
      backed_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS saves_backup_email_idx ON saves_backup (email, backed_up_at DESC)`);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// A save is only valid if it actually has content — this is what stops a
// broken/empty client request from clobbering a real save.
function isValidGameState(gameState) {
  if (typeof gameState !== 'object' || gameState === null || Array.isArray(gameState)) return false;
  if (Object.keys(gameState).length === 0) return false;
  return true;
}

// Keep only the last N backups per player so the backup table doesn't grow
// forever.
const MAX_BACKUPS_PER_PLAYER = 10;
async function pruneBackups(email) {
  await pool.query(
    `DELETE FROM saves_backup
     WHERE email = $1
       AND id NOT IN (
         SELECT id FROM saves_backup
         WHERE email = $1
         ORDER BY backed_up_at DESC
         LIMIT $2
       )`,
    [email, MAX_BACKUPS_PER_PLAYER]
  );
}

// ---------- HTTP plumbing (unchanged) ----------

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
      const { rows } = await pool.query('SELECT game_state FROM saves WHERE email = $1', [email]);
      if (rows.length > 0) {
        sendJSON(res, 200, { isNewUser: false, hasSave: true, gameState: rows[0].game_state });
      } else {
        // No record for this account. Only NEW STUDIO creation (via
        // /api/save after the create-studio form) should ever create one.
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
      const { rows } = await pool.query('SELECT game_state FROM saves WHERE email = $1', [email]);
      if (rows.length > 0) {
        sendJSON(res, 200, { hasSave: true, gameState: rows[0].game_state });
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
      if (!isValidGameState(body.gameState)) {
        // Reject instead of overwriting — never let a bad/empty payload
        // destroy a good save.
        sendJSON(res, 400, { error: 'Missing or empty gameState — save rejected to protect existing data' });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existing = await client.query(
          'SELECT game_state, save_version FROM saves WHERE email = $1 FOR UPDATE',
          [email]
        );

        // Back up whatever the previous save was, before overwriting it.
        if (existing.rows.length > 0) {
          await client.query(
            'INSERT INTO saves_backup (email, game_state, save_version) VALUES ($1, $2, $3)',
            [email, existing.rows[0].game_state, existing.rows[0].save_version]
          );
        }

        const nextVersion = existing.rows.length > 0 ? existing.rows[0].save_version + 1 : 1;

        const result = await client.query(
          `INSERT INTO saves (email, game_state, save_version, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (email) DO UPDATE SET
             game_state = EXCLUDED.game_state,
             save_version = EXCLUDED.save_version,
             updated_at = now()
           RETURNING updated_at, save_version`,
          [email, JSON.stringify(body.gameState), nextVersion]
        );

        await client.query('COMMIT');
        await pruneBackups(email);

        sendJSON(res, 200, {
          success: true,
          savedAt: result.rows[0].updated_at,
          saveVersion: result.rows[0].save_version
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return;
    }

    // ---- health check ----
    if (req.method === 'GET' && url.pathname === '/api/health') {
      try {
        const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM saves');
        sendJSON(res, 200, {
          ok: true,
          database: 'postgres',
          players: rows[0].n,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        sendJSON(res, 500, { ok: false, database: 'postgres', error: 'Database is not responding' });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      sendJSON(res, 200, { ok: true, service: 'movie-business-server' });
      return;
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    // A server-side failure must NEVER be reported as "no save" — that would
    // make the frontend show "No saved studio yet" for a player who actually
    // has one. Always surface it as a real error instead.
    sendJSON(res, 500, { error: err.message || 'Server error' });
  }
});

const HOST = '0.0.0.0';
initDb()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Movie Business 3 save server listening on ${HOST}:${PORT}`);
      console.log('Database: PostgreSQL (Supabase)');
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

process.on('SIGTERM', () => { pool.end(); process.exit(0); });
process.on('SIGINT', () => { pool.end(); process.exit(0); });
