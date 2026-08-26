/**
 * Forecourt — dealership stock, enquiry and collection tracking.
 * Cloudflare Worker: JSON API at /api/*, front end served from public/.
 */

import { identify, decodePlate, decodeVin, plateKey, formatPlate } from './lookup.js';
import { estimateValue, stockAdvice } from './valuation.js';

const COOKIE = 'fc_sess';
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000;

const VEHICLE_STATUSES = ['in_stock', 'prep', 'reserved', 'sold', 'archived'];
const ACTIVITY_KINDS = ['viewing', 'call', 'enquiry', 'test_drive', 'offer', 'message', 'note'];
const APPOINTMENT_KINDS = ['viewing', 'test_drive', 'collection', 'delivery', 'valuation'];
const APPOINTMENT_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
const CONDITIONS = ['excellent', 'good', 'fair', 'poor'];

const TEXT_FIELDS = [
  'vin', 'make', 'model', 'variant', 'colour', 'fuel', 'transmission', 'body', 'condition',
  'status', 'location', 'stock_number', 'service_history', 'mot_expiry', 'tax_status',
  'tax_due', 'first_registered', 'region', 'photo', 'notes', 'date_in', 'date_sold', 'buyer_name',
];
const NUMBER_FIELDS = [
  'year', 'engine_cc', 'doors', 'seats', 'co2', 'mileage', 'keys_count',
  'purchase_price', 'asking_price', 'sold_price', 'prep_cost',
];

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (status, message, extra) => {
  throw new HttpError(status, message, extra);
};

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function str(value, max = 500) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function isoDate(value) {
  const s = str(value, 40);
  if (!s) return null;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function dayOnly(value) {
  const iso = isoDate(value);
  return iso ? iso.slice(0, 10) : null;
}

function daysBetween(fromIso, toMs = Date.now()) {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((toMs - t) / 86400000));
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function sessionCookie(token, url, maxAge = SESSION_DAYS * 86400) {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}

/* ------------------------------------------------------------------ *
 * Crypto
 * ------------------------------------------------------------------ */

const enc = new TextEncoder();

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Hex(value) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

async function derive(password, saltHex) {
  const salt = fromHex(saltHex);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(bits);
}

async function hashPassword(password) {
  const saltHex = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return { hash: await derive(password, saltHex), salt: saltHex };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken(bytes = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function joinCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('').replace(/^(.{4})/, '$1-');
}

/* ------------------------------------------------------------------ *
 * Schema bootstrap — keeps deployment to a single command
 * ------------------------------------------------------------------ */

const DDL = [
  `CREATE TABLE IF NOT EXISTS dealerships (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, join_code TEXT NOT NULL UNIQUE,
    country TEXT NOT NULL DEFAULT 'GB', currency TEXT NOT NULL DEFAULT 'GBP',
    distance_unit TEXT NOT NULL DEFAULT 'mi', vat_scheme TEXT NOT NULL DEFAULT 'margin',
    created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, dealership_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_users_dealership ON users(dealership_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, user_agent TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS vehicles (
    id TEXT PRIMARY KEY, dealership_id TEXT NOT NULL, plate TEXT NOT NULL, plate_key TEXT NOT NULL,
    vin TEXT, make TEXT, model TEXT, variant TEXT, year INTEGER, colour TEXT, fuel TEXT,
    transmission TEXT, body TEXT, engine_cc INTEGER, doors INTEGER, seats INTEGER, co2 INTEGER,
    mileage INTEGER, condition TEXT DEFAULT 'good', purchase_price REAL, asking_price REAL,
    sold_price REAL, prep_cost REAL, status TEXT NOT NULL DEFAULT 'in_stock', location TEXT,
    stock_number TEXT, keys_count INTEGER, service_history TEXT, mot_expiry TEXT, tax_status TEXT,
    tax_due TEXT, first_registered TEXT, region TEXT, lookup_source TEXT, lookup_json TEXT,
    photo TEXT, notes TEXT, date_in TEXT, date_sold TEXT, buyer_name TEXT, created_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles(dealership_id, plate_key)`,
  `CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(dealership_id, status)`,
  `CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY, dealership_id TEXT NOT NULL, vehicle_id TEXT NOT NULL, kind TEXT NOT NULL,
    contact_name TEXT, contact_phone TEXT, contact_email TEXT, amount REAL, notes TEXT,
    occurred_at TEXT NOT NULL, user_id TEXT, user_name TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_activities_vehicle ON activities(vehicle_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_activities_dealership ON activities(dealership_id, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY, dealership_id TEXT NOT NULL, vehicle_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'viewing', customer_name TEXT NOT NULL, customer_phone TEXT,
    customer_email TEXT, scheduled_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
    deposit REAL, notes TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_appointments_vehicle ON appointments(vehicle_id, scheduled_at)`,
  `CREATE INDEX IF NOT EXISTS idx_appointments_diary ON appointments(dealership_id, scheduled_at)`,
  `CREATE TABLE IF NOT EXISTS valuations (
    id TEXT PRIMARY KEY, dealership_id TEXT NOT NULL, vehicle_id TEXT NOT NULL, trade_value REAL,
    retail_value REAL, private_value REAL, method TEXT, notes TEXT, user_name TEXT,
    created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_valuations_vehicle ON valuations(vehicle_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS plate_cache (
    plate_key TEXT PRIMARY KEY, payload TEXT NOT NULL, source TEXT, fetched_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

let schemaReady = null;

function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      const found = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='vehicles'",
      ).first();
      if (found) return;
      await env.DB.batch(DDL.map((sql) => env.DB.prepare(sql)));
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

async function currentUser(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.expires_at, s.token_hash, u.id, u.email, u.name, u.role, u.dealership_id, u.created_at,
            d.name AS dealership_name, d.join_code, d.currency, d.distance_unit, d.country, d.vat_scheme
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN dealerships d ON d.id = u.dealership_id
      WHERE s.token_hash = ?`,
  ).bind(await sha256Hex(token)).first();
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(row.token_hash).run();
    return null;
  }
  return row;
}

async function startSession(env, request, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
  ).bind(await sha256Hex(token), userId, nowIso(), expires, str(request.headers.get('user-agent'), 200)).run();
  // Opportunistic cleanup so the table cannot grow without bound.
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso()).run();
  return token;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    dealership: {
      id: user.dealership_id,
      name: user.dealership_name,
      joinCode: user.join_code,
      currency: user.currency,
      distanceUnit: user.distance_unit,
      country: user.country,
      vatScheme: user.vat_scheme,
    },
  };
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
}

/* ------------------------------------------------------------------ *
 * Vehicle helpers
 * ------------------------------------------------------------------ */

function vehiclePatch(body) {
  const patch = {};
  for (const key of TEXT_FIELDS) {
    if (key in body) patch[key] = str(body[key], key === 'notes' || key === 'photo' ? 20000 : 200);
  }
  for (const key of NUMBER_FIELDS) {
    if (key in body) patch[key] = num(body[key]);
  }
  if (patch.status && !VEHICLE_STATUSES.includes(patch.status)) fail(400, 'Unknown status');
  if (patch.condition && !CONDITIONS.includes(patch.condition)) patch.condition = 'good';
  for (const key of ['mot_expiry', 'tax_due', 'first_registered', 'date_in', 'date_sold']) {
    if (key in patch && patch[key]) patch[key] = dayOnly(patch[key]) || null;
  }
  if (patch.vin) patch.vin = patch.vin.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (patch.year !== undefined && patch.year !== null) {
    const y = Math.round(patch.year);
    patch.year = y >= 1900 && y <= new Date().getFullYear() + 2 ? y : null;
  }
  return patch;
}

function decorate(vehicle, user) {
  const stats = {
    viewings: vehicle.viewings || 0,
    calls: vehicle.calls || 0,
    enquiries: vehicle.enquiries || 0,
    daysInStock: daysBetween(vehicle.date_in || vehicle.created_at),
  };
  const estimate = estimateValue(vehicle, {
    currency: user.currency,
    distanceUnit: user.distance_unit,
  });
  const margin = vehicle.asking_price
    ? vehicle.asking_price - (vehicle.purchase_price || 0) - (vehicle.prep_cost || 0)
    : null;
  const profit = vehicle.sold_price
    ? vehicle.sold_price - (vehicle.purchase_price || 0) - (vehicle.prep_cost || 0)
    : null;
  return {
    ...vehicle,
    lookup_json: undefined,
    lookup: vehicle.lookup_json ? safeParse(vehicle.lookup_json) : null,
    stats: { ...stats, interest: stats.viewings + stats.calls + stats.enquiries },
    estimate,
    advice: stockAdvice(vehicle, { ...stats, estimate }),
    margin,
    profit,
  };
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const LIST_SQL = `
  SELECT v.*,
    (SELECT COUNT(*) FROM activities a WHERE a.vehicle_id = v.id AND a.kind = 'viewing') AS viewings,
    (SELECT COUNT(*) FROM activities a WHERE a.vehicle_id = v.id AND a.kind = 'call') AS calls,
    (SELECT COUNT(*) FROM activities a WHERE a.vehicle_id = v.id AND a.kind IN ('enquiry','offer','test_drive','message')) AS enquiries,
    (SELECT MAX(a.occurred_at) FROM activities a WHERE a.vehicle_id = v.id) AS last_activity_at,
    (SELECT COUNT(*) FROM appointments p WHERE p.vehicle_id = v.id AND p.status = 'scheduled') AS booked,
    (SELECT p.scheduled_at FROM appointments p WHERE p.vehicle_id = v.id AND p.status = 'scheduled' ORDER BY p.scheduled_at LIMIT 1) AS next_at,
    (SELECT p.customer_name FROM appointments p WHERE p.vehicle_id = v.id AND p.status = 'scheduled' ORDER BY p.scheduled_at LIMIT 1) AS next_customer,
    (SELECT p.kind FROM appointments p WHERE p.vehicle_id = v.id AND p.status = 'scheduled' ORDER BY p.scheduled_at LIMIT 1) AS next_kind
  FROM vehicles v`;

const SORTS = {
  newest: 'v.created_at DESC',
  oldest: 'v.created_at ASC',
  price_high: 'v.asking_price DESC NULLS LAST',
  price_low: 'v.asking_price ASC NULLS LAST',
  interest: '(viewings + calls + enquiries) DESC',
  age: 'COALESCE(v.date_in, v.created_at) ASC',
  plate: 'v.plate_key ASC',
};

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const routes = [];
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, parts: pattern.split('/').filter(Boolean), handler, auth: opts.auth !== false });

function match(request, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  let methodMismatch = false;
  for (const r of routes) {
    if (r.parts.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const p = r.parts[i];
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]);
      else if (p !== parts[i]) { ok = false; break; }
    }
    if (!ok) continue;
    if (r.method !== request.method) { methodMismatch = true; continue; }
    return { r, params };
  }
  return methodMismatch ? { methodMismatch: true } : null;
}

/* ---------------------------- auth ---------------------------- */

route('POST', '/api/auth/signup', async ({ request, env, url }) => {
  const body = await readJson(request);
  const dealership = str(body.dealership, 120);
  const name = str(body.name, 80);
  const email = str(body.email, 160)?.toLowerCase();
  const password = String(body.password || '');
  if (!dealership) fail(400, 'Add your dealership name');
  if (!name) fail(400, 'Add your name');
  if (!validEmail(email)) fail(400, 'That email address does not look right');
  if (password.length < 8) fail(400, 'Use a password of at least 8 characters');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) fail(409, 'There is already an account with that email — sign in instead');

  const { hash, salt } = await hashPassword(password);
  const dealershipId = uid();
  const userId = uid();
  const created = nowIso();
  const country = str(body.country, 4) || 'GB';
  const currency = str(body.currency, 4) || (country === 'US' ? 'USD' : country === 'GB' ? 'GBP' : 'EUR');

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dealerships (id, name, join_code, country, currency, distance_unit, vat_scheme, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'margin', ?)`,
    ).bind(dealershipId, dealership, joinCode(), country, currency, country === 'GB' || country === 'US' ? 'mi' : 'km', created),
    env.DB.prepare(
      `INSERT INTO users (id, dealership_id, email, name, role, password_hash, password_salt, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, ?)`,
    ).bind(userId, dealershipId, email, name, hash, salt, created, created),
  ]);

  const token = await startSession(env, request, userId);
  const user = await env.DB.prepare(
    `SELECT u.*, d.name AS dealership_name, d.join_code, d.currency, d.distance_unit, d.country, d.vat_scheme
       FROM users u JOIN dealerships d ON d.id = u.dealership_id WHERE u.id = ?`,
  ).bind(userId).first();
  return json({ user: publicUser(user) }, 201, { 'set-cookie': sessionCookie(token, url) });
}, { auth: false });

route('POST', '/api/auth/join', async ({ request, env, url }) => {
  const body = await readJson(request);
  const code = str(body.joinCode, 20)?.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const name = str(body.name, 80);
  const email = str(body.email, 160)?.toLowerCase();
  const password = String(body.password || '');
  if (!code) fail(400, 'Enter the team code from your manager');
  if (!name) fail(400, 'Add your name');
  if (!validEmail(email)) fail(400, 'That email address does not look right');
  if (password.length < 8) fail(400, 'Use a password of at least 8 characters');

  const dealership = await env.DB.prepare(
    "SELECT id FROM dealerships WHERE REPLACE(join_code, '-', '') = ?",
  ).bind(code).first();
  if (!dealership) fail(404, 'That team code was not recognised');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) fail(409, 'There is already an account with that email — sign in instead');

  const { hash, salt } = await hashPassword(password);
  const userId = uid();
  const created = nowIso();
  await env.DB.prepare(
    `INSERT INTO users (id, dealership_id, email, name, role, password_hash, password_salt, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'member', ?, ?, ?, ?)`,
  ).bind(userId, dealership.id, email, name, hash, salt, created, created).run();

  const token = await startSession(env, request, userId);
  const user = await env.DB.prepare(
    `SELECT u.*, d.name AS dealership_name, d.join_code, d.currency, d.distance_unit, d.country, d.vat_scheme
       FROM users u JOIN dealerships d ON d.id = u.dealership_id WHERE u.id = ?`,
  ).bind(userId).first();
  return json({ user: publicUser(user) }, 201, { 'set-cookie': sessionCookie(token, url) });
}, { auth: false });

route('POST', '/api/auth/login', async ({ request, env, url }) => {
  const body = await readJson(request);
  const email = str(body.email, 160)?.toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) fail(400, 'Enter your email and password');

  const user = await env.DB.prepare(
    `SELECT u.*, d.name AS dealership_name, d.join_code, d.currency, d.distance_unit, d.country, d.vat_scheme
       FROM users u JOIN dealerships d ON d.id = u.dealership_id WHERE u.email = ?`,
  ).bind(email).first();
  if (!user) {
    // Spend the same time as a real check so the response cannot be timed.
    await derive(password, toHex(new Uint8Array(16)));
    fail(401, 'Email or password is wrong');
  }
  const candidate = await derive(password, user.password_salt);
  if (!timingSafeEqual(candidate, user.password_hash)) fail(401, 'Email or password is wrong');

  await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(nowIso(), user.id).run();
  const token = await startSession(env, request, user.id);
  return json({ user: publicUser(user) }, 200, { 'set-cookie': sessionCookie(token, url) });
}, { auth: false });

route('POST', '/api/auth/logout', async ({ request, env, url }) => {
  const token = readCookie(request, COOKIE);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', url, 0) });
}, { auth: false });

route('GET', '/api/me', async ({ user }) => json({ user: publicUser(user) }));

route('PATCH', '/api/me', async ({ request, env, user }) => {
  const body = await readJson(request);
  const patch = {};
  if (body.name) patch.name = str(body.name, 80);
  if (body.email) {
    const email = str(body.email, 160).toLowerCase();
    if (!validEmail(email)) fail(400, 'That email address does not look right');
    const clash = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
      .bind(email, user.id).first();
    if (clash) fail(409, 'Another account already uses that email');
    patch.email = email;
  }
  if (!Object.keys(patch).length) fail(400, 'Nothing to update');
  await env.DB.prepare(
    `UPDATE users SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
  ).bind(...Object.values(patch), user.id).run();
  const row = await env.DB.prepare(
    `SELECT u.*, d.name AS dealership_name, d.join_code, d.currency, d.distance_unit, d.country, d.vat_scheme
       FROM users u JOIN dealerships d ON d.id = u.dealership_id WHERE u.id = ?`,
  ).bind(user.id).first();
  return json({ user: publicUser(row) });
});

route('POST', '/api/me/password', async ({ request, env, user }) => {
  const body = await readJson(request);
  const current = String(body.currentPassword || '');
  const next = String(body.newPassword || '');
  if (next.length < 8) fail(400, 'Use a password of at least 8 characters');
  const row = await env.DB.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').bind(user.id).first();
  const candidate = await derive(current, row.password_salt);
  if (!timingSafeEqual(candidate, row.password_hash)) fail(401, 'Current password is wrong');
  const { hash, salt } = await hashPassword(next);
  await env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
    .bind(hash, salt, user.id).run();
  return json({ ok: true });
});

/* ---------------------------- lookup ---------------------------- */

route('GET', '/api/lookup', async ({ env, url, user }) => {
  const plate = url.searchParams.get('plate') || '';
  const vin = url.searchParams.get('vin') || '';
  if (!plate && !vin) fail(400, 'Enter a registration or a VIN');
  const key = plateKey(plate);

  const existing = key
    ? await env.DB.prepare(
        'SELECT id, plate, make, model, year, status FROM vehicles WHERE dealership_id = ? AND plate_key = ?',
      ).bind(user.dealership_id, key).first()
    : null;

  const result = vin && !plate
    ? await (async () => {
        const data = await decodeVin(vin);
        return {
          plate: '',
          plateKey: '',
          fields: data || {},
          decoded: { scheme: 'vin', note: data ? 'Decoded from VIN.' : 'VIN not recognised.' },
          sources: data ? ['NHTSA VIN database'] : [],
          identified: Boolean(data),
        };
      })()
    : await identify(env, plate, vin);

  return json({ ...result, alreadyInStock: existing || null });
});

route('POST', '/api/valuation', async ({ request, user }) => {
  const body = await readJson(request);
  const estimate = estimateValue(vehiclePatch(body), {
    currency: user.currency,
    distanceUnit: user.distance_unit,
  });
  return json({ estimate });
});

/* ---------------------------- vehicles ---------------------------- */

route('GET', '/api/vehicles', async ({ env, url, user }) => {
  const status = url.searchParams.get('status');
  const q = str(url.searchParams.get('q'), 80);
  const sort = SORTS[url.searchParams.get('sort')] || SORTS.newest;
  const where = ['v.dealership_id = ?'];
  const binds = [user.dealership_id];

  if (status && status !== 'all') {
    if (status === 'live') where.push("v.status IN ('in_stock','prep','reserved')");
    else {
      where.push('v.status = ?');
      binds.push(status);
    }
  } else {
    where.push("v.status != 'archived'");
  }

  if (q) {
    const like = `%${q.toUpperCase()}%`;
    where.push(`(v.plate_key LIKE ? OR UPPER(COALESCE(v.make,'')) LIKE ? OR UPPER(COALESCE(v.model,'')) LIKE ?
      OR UPPER(COALESCE(v.stock_number,'')) LIKE ? OR UPPER(COALESCE(v.colour,'')) LIKE ?
      OR UPPER(COALESCE(v.vin,'')) LIKE ?)`);
    binds.push(like.replace(/[^A-Z0-9%]/g, ''), like, like, like, like, like);
  }

  const { results } = await env.DB.prepare(
    `${LIST_SQL} WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT 500`,
  ).bind(...binds).all();

  return json({ vehicles: (results || []).map((v) => decorate(v, user)) });
});

route('POST', '/api/vehicles', async ({ request, env, user }) => {
  const body = await readJson(request);
  const plate = str(body.plate, 20);
  if (!plate) fail(400, 'A registration is needed to add a vehicle');
  const key = plateKey(plate);
  if (!key) fail(400, 'That registration does not look right');

  const clash = await env.DB.prepare(
    'SELECT id FROM vehicles WHERE dealership_id = ? AND plate_key = ?',
  ).bind(user.dealership_id, key).first();
  if (clash) fail(409, 'That registration is already in your stock', { vehicleId: clash.id });

  const patch = vehiclePatch(body);
  const decoded = decodePlate(key);
  const created = nowIso();
  const id = uid();

  const record = {
    id,
    dealership_id: user.dealership_id,
    plate: formatPlate(key),
    plate_key: key,
    status: patch.status || 'in_stock',
    condition: patch.condition || 'good',
    date_in: patch.date_in || created.slice(0, 10),
    region: patch.region || (decoded.region ? `${decoded.region}${decoded.issuedAt ? ` (${decoded.issuedAt})` : ''}` : null),
    year: patch.year ?? decoded.year ?? null,
    first_registered: patch.first_registered || decoded.registeredFrom || null,
    lookup_source: str(body.lookupSource, 60),
    lookup_json: body.lookup ? JSON.stringify(body.lookup).slice(0, 8000) : null,
    created_by: user.id,
    created_at: created,
    updated_at: created,
  };
  for (const [k, v] of Object.entries(patch)) {
    if (['status', 'condition', 'date_in', 'region', 'year', 'first_registered'].includes(k)) continue;
    record[k] = v;
  }

  const cols = Object.keys(record);
  await env.DB.prepare(
    `INSERT INTO vehicles (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).bind(...cols.map((c) => record[c] ?? null)).run();

  const vehicle = await loadVehicle(env, user, id);
  return json({ vehicle }, 201);
});

async function loadVehicle(env, user, id) {
  const row = await env.DB.prepare(`${LIST_SQL} WHERE v.dealership_id = ? AND v.id = ?`)
    .bind(user.dealership_id, id).first();
  if (!row) fail(404, 'Vehicle not found');
  return decorate(row, user);
}

route('GET', '/api/vehicles/:id', async ({ env, params, user }) => {
  const vehicle = await loadVehicle(env, user, params.id);
  const [activities, appointments, valuations] = await Promise.all([
    env.DB.prepare('SELECT * FROM activities WHERE vehicle_id = ? ORDER BY occurred_at DESC LIMIT 200')
      .bind(params.id).all(),
    env.DB.prepare('SELECT * FROM appointments WHERE vehicle_id = ? ORDER BY scheduled_at DESC LIMIT 200')
      .bind(params.id).all(),
    env.DB.prepare('SELECT * FROM valuations WHERE vehicle_id = ? ORDER BY created_at DESC LIMIT 50')
      .bind(params.id).all(),
  ]);
  return json({
    vehicle,
    activities: activities.results || [],
    appointments: appointments.results || [],
    valuations: valuations.results || [],
  });
});

route('PATCH', '/api/vehicles/:id', async ({ request, env, params, user }) => {
  const body = await readJson(request);
  const existing = await env.DB.prepare('SELECT * FROM vehicles WHERE dealership_id = ? AND id = ?')
    .bind(user.dealership_id, params.id).first();
  if (!existing) fail(404, 'Vehicle not found');

  const patch = vehiclePatch(body);
  if ('plate' in body) {
    const key = plateKey(body.plate);
    if (!key) fail(400, 'That registration does not look right');
    if (key !== existing.plate_key) {
      const clash = await env.DB.prepare(
        'SELECT id FROM vehicles WHERE dealership_id = ? AND plate_key = ? AND id != ?',
      ).bind(user.dealership_id, key, params.id).first();
      if (clash) fail(409, 'Another vehicle in your stock already has that registration');
      patch.plate = formatPlate(key);
      patch.plate_key = key;
    }
  }

  // Selling a car fills in the obvious blanks.
  if (patch.status === 'sold' && existing.status !== 'sold') {
    if (!patch.date_sold && !existing.date_sold) patch.date_sold = nowIso().slice(0, 10);
    if (patch.sold_price === undefined && existing.sold_price === null) {
      patch.sold_price = existing.asking_price;
    }
  }
  if (patch.status && patch.status !== 'sold') {
    if (existing.status === 'sold') {
      patch.date_sold = null;
      patch.sold_price = null;
    }
  }

  const entries = Object.entries(patch);
  if (!entries.length) return json({ vehicle: await loadVehicle(env, user, params.id) });
  entries.push(['updated_at', nowIso()]);

  await env.DB.prepare(
    `UPDATE vehicles SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ? AND dealership_id = ?`,
  ).bind(...entries.map(([, v]) => (v === undefined ? null : v)), params.id, user.dealership_id).run();

  // A price move is worth remembering.
  if (patch.asking_price !== undefined && patch.asking_price !== existing.asking_price && existing.asking_price) {
    await env.DB.prepare(
      `INSERT INTO activities (id, dealership_id, vehicle_id, kind, notes, occurred_at, user_id, user_name, created_at)
       VALUES (?, ?, ?, 'note', ?, ?, ?, ?, ?)`,
    ).bind(
      uid(), user.dealership_id, params.id,
      `Price changed from ${Math.round(existing.asking_price).toLocaleString()} to ${Math.round(patch.asking_price || 0).toLocaleString()}`,
      nowIso(), user.id, user.name, nowIso(),
    ).run();
  }

  return json({ vehicle: await loadVehicle(env, user, params.id) });
});

route('DELETE', '/api/vehicles/:id', async ({ env, params, user }) => {
  const existing = await env.DB.prepare('SELECT id FROM vehicles WHERE dealership_id = ? AND id = ?')
    .bind(user.dealership_id, params.id).first();
  if (!existing) fail(404, 'Vehicle not found');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM activities WHERE vehicle_id = ?').bind(params.id),
    env.DB.prepare('DELETE FROM appointments WHERE vehicle_id = ?').bind(params.id),
    env.DB.prepare('DELETE FROM valuations WHERE vehicle_id = ?').bind(params.id),
    env.DB.prepare('DELETE FROM vehicles WHERE id = ? AND dealership_id = ?').bind(params.id, user.dealership_id),
  ]);
  return json({ ok: true });
});

/* ---------------------------- activity ---------------------------- */

route('POST', '/api/vehicles/:id/activities', async ({ request, env, params, user }) => {
  const body = await readJson(request);
  const kind = str(body.kind, 20);
  if (!ACTIVITY_KINDS.includes(kind)) fail(400, 'Unknown activity type');
  const owned = await env.DB.prepare('SELECT id FROM vehicles WHERE id = ? AND dealership_id = ?')
    .bind(params.id, user.dealership_id).first();
  if (!owned) fail(404, 'Vehicle not found');

  const id = uid();
  const created = nowIso();
  await env.DB.prepare(
    `INSERT INTO activities (id, dealership_id, vehicle_id, kind, contact_name, contact_phone, contact_email,
      amount, notes, occurred_at, user_id, user_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, user.dealership_id, params.id, kind,
    str(body.contactName, 120), str(body.contactPhone, 40), str(body.contactEmail, 160),
    num(body.amount), str(body.notes, 2000), isoDate(body.occurredAt) || created,
    user.id, user.name, created,
  ).run();

  const activity = await env.DB.prepare('SELECT * FROM activities WHERE id = ?').bind(id).first();
  return json({ activity, vehicle: await loadVehicle(env, user, params.id) }, 201);
});

route('DELETE', '/api/activities/:id', async ({ env, params, user }) => {
  const res = await env.DB.prepare('DELETE FROM activities WHERE id = ? AND dealership_id = ?')
    .bind(params.id, user.dealership_id).run();
  if (!res.meta.changes) fail(404, 'Activity not found');
  return json({ ok: true });
});

/* ---------------------------- appointments ---------------------------- */

route('POST', '/api/vehicles/:id/appointments', async ({ request, env, params, user }) => {
  const body = await readJson(request);
  const kind = str(body.kind, 20) || 'viewing';
  if (!APPOINTMENT_KINDS.includes(kind)) fail(400, 'Unknown appointment type');
  const customer = str(body.customerName, 120);
  const scheduled = isoDate(body.scheduledAt);
  if (!customer) fail(400, 'Who is coming in?');
  if (!scheduled) fail(400, 'Pick a date and time');
  const owned = await env.DB.prepare('SELECT id FROM vehicles WHERE id = ? AND dealership_id = ?')
    .bind(params.id, user.dealership_id).first();
  if (!owned) fail(404, 'Vehicle not found');

  const id = uid();
  const created = nowIso();
  await env.DB.prepare(
    `INSERT INTO appointments (id, dealership_id, vehicle_id, kind, customer_name, customer_phone,
      customer_email, scheduled_at, status, deposit, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`,
  ).bind(
    id, user.dealership_id, params.id, kind, customer,
    str(body.customerPhone, 40), str(body.customerEmail, 160), scheduled,
    num(body.deposit), str(body.notes, 2000), user.id, created, created,
  ).run();

  // A booked collection means the car is spoken for.
  if ((kind === 'collection' || kind === 'delivery') && num(body.deposit)) {
    await env.DB.prepare(
      "UPDATE vehicles SET status = 'reserved', buyer_name = ?, updated_at = ? WHERE id = ? AND status IN ('in_stock','prep')",
    ).bind(customer, created, params.id).run();
  }

  const appointment = await env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first();
  return json({ appointment, vehicle: await loadVehicle(env, user, params.id) }, 201);
});

route('PATCH', '/api/appointments/:id', async ({ request, env, params, user }) => {
  const body = await readJson(request);
  const existing = await env.DB.prepare('SELECT * FROM appointments WHERE id = ? AND dealership_id = ?')
    .bind(params.id, user.dealership_id).first();
  if (!existing) fail(404, 'Appointment not found');

  const patch = {};
  if ('status' in body) {
    if (!APPOINTMENT_STATUSES.includes(body.status)) fail(400, 'Unknown appointment status');
    patch.status = body.status;
  }
  if ('kind' in body && APPOINTMENT_KINDS.includes(body.kind)) patch.kind = body.kind;
  if ('customerName' in body) patch.customer_name = str(body.customerName, 120) || existing.customer_name;
  if ('customerPhone' in body) patch.customer_phone = str(body.customerPhone, 40);
  if ('customerEmail' in body) patch.customer_email = str(body.customerEmail, 160);
  if ('scheduledAt' in body) patch.scheduled_at = isoDate(body.scheduledAt) || existing.scheduled_at;
  if ('deposit' in body) patch.deposit = num(body.deposit);
  if ('notes' in body) patch.notes = str(body.notes, 2000);
  if (!Object.keys(patch).length) fail(400, 'Nothing to update');
  patch.updated_at = nowIso();

  await env.DB.prepare(
    `UPDATE appointments SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND dealership_id = ?`,
  ).bind(...Object.values(patch), params.id, user.dealership_id).run();

  // A completed viewing is also a viewing that happened.
  if (patch.status === 'completed' && existing.status !== 'completed') {
    const kindMap = { viewing: 'viewing', test_drive: 'test_drive', valuation: 'note', collection: 'note', delivery: 'note' };
    await env.DB.prepare(
      `INSERT INTO activities (id, dealership_id, vehicle_id, kind, contact_name, contact_phone, contact_email,
        notes, occurred_at, user_id, user_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      uid(), user.dealership_id, existing.vehicle_id, kindMap[existing.kind] || 'note',
      existing.customer_name, existing.customer_phone, existing.customer_email,
      `${existing.kind.replace('_', ' ')} completed`, nowIso(), user.id, user.name, nowIso(),
    ).run();
  }

  const appointment = await env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(params.id).first();
  return json({ appointment, vehicle: await loadVehicle(env, user, existing.vehicle_id) });
});

route('DELETE', '/api/appointments/:id', async ({ env, params, user }) => {
  const res = await env.DB.prepare('DELETE FROM appointments WHERE id = ? AND dealership_id = ?')
    .bind(params.id, user.dealership_id).run();
  if (!res.meta.changes) fail(404, 'Appointment not found');
  return json({ ok: true });
});

route('GET', '/api/appointments', async ({ env, url, user }) => {
  const from = isoDate(url.searchParams.get('from')) || new Date(Date.now() - 86400000).toISOString();
  const to = isoDate(url.searchParams.get('to')) || new Date(Date.now() + 60 * 86400000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT p.*, v.plate, v.make, v.model, v.year, v.asking_price
       FROM appointments p JOIN vehicles v ON v.id = p.vehicle_id
      WHERE p.dealership_id = ? AND p.scheduled_at BETWEEN ? AND ?
      ORDER BY p.scheduled_at ASC LIMIT 400`,
  ).bind(user.dealership_id, from, to).all();
  return json({ appointments: results || [] });
});

/* ---------------------------- valuations ---------------------------- */

route('POST', '/api/vehicles/:id/valuations', async ({ request, env, params, user }) => {
  const body = await readJson(request);
  const owned = await env.DB.prepare('SELECT * FROM vehicles WHERE id = ? AND dealership_id = ?')
    .bind(params.id, user.dealership_id).first();
  if (!owned) fail(404, 'Vehicle not found');
  const estimate = estimateValue(owned, { currency: user.currency, distanceUnit: user.distance_unit });
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO valuations (id, dealership_id, vehicle_id, trade_value, retail_value, private_value,
      method, notes, user_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, user.dealership_id, params.id,
    num(body.tradeValue) ?? estimate.trade,
    num(body.retailValue) ?? estimate.retail,
    num(body.privateValue) ?? estimate.private,
    str(body.method, 60) || (body.retailValue ? 'Manual' : estimate.method),
    str(body.notes, 1000), user.name, nowIso(),
  ).run();
  const { results } = await env.DB.prepare(
    'SELECT * FROM valuations WHERE vehicle_id = ? ORDER BY created_at DESC LIMIT 50',
  ).bind(params.id).all();
  return json({ valuations: results || [] }, 201);
});

/* ---------------------------- dashboard ---------------------------- */

route('GET', '/api/dashboard', async ({ env, user }) => {
  const d = user.dealership_id;
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const weekAhead = new Date(now.getTime() + 7 * 86400000).toISOString();

  const [stock, activity, sold, upcoming, hot, aging, feed] = await Promise.all([
    env.DB.prepare(
      `SELECT status, COUNT(*) AS n, SUM(COALESCE(asking_price,0)) AS asking,
              SUM(COALESCE(purchase_price,0) + COALESCE(prep_cost,0)) AS invested,
              AVG(julianday('now') - julianday(COALESCE(date_in, created_at))) AS avg_days
         FROM vehicles WHERE dealership_id = ? GROUP BY status`,
    ).bind(d).all(),
    env.DB.prepare(
      `SELECT kind, COUNT(*) AS n FROM activities
        WHERE dealership_id = ? AND occurred_at >= ? GROUP BY kind`,
    ).bind(d, weekAgo).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(COALESCE(sold_price,0)) AS revenue,
              SUM(COALESCE(sold_price,0) - COALESCE(purchase_price,0) - COALESCE(prep_cost,0)) AS profit
         FROM vehicles WHERE dealership_id = ? AND status = 'sold' AND COALESCE(date_sold, updated_at) >= ?`,
    ).bind(d, monthStart.slice(0, 10)).first(),
    env.DB.prepare(
      `SELECT p.*, v.plate, v.make, v.model, v.year
         FROM appointments p JOIN vehicles v ON v.id = p.vehicle_id
        WHERE p.dealership_id = ? AND p.status = 'scheduled' AND p.scheduled_at >= ?
        ORDER BY p.scheduled_at ASC LIMIT 12`,
    ).bind(d, dayStart).all(),
    env.DB.prepare(
      `SELECT v.id, v.plate, v.make, v.model, v.year, v.asking_price, v.status,
              COUNT(a.id) AS interest
         FROM vehicles v JOIN activities a ON a.vehicle_id = v.id
        WHERE v.dealership_id = ? AND a.occurred_at >= ? AND v.status IN ('in_stock','prep','reserved')
        GROUP BY v.id ORDER BY interest DESC LIMIT 5`,
    ).bind(d, new Date(now.getTime() - 14 * 86400000).toISOString()).all(),
    env.DB.prepare(
      `SELECT v.id, v.plate, v.make, v.model, v.year, v.asking_price,
              CAST(julianday('now') - julianday(COALESCE(v.date_in, v.created_at)) AS INTEGER) AS days,
              (SELECT COUNT(*) FROM activities a WHERE a.vehicle_id = v.id) AS interest
         FROM vehicles v
        WHERE v.dealership_id = ? AND v.status IN ('in_stock','prep')
        ORDER BY days DESC LIMIT 5`,
    ).bind(d).all(),
    env.DB.prepare(
      `SELECT a.*, v.plate, v.make, v.model
         FROM activities a JOIN vehicles v ON v.id = a.vehicle_id
        WHERE a.dealership_id = ? ORDER BY a.occurred_at DESC LIMIT 15`,
    ).bind(d).all(),
  ]);

  const byStatus = {};
  let liveCount = 0;
  let stockValue = 0;
  let invested = 0;
  let avgDaysWeighted = 0;
  for (const row of stock.results || []) {
    byStatus[row.status] = { count: row.n, asking: row.asking || 0, invested: row.invested || 0 };
    if (['in_stock', 'prep', 'reserved'].includes(row.status)) {
      liveCount += row.n;
      stockValue += row.asking || 0;
      invested += row.invested || 0;
      avgDaysWeighted += (row.avg_days || 0) * row.n;
    }
  }

  const activityCounts = {};
  for (const row of activity.results || []) activityCounts[row.kind] = row.n;

  const appointmentsToday = (upcoming.results || []).filter(
    (a) => a.scheduled_at >= dayStart && a.scheduled_at < new Date(Date.parse(dayStart) + 86400000).toISOString(),
  ).length;

  return json({
    stock: {
      live: liveCount,
      byStatus,
      value: Math.round(stockValue),
      invested: Math.round(invested),
      avgDays: liveCount ? Math.round(avgDaysWeighted / liveCount) : 0,
    },
    week: {
      viewings: activityCounts.viewing || 0,
      calls: activityCounts.call || 0,
      enquiries: (activityCounts.enquiry || 0) + (activityCounts.message || 0),
      testDrives: activityCounts.test_drive || 0,
      offers: activityCounts.offer || 0,
    },
    month: {
      sold: sold?.n || 0,
      revenue: Math.round(sold?.revenue || 0),
      profit: Math.round(sold?.profit || 0),
    },
    appointments: { today: appointmentsToday, upcoming: upcoming.results || [], weekAhead },
    hot: hot.results || [],
    aging: aging.results || [],
    feed: feed.results || [],
  });
});

/* ---------------------------- team & settings ---------------------------- */

route('GET', '/api/team', async ({ env, user }) => {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.created_at, u.last_seen_at,
            (SELECT COUNT(*) FROM activities a WHERE a.user_id = u.id) AS logged
       FROM users u WHERE u.dealership_id = ? ORDER BY u.created_at ASC`,
  ).bind(user.dealership_id).all();
  return json({ team: results || [], joinCode: user.join_code });
});

route('PATCH', '/api/team/:id', async ({ request, env, params, user }) => {
  if (user.role !== 'owner') fail(403, 'Only the account owner can change roles');
  const body = await readJson(request);
  const role = body.role === 'owner' ? 'owner' : 'member';
  if (params.id === user.id && role !== 'owner') fail(400, 'You cannot remove your own owner access');
  const res = await env.DB.prepare('UPDATE users SET role = ? WHERE id = ? AND dealership_id = ?')
    .bind(role, params.id, user.dealership_id).run();
  if (!res.meta.changes) fail(404, 'Team member not found');
  return json({ ok: true });
});

route('DELETE', '/api/team/:id', async ({ env, params, user }) => {
  if (user.role !== 'owner') fail(403, 'Only the account owner can remove people');
  if (params.id === user.id) fail(400, 'You cannot remove yourself');
  const member = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND dealership_id = ?')
    .bind(params.id, user.dealership_id).first();
  if (!member) fail(404, 'Team member not found');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(params.id),
    env.DB.prepare('DELETE FROM users WHERE id = ? AND dealership_id = ?').bind(params.id, user.dealership_id),
  ]);
  return json({ ok: true });
});

route('POST', '/api/team/code', async ({ env, user }) => {
  if (user.role !== 'owner') fail(403, 'Only the account owner can reset the team code');
  const code = joinCode();
  await env.DB.prepare('UPDATE dealerships SET join_code = ? WHERE id = ?').bind(code, user.dealership_id).run();
  return json({ joinCode: code });
});

route('PATCH', '/api/settings', async ({ request, env, user }) => {
  if (user.role !== 'owner') fail(403, 'Only the account owner can change these settings');
  const body = await readJson(request);
  const patch = {};
  if (body.name) patch.name = str(body.name, 120);
  if (body.currency) patch.currency = str(body.currency, 4).toUpperCase();
  if (body.country) patch.country = str(body.country, 4).toUpperCase();
  if (body.distanceUnit) patch.distance_unit = body.distanceUnit === 'km' ? 'km' : 'mi';
  if (body.vatScheme) patch.vat_scheme = ['margin', 'qualifying', 'none'].includes(body.vatScheme) ? body.vatScheme : 'margin';
  if (!Object.keys(patch).length) fail(400, 'Nothing to update');
  await env.DB.prepare(
    `UPDATE dealerships SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
  ).bind(...Object.values(patch), user.dealership_id).run();
  const row = await env.DB.prepare(
    `SELECT u.*, d.name AS dealership_name, d.join_code, d.currency, d.distance_unit, d.country, d.vat_scheme
       FROM users u JOIN dealerships d ON d.id = u.dealership_id WHERE u.id = ?`,
  ).bind(user.id).first();
  return json({ user: publicUser(row) });
});

/* ---------------------------- export ---------------------------- */

route('GET', '/api/export/stock.csv', async ({ env, user }) => {
  const { results } = await env.DB.prepare(`${LIST_SQL} WHERE v.dealership_id = ? ORDER BY v.created_at DESC`)
    .bind(user.dealership_id).all();
  const cols = [
    'plate', 'stock_number', 'make', 'model', 'variant', 'year', 'colour', 'fuel', 'transmission',
    'mileage', 'status', 'purchase_price', 'prep_cost', 'asking_price', 'sold_price', 'date_in',
    'date_sold', 'buyer_name', 'location', 'mot_expiry', 'vin',
  ];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [[...cols, 'viewings', 'calls', 'enquiries', 'days_in_stock', 'guide_retail'].join(',')];
  for (const v of results || []) {
    const est = estimateValue(v, { currency: user.currency, distanceUnit: user.distance_unit });
    lines.push([
      ...cols.map((c) => escape(v[c])),
      v.viewings, v.calls, v.enquiries,
      daysBetween(v.date_in || v.created_at), est.retail,
    ].join(','));
  }
  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="forecourt-stock-${nowIso().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
});

/* ---------------------------- demo data ---------------------------- */

route('POST', '/api/demo', async ({ env, user }) => {
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM vehicles WHERE dealership_id = ?')
    .bind(user.dealership_id).first();
  if (count.n > 0) fail(400, 'Sample stock can only be added to an empty account');

  const now = Date.now();
  const samples = [
    ['LT20XYZ', 'Volkswagen', 'Golf', 'Life TSI 1.5', 2020, 'Grey', 'Petrol', 'Manual', 'Hatchback', 1498, 34210, 13495, 10800, 'in_stock', 96],
    ['MA68KDR', 'BMW', '320d', 'M Sport Touring', 2018, 'Black', 'Diesel', 'Automatic', 'Estate', 1995, 68400, 15995, 12750, 'in_stock', 41],
    ['YB21WNP', 'Ford', 'Puma', 'ST-Line X', 2021, 'Blue', 'Petrol', 'Manual', 'SUV', 999, 22980, 15750, 13200, 'reserved', 18],
    ['SK17FGH', 'Audi', 'A4', 'S Line TDI', 2017, 'White', 'Diesel', 'Automatic', 'Saloon', 1968, 89250, 11450, 8900, 'in_stock', 74],
    ['LR69TMA', 'Toyota', 'Yaris', 'Icon Hybrid', 2019, 'Red', 'Hybrid', 'Automatic', 'Hatchback', 1490, 41100, 11250, 9100, 'in_stock', 9],
    ['BD23OLV', 'Tesla', 'Model 3', 'Long Range', 2023, 'White', 'Electric', 'Automatic', 'Saloon', null, 18400, 26950, 23500, 'prep', 4],
  ];

  const statements = [];
  const vehicleIds = [];
  for (const [plate, make, model, variant, year, colour, fuel, transmission, body, cc, mileage, asking, purchase, status, days] of samples) {
    const id = uid();
    vehicleIds.push({ id, days, status });
    const dateIn = new Date(now - days * 86400000).toISOString().slice(0, 10);
    const created = new Date(now - days * 86400000).toISOString();
    statements.push(env.DB.prepare(
      `INSERT INTO vehicles (id, dealership_id, plate, plate_key, make, model, variant, year, colour, fuel,
        transmission, body, engine_cc, mileage, condition, purchase_price, asking_price, status, date_in,
        stock_number, location, service_history, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'good', ?, ?, ?, ?, ?, 'Main forecourt', 'Full service history', ?, ?, ?)`,
    ).bind(
      id, user.dealership_id, formatPlate(plate), plateKey(plate), make, model, variant, year, colour, fuel,
      transmission, body, cc, mileage, purchase, asking, status, dateIn,
      `S${1000 + vehicleIds.length}`, user.id, created, created,
    ));
  }

  const names = ['Dave Harris', 'Priya Shah', 'Tom Nolan', 'Grace Bennett', 'Marcus Reid', 'Ellie Fry'];
  const kinds = ['viewing', 'call', 'enquiry', 'call', 'viewing', 'test_drive', 'offer'];
  vehicleIds.forEach((v, i) => {
    const events = Math.min(9, 2 + ((i * 3) % 8));
    for (let e = 0; e < events; e++) {
      const kind = kinds[(i + e) % kinds.length];
      const at = new Date(now - Math.max(1, v.days - e * 2) * 86400000 + e * 3600000).toISOString();
      statements.push(env.DB.prepare(
        `INSERT INTO activities (id, dealership_id, vehicle_id, kind, contact_name, contact_phone, amount,
          notes, occurred_at, user_id, user_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uid(), user.dealership_id, v.id, kind, names[(i + e) % names.length],
        `07${700 + ((i * 7 + e) % 99)} ${100000 + ((i * 13 + e * 7) % 899999)}`,
        kind === 'offer' ? 11800 + i * 250 : null,
        kind === 'call' ? 'Asked about the service history' : kind === 'offer' ? 'Cash today, no part-ex' : null,
        at, user.id, user.name, at,
      ));
    }
  });

  const soon = (h) => new Date(now + h * 3600000).toISOString();
  statements.push(env.DB.prepare(
    `INSERT INTO appointments (id, dealership_id, vehicle_id, kind, customer_name, customer_phone,
      scheduled_at, status, deposit, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'collection', 'Priya Shah', '07700 900123', ?, 'scheduled', 500, 'Paying balance on collection', ?, ?, ?)`,
  ).bind(uid(), user.dealership_id, vehicleIds[2].id, soon(26), user.id, nowIso(), nowIso()));
  statements.push(env.DB.prepare(
    `INSERT INTO appointments (id, dealership_id, vehicle_id, kind, customer_name, customer_phone,
      scheduled_at, status, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'viewing', 'Tom Nolan', '07700 900456', ?, 'scheduled', 'Coming after work', ?, ?, ?)`,
  ).bind(uid(), user.dealership_id, vehicleIds[1].id, soon(5), user.id, nowIso(), nowIso()));
  statements.push(env.DB.prepare(
    `INSERT INTO appointments (id, dealership_id, vehicle_id, kind, customer_name, customer_phone,
      scheduled_at, status, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'test_drive', 'Grace Bennett', '07700 900789', ?, 'scheduled', 'Bringing licence', ?, ?, ?)`,
  ).bind(uid(), user.dealership_id, vehicleIds[0].id, soon(51), user.id, nowIso(), nowIso()));

  await env.DB.batch(statements);
  return json({ ok: true, added: samples.length }, 201);
});

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { allow: 'GET, POST, PATCH, DELETE, OPTIONS' } });
    }

    try {
      if (!env.DB) {
        return json({
          error: 'No database is bound to this Worker. Run `npm run setup`, or create a D1 database and put its id in wrangler.toml.',
        }, 503);
      }
      await ensureSchema(env);

      const found = match(request, url);
      if (!found) return json({ error: 'Not found' }, 404);
      if (found.methodMismatch) return json({ error: 'Method not allowed' }, 405);

      // Same-origin guard for anything that writes.
      if (request.method !== 'GET') {
        const origin = request.headers.get('origin');
        if (origin && new URL(origin).host !== url.host) {
          return json({ error: 'Cross-origin requests are not allowed' }, 403);
        }
      }

      let user = null;
      if (found.r.auth) {
        user = await currentUser(request, env);
        if (!user) return json({ error: 'Sign in to continue' }, 401);
        ctx.waitUntil(
          env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(nowIso(), user.id).run(),
        );
      }

      return await found.r.handler({ request, env, ctx, url, params: found.params, user });
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message, ...(err.extra || {}) }, err.status);
      }
      console.error('Unhandled error', err && err.stack ? err.stack : err);
      return json({ error: 'Something went wrong on our side. Try again.' }, 500);
    }
  },
};
