// PostgreSQL-backed store using Neon (or any pg-compatible database).
// Interface is identical to the old in-memory store so no other files need to change.
const crypto = require('crypto');
const { Pool } = require('pg');

// ── Crypto helpers (unchanged) ────────────────────────────────────────────────
const key = () => crypto.createHash('sha256').update(process.env.APP_SECRET || 'dev-secret-change-me').digest();
const enc = t => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv),
    b = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), b].map(x => x.toString('base64')).join('.');
};
const dec = s => {
  try {
    const [i, t, b] = s.split('.').map(x => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), i); d.setAuthTag(t);
    return Buffer.concat([d.update(b), d.final()]).toString('utf8');
  } catch { return null; }
};
const id = () => crypto.randomBytes(8).toString('hex');

// ── Database pool ─────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.warn('[store] WARNING: DATABASE_URL is not set. Database queries will fail.');
}

const connectionString = (() => {
  if (!process.env.DATABASE_URL) return undefined;
  const u = new URL(process.env.DATABASE_URL);
  if (['prefer', 'require', 'verify-ca'].includes(u.searchParams.get('sslmode')) && !u.searchParams.has('uselibpqcompat')) {
    u.searchParams.set('uselibpqcompat', 'true');
  }
  return u.toString();
})();

const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ── Schema bootstrap (runs once on first connection) ──────────────────────────
let _ready = null;
async function ensureSchema() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not configured. Please add DATABASE_URL in Vercel project settings.');
  }
  if (_ready) return _ready;
  _ready = pool.query(`
    CREATE TABLE IF NOT EXISTS gateways (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      enabled     BOOLEAN NOT NULL DEFAULT true,
      url         TEXT,
      token_enc   TEXT,
      timeout     INTEGER NOT NULL DEFAULT 5000,
      retries     INTEGER NOT NULL DEFAULT 3
    );

    INSERT INTO gateways (id, name, type) VALUES
      ('sms',  'SMS',  'sms'),
      ('zalo', 'Zalo', 'zalo'),
      ('push', 'Push', 'push')
    ON CONFLICT (id) DO NOTHING;

    UPDATE gateways
    SET type = id
    WHERE id IN ('sms', 'zalo', 'push') AND type IS DISTINCT FROM id;

    CREATE TABLE IF NOT EXISTS logs (
      id            TEXT PRIMARY KEY,
      gateway_id    TEXT,
      channel       TEXT,
      recipient     TEXT,
      title         TEXT,
      message       TEXT,
      status        TEXT,
      message_id    TEXT,
      response_code INTEGER,
      response_time INTEGER,
      error_message TEXT,
      request       JSONB DEFAULT '{}',
      response      JSONB DEFAULT '{}',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inbox (
      id          TEXT PRIMARY KEY,
      channel     TEXT,
      recipient   TEXT,
      title       TEXT,
      message     TEXT,
      otp         TEXT,
      message_id  TEXT,
      payload     JSONB DEFAULT '{}',
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id          TEXT PRIMARY KEY,
      name        TEXT,
      hash        TEXT UNIQUE,
      preview     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used   TIMESTAMPTZ,
      status      TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS settings (
      id               INTEGER PRIMARY KEY DEFAULT 1,
      default_gateway  TEXT    NOT NULL DEFAULT 'push',
      timeout          INTEGER NOT NULL DEFAULT 5000,
      retries          INTEGER NOT NULL DEFAULT 3,
      logging          BOOLEAN NOT NULL DEFAULT true,
      history          BOOLEAN NOT NULL DEFAULT true
    );

    INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `).catch(err => {
    _ready = null;
    throw err;
  });
  return _ready;
}

// ── Row mappers ───────────────────────────────────────────────────────────────
const ts = v => v ? (v instanceof Date ? v.toISOString() : v) : null;
const mapGateway = r => ({ id: r.id, name: r.name, type: r.type, enabled: r.enabled, url: r.url, tokenEnc: r.token_enc, timeout: r.timeout, retries: r.retries });
const mapLog = r => ({ id: r.id, gatewayId: r.gateway_id, channel: r.channel, recipient: r.recipient, title: r.title, message: r.message, status: r.status, messageId: r.message_id, responseCode: r.response_code, responseTime: r.response_time, errorMessage: r.error_message, request: r.request, response: r.response, createdAt: ts(r.created_at) });
const mapInbox = r => ({ id: r.id, channel: r.channel, recipient: r.recipient, title: r.title, message: r.message, otp: r.otp, messageId: r.message_id, payload: r.payload, receivedAt: ts(r.received_at) });
const mapKey = r => ({ id: r.id, name: r.name, hash: r.hash, preview: r.preview, createdAt: ts(r.created_at), lastUsed: ts(r.last_used), status: r.status });
const mapSettings = r => ({ defaultGateway: r.default_gateway, timeout: r.timeout, retries: r.retries, logging: r.logging, history: r.history });
const DEFAULTS = { defaultGateway: 'push', timeout: 5000, retries: 3, logging: true, history: true };

// ── Repos ─────────────────────────────────────────────────────────────────────
const repos = {
  gateways: {
    all: async () => { await ensureSchema(); const { rows } = await pool.query("SELECT * FROM gateways WHERE id IN ('sms','zalo','push') ORDER BY id"); return rows.map(mapGateway); },
    get: async i => { await ensureSchema(); const { rows } = await pool.query("SELECT * FROM gateways WHERE id=$1 AND id IN ('sms','zalo','push')", [i]); return rows[0] ? mapGateway(rows[0]) : null; },
    update: async (i, p) => {
      await ensureSchema();
      const sets = [], vals = [];
      if (p.enabled !== undefined) sets.push(`enabled=$${vals.push(p.enabled)}`);
      if (p.url !== undefined) sets.push(`url=$${vals.push(p.url)}`);
      if (p.tokenEnc !== undefined) sets.push(`token_enc=$${vals.push(p.tokenEnc)}`);
      if (p.timeout !== undefined) sets.push(`timeout=$${vals.push(p.timeout)}`);
      if (p.retries !== undefined) sets.push(`retries=$${vals.push(p.retries)}`);
      if (!sets.length) return repos.gateways.get(i);
      vals.push(i);
      const { rows } = await pool.query(`UPDATE gateways SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
      return mapGateway(rows[0]);
    },
  },
  logs: {
    all: async () => { await ensureSchema(); const { rows } = await pool.query('SELECT * FROM logs ORDER BY created_at DESC LIMIT 5000'); return rows.map(mapLog); },
    get: async i => { await ensureSchema(); const { rows } = await pool.query('SELECT * FROM logs WHERE id=$1', [i]); return rows[0] ? mapLog(rows[0]) : null; },
    add: async l => {
      await ensureSchema();
      await pool.query(
        `INSERT INTO logs (id,gateway_id,channel,recipient,title,message,status,message_id,response_code,response_time,error_message,request,response,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [l.id, l.gatewayId, l.channel, l.recipient, l.title, l.message, l.status, l.messageId, l.responseCode, l.responseTime, l.errorMessage, JSON.stringify(l.request || {}), JSON.stringify(l.response || {}), l.createdAt]
      );
      return l;
    },
  },
  inbox: {
    all: async () => { await ensureSchema(); const { rows } = await pool.query('SELECT * FROM inbox ORDER BY received_at DESC LIMIT 1000'); return rows.map(mapInbox); },
    add: async m => {
      await ensureSchema();
      await pool.query(
        `INSERT INTO inbox (id,channel,recipient,title,message,otp,message_id,payload,received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [m.id, m.channel, m.recipient, m.title, m.message, m.otp, m.messageId, JSON.stringify(m.payload || {}), m.receivedAt]
      );
      return m;
    },
    clear: async () => { await ensureSchema(); await pool.query('DELETE FROM inbox'); },
  },
  keys: {
    all: async () => { await ensureSchema(); const { rows } = await pool.query('SELECT * FROM api_keys ORDER BY created_at DESC'); return rows.map(mapKey); },
    get: async i => { await ensureSchema(); const { rows } = await pool.query('SELECT * FROM api_keys WHERE id=$1', [i]); return rows[0] ? mapKey(rows[0]) : null; },
    add: async k => {
      await ensureSchema();
      await pool.query(
        `INSERT INTO api_keys (id,name,hash,preview,created_at,last_used,status) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [k.id, k.name, k.hash, k.preview, k.createdAt, k.lastUsed, k.status]
      );
      return k;
    },
    byHash: async h => {
      await ensureSchema();
      const { rows } = await pool.query(`SELECT * FROM api_keys WHERE hash=$1 AND status='active'`, [h]);
      if (!rows[0]) return null;
      pool.query(`UPDATE api_keys SET last_used=NOW() WHERE id=$1`, [rows[0].id]).catch(() => {});
      return mapKey(rows[0]);
    },
    revoke: async i => {
      await ensureSchema();
      await pool.query(`UPDATE api_keys SET status='revoked' WHERE id=$1`, [i]);
      return { ok: true };
    },
  },
  settings: {
    get: async () => { await ensureSchema(); const { rows } = await pool.query('SELECT * FROM settings WHERE id=1'); return rows[0] ? mapSettings(rows[0]) : { ...DEFAULTS }; },
    set: async s => {
      await ensureSchema();
      const { rows } = await pool.query(
        `UPDATE settings SET default_gateway=$1,timeout=$2,retries=$3,logging=$4,history=$5 WHERE id=1 RETURNING *`,
        [s.defaultGateway, s.timeout, s.retries, s.logging, s.history]
      );
      return mapSettings(rows[0]);
    },
    reset: async () => {
      await ensureSchema();
      const { rows } = await pool.query(
        `UPDATE settings SET default_gateway=$1,timeout=$2,retries=$3,logging=$4,history=$5 WHERE id=1 RETURNING *`,
        [DEFAULTS.defaultGateway, DEFAULTS.timeout, DEFAULTS.retries, DEFAULTS.logging, DEFAULTS.history]
      );
      return mapSettings(rows[0]);
    },
  },
};

module.exports = { repos, enc, dec, id };
