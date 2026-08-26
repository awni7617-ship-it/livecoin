/**
 * Local backend for the standalone build.
 *
 * Answers exactly the same routes as the Worker, with the same JSON shapes, but
 * against localStorage instead of D1 — so the front end is byte-for-byte the
 * same code in both builds. Everything stays on the device that opened the page.
 *
 * Loaded only by `npm run standalone`; the deployed app never sees it.
 */

const STORE_KEY = 'forecourt-store-v1';
const SESSION_KEY = 'forecourt-session-v1';

const nowIso = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

function blank() {
  return { dealership: null, users: [], vehicles: [], activities: [], appointments: [], valuations: [] };
}

/**
 * Private browsing, blocked site data or a full quota all make localStorage
 * throw. Rather than dying, fall back to memory for the session and raise a
 * flag so the page can warn that nothing is being kept.
 */
const memory = new Map();
let ephemeral = false;

function getItem(key) {
  if (!ephemeral) {
    try {
      return localStorage.getItem(key);
    } catch {
      ephemeral = true;
      globalThis.FORECOURT_EPHEMERAL = true;
    }
  }
  return memory.has(key) ? memory.get(key) : null;
}

function setItem(key, value) {
  if (!ephemeral) {
    try {
      localStorage.setItem(key, value);
      return;
    } catch {
      ephemeral = true;
      globalThis.FORECOURT_EPHEMERAL = true;
    }
  }
  memory.set(key, value);
}

function removeItem(key) {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch { /* nothing to do */ }
}

function load() {
  try {
    const raw = getItem(STORE_KEY);
    return raw ? { ...blank(), ...JSON.parse(raw) } : blank();
  } catch {
    return blank();
  }
}

function save(db) {
  setItem(STORE_KEY, JSON.stringify(db));
}

class ApiError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (status, message, extra) => {
  throw new ApiError(status, message, extra);
};

async function hash(text) {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`forecourt:${text}`));
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const str = (v, max = 500) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const dayOnly = (v) => {
  const s = str(v, 40);
  if (!s) return null;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

const isoDate = (v) => {
  const s = str(v, 40);
  if (!s) return null;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const daysBetween = (from) => {
  const t = Date.parse(from);
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : 0;
};

const TEXT_FIELDS = [
  'vin', 'make', 'model', 'variant', 'colour', 'fuel', 'transmission', 'body', 'condition',
  'status', 'location', 'stock_number', 'service_history', 'mot_expiry', 'tax_status',
  'tax_due', 'first_registered', 'region', 'photo', 'notes', 'date_in', 'date_sold', 'buyer_name',
];
const NUMBER_FIELDS = [
  'year', 'engine_cc', 'doors', 'seats', 'co2', 'mileage', 'keys_count',
  'purchase_price', 'asking_price', 'sold_price', 'prep_cost',
];
const STATUSES = ['in_stock', 'prep', 'reserved', 'sold', 'archived'];
const ACTIVITY_KINDS = ['viewing', 'call', 'enquiry', 'test_drive', 'offer', 'message', 'note'];
const APPOINTMENT_KINDS = ['viewing', 'test_drive', 'collection', 'delivery', 'valuation'];
const APPOINTMENT_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];

function vehiclePatch(body) {
  const patch = {};
  for (const k of TEXT_FIELDS) if (k in body) patch[k] = str(body[k], k === 'notes' ? 20000 : 200);
  for (const k of NUMBER_FIELDS) if (k in body) patch[k] = num(body[k]);
  if (patch.status && !STATUSES.includes(patch.status)) fail(400, 'Unknown status');
  for (const k of ['mot_expiry', 'tax_due', 'first_registered', 'date_in', 'date_sold']) {
    if (k in patch && patch[k]) patch[k] = dayOnly(patch[k]);
  }
  if (patch.vin) patch.vin = patch.vin.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (patch.year !== undefined && patch.year !== null) {
    const y = Math.round(patch.year);
    patch.year = y >= 1900 && y <= new Date().getFullYear() + 2 ? y : null;
  }
  return patch;
}

function joinCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => alphabet[b % alphabet.length]).join('').replace(/^(.{4})/, '$1-');
}

function publicUser(db, user) {
  const d = db.dealership;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    dealership: {
      id: d.id,
      name: d.name,
      joinCode: d.join_code,
      currency: d.currency,
      distanceUnit: d.distance_unit,
      country: d.country,
      vatScheme: d.vat_scheme || 'margin',
    },
  };
}

function currentUser(db) {
  const id = getItem(SESSION_KEY);
  return id ? db.users.find((u) => u.id === id) || null : null;
}

function counts(db, vehicleId) {
  const acts = db.activities.filter((a) => a.vehicle_id === vehicleId);
  const appts = db.appointments
    .filter((a) => a.vehicle_id === vehicleId && a.status === 'scheduled')
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  return {
    viewings: acts.filter((a) => a.kind === 'viewing').length,
    calls: acts.filter((a) => a.kind === 'call').length,
    enquiries: acts.filter((a) => ['enquiry', 'offer', 'test_drive', 'message'].includes(a.kind)).length,
    last_activity_at: acts.length ? acts.map((a) => a.occurred_at).sort().pop() : null,
    booked: appts.length,
    next_at: appts[0] ? appts[0].scheduled_at : null,
    next_customer: appts[0] ? appts[0].customer_name : null,
    next_kind: appts[0] ? appts[0].kind : null,
  };
}

function decorate(db, v) {
  const c = counts(db, v.id);
  const d = db.dealership;
  const stats = {
    viewings: c.viewings,
    calls: c.calls,
    enquiries: c.enquiries,
    daysInStock: daysBetween(v.date_in || v.created_at),
  };
  const estimate = estimateValue(v, { currency: d.currency, distanceUnit: d.distance_unit });
  return {
    ...v,
    ...c,
    stats: { ...stats, interest: stats.viewings + stats.calls + stats.enquiries },
    estimate,
    advice: stockAdvice(v, { ...stats, estimate }),
    margin: v.asking_price ? v.asking_price - (v.purchase_price || 0) - (v.prep_cost || 0) : null,
    profit: v.sold_price ? v.sold_price - (v.purchase_price || 0) - (v.prep_cost || 0) : null,
  };
}

const SORTS = {
  newest: (a, b) => b.created_at.localeCompare(a.created_at),
  oldest: (a, b) => a.created_at.localeCompare(b.created_at),
  price_high: (a, b) => (b.asking_price || 0) - (a.asking_price || 0),
  price_low: (a, b) => (a.asking_price || 0) - (b.asking_price || 0),
  interest: (a, b) => b.stats.interest - a.stats.interest,
  age: (a, b) => (a.date_in || a.created_at).localeCompare(b.date_in || b.created_at),
  plate: (a, b) => a.plate_key.localeCompare(b.plate_key),
};

/* ------------------------------------------------------------------ *
 * The routes
 * ------------------------------------------------------------------ */

const LOCAL_ROUTES = [
  ['POST', /^\/auth\/signup$/, async (db, _p, body) => {
    const name = str(body.name, 80);
    const dealership = str(body.dealership, 120);
    const email = str(body.email, 160)?.toLowerCase();
    if (!dealership) fail(400, 'Add your dealership name');
    if (!name) fail(400, 'Add your name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) fail(400, 'That email address does not look right');
    if (String(body.password || '').length < 8) fail(400, 'Use a password of at least 8 characters');
    if (db.dealership) fail(409, 'This device already holds a dealership. Sign in, or clear it from Settings.');

    const country = str(body.country, 4) || 'GB';
    db.dealership = {
      id: uid(),
      name: dealership,
      join_code: joinCode(),
      country,
      currency: str(body.currency, 4) || (country === 'US' ? 'USD' : country === 'GB' ? 'GBP' : 'EUR'),
      distance_unit: country === 'GB' || country === 'US' ? 'mi' : 'km',
      vat_scheme: 'margin',
      created_at: nowIso(),
    };
    const user = {
      id: uid(), name, email, role: 'owner',
      password: await hash(body.password), created_at: nowIso(), last_seen_at: nowIso(),
    };
    db.users.push(user);
    save(db);
    setItem(SESSION_KEY, user.id);
    return { user: publicUser(db, user) };
  }],

  ['POST', /^\/auth\/join$/, async (db, _p, body) => {
    if (!db.dealership) fail(404, 'No dealership on this device yet — create one first.');
    const code = str(body.joinCode, 20)?.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code !== db.dealership.join_code.replace('-', '')) fail(404, 'That team code was not recognised');
    const email = str(body.email, 160)?.toLowerCase();
    if (db.users.some((u) => u.email === email)) fail(409, 'There is already an account with that email — sign in instead');
    if (String(body.password || '').length < 8) fail(400, 'Use a password of at least 8 characters');
    const user = {
      id: uid(), name: str(body.name, 80), email, role: 'member',
      password: await hash(body.password), created_at: nowIso(), last_seen_at: nowIso(),
    };
    db.users.push(user);
    save(db);
    setItem(SESSION_KEY, user.id);
    return { user: publicUser(db, user) };
  }],

  ['POST', /^\/auth\/login$/, async (db, _p, body) => {
    const email = str(body.email, 160)?.toLowerCase();
    if (!email || !body.password) fail(400, 'Enter your email and password');
    const user = db.users.find((u) => u.email === email);
    if (!user || user.password !== await hash(body.password || '')) fail(401, 'Email or password is wrong');
    user.last_seen_at = nowIso();
    save(db);
    setItem(SESSION_KEY, user.id);
    return { user: publicUser(db, user) };
  }],

  ['POST', /^\/auth\/logout$/, async () => {
    removeItem(SESSION_KEY);
    return { ok: true };
  }],

  ['GET', /^\/me$/, async (db, _p, _b, user) => ({ user: publicUser(db, user) })],

  ['PATCH', /^\/me$/, async (db, _p, body, user) => {
    if (body.name) user.name = str(body.name, 80);
    if (body.email) {
      const email = str(body.email, 160).toLowerCase();
      if (db.users.some((u) => u.email === email && u.id !== user.id)) fail(409, 'Another account already uses that email');
      user.email = email;
    }
    save(db);
    return { user: publicUser(db, user) };
  }],

  ['POST', /^\/me\/password$/, async (db, _p, body, user) => {
    if (String(body.newPassword || '').length < 8) fail(400, 'Use a password of at least 8 characters');
    if (user.password !== await hash(body.currentPassword || '')) fail(401, 'Current password is wrong');
    user.password = await hash(body.newPassword);
    save(db);
    return { ok: true };
  }],

  ['GET', /^\/lookup$/, async (db, _p, _b, _u, query) => {
    const plate = query.get('plate') || '';
    const key = plateKey(plate);
    const decoded = decodePlate(key);
    const fields = {};
    const sources = [];
    if (decoded.year) fields.year = decoded.year;
    if (decoded.registeredFrom) fields.firstRegistered = decoded.registeredFrom;
    if (decoded.region) fields.region = decoded.issuedAt ? `${decoded.region} (${decoded.issuedAt})` : decoded.region;
    if (decoded.scheme.startsWith('uk')) sources.push('Plate decoder');
    const existing = db.vehicles.find((v) => v.plate_key === key);
    return {
      plate: formatPlate(key),
      plateKey: key,
      fields,
      decoded,
      history: null,
      sources,
      cached: false,
      identified: false,
      alreadyInStock: existing
        ? { id: existing.id, plate: existing.plate, make: existing.make, model: existing.model, year: existing.year, status: existing.status }
        : null,
    };
  }],

  ['POST', /^\/valuation$/, async (db, _p, body) => ({
    estimate: estimateValue(vehiclePatch(body), {
      currency: db.dealership.currency,
      distanceUnit: db.dealership.distance_unit,
    }),
  })],

  ['GET', /^\/vehicles$/, async (db, _p, _b, _u, query) => {
    const status = query.get('status');
    const q = (query.get('q') || '').trim().toUpperCase();
    let list = db.vehicles.map((v) => decorate(db, v));
    if (status && status !== 'all') {
      list = status === 'live'
        ? list.filter((v) => ['in_stock', 'prep', 'reserved'].includes(v.status))
        : list.filter((v) => v.status === status);
    } else {
      list = list.filter((v) => v.status !== 'archived');
    }
    if (q) {
      const plain = q.replace(/[^A-Z0-9]/g, '');
      list = list.filter((v) => [v.make, v.model, v.stock_number, v.colour, v.vin]
        .some((f) => String(f || '').toUpperCase().includes(q)) || (plain && v.plate_key.includes(plain)));
    }
    list.sort(SORTS[query.get('sort')] || SORTS.newest);
    return { vehicles: list };
  }],

  ['POST', /^\/vehicles$/, async (db, _p, body, user) => {
    const key = plateKey(body.plate || '');
    if (!key) fail(400, 'A registration is needed to add a vehicle');
    const clash = db.vehicles.find((v) => v.plate_key === key);
    if (clash) fail(409, 'That registration is already in your stock', { vehicleId: clash.id });

    const patch = vehiclePatch(body);
    const decoded = decodePlate(key);
    const created = nowIso();
    const vehicle = {
      id: uid(),
      plate: formatPlate(key),
      plate_key: key,
      ...patch,
      status: patch.status || 'in_stock',
      condition: patch.condition || 'good',
      date_in: patch.date_in || created.slice(0, 10),
      year: patch.year ?? decoded.year ?? null,
      first_registered: patch.first_registered || decoded.registeredFrom || null,
      region: patch.region || (decoded.region ? `${decoded.region}${decoded.issuedAt ? ` (${decoded.issuedAt})` : ''}` : null),
      lookup_source: str(body.lookupSource, 60),
      lookup: body.lookup || null,
      created_by: user.id,
      created_at: created,
      updated_at: created,
    };
    db.vehicles.push(vehicle);
    save(db);
    return { vehicle: decorate(db, vehicle) };
  }],

  ['GET', /^\/vehicles\/([^/]+)$/, async (db, p) => {
    const vehicle = db.vehicles.find((v) => v.id === p[0]);
    if (!vehicle) fail(404, 'Vehicle not found');
    return {
      vehicle: decorate(db, vehicle),
      activities: db.activities.filter((a) => a.vehicle_id === vehicle.id)
        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)),
      appointments: db.appointments.filter((a) => a.vehicle_id === vehicle.id)
        .sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at)),
      valuations: db.valuations.filter((a) => a.vehicle_id === vehicle.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    };
  }],

  ['PATCH', /^\/vehicles\/([^/]+)$/, async (db, p, body, user) => {
    const vehicle = db.vehicles.find((v) => v.id === p[0]);
    if (!vehicle) fail(404, 'Vehicle not found');
    const patch = vehiclePatch(body);

    if ('plate' in body) {
      const key = plateKey(body.plate);
      if (!key) fail(400, 'That registration does not look right');
      if (key !== vehicle.plate_key && db.vehicles.some((v) => v.plate_key === key && v.id !== vehicle.id)) {
        fail(409, 'Another vehicle in your stock already has that registration');
      }
      patch.plate = formatPlate(key);
      patch.plate_key = key;
    }
    if (patch.status === 'sold' && vehicle.status !== 'sold') {
      if (!patch.date_sold && !vehicle.date_sold) patch.date_sold = nowIso().slice(0, 10);
      if (patch.sold_price === undefined && (vehicle.sold_price === null || vehicle.sold_price === undefined)) {
        patch.sold_price = vehicle.asking_price ?? null;
      }
    }
    if (patch.status && patch.status !== 'sold' && vehicle.status === 'sold') {
      patch.date_sold = null;
      patch.sold_price = null;
    }
    if (patch.asking_price !== undefined && vehicle.asking_price && patch.asking_price !== vehicle.asking_price) {
      db.activities.push({
        id: uid(), vehicle_id: vehicle.id, kind: 'note',
        notes: `Price changed from ${Math.round(vehicle.asking_price).toLocaleString()} to ${Math.round(patch.asking_price || 0).toLocaleString()}`,
        occurred_at: nowIso(), user_id: user.id, user_name: user.name, created_at: nowIso(),
      });
    }
    Object.assign(vehicle, patch, { updated_at: nowIso() });
    save(db);
    return { vehicle: decorate(db, vehicle) };
  }],

  ['DELETE', /^\/vehicles\/([^/]+)$/, async (db, p) => {
    const index = db.vehicles.findIndex((v) => v.id === p[0]);
    if (index < 0) fail(404, 'Vehicle not found');
    db.vehicles.splice(index, 1);
    db.activities = db.activities.filter((a) => a.vehicle_id !== p[0]);
    db.appointments = db.appointments.filter((a) => a.vehicle_id !== p[0]);
    db.valuations = db.valuations.filter((a) => a.vehicle_id !== p[0]);
    save(db);
    return { ok: true };
  }],

  ['POST', /^\/vehicles\/([^/]+)\/activities$/, async (db, p, body, user) => {
    const vehicle = db.vehicles.find((v) => v.id === p[0]);
    if (!vehicle) fail(404, 'Vehicle not found');
    if (!ACTIVITY_KINDS.includes(body.kind)) fail(400, 'Unknown activity type');
    const activity = {
      id: uid(), vehicle_id: vehicle.id, kind: body.kind,
      contact_name: str(body.contactName, 120),
      contact_phone: str(body.contactPhone, 40),
      contact_email: str(body.contactEmail, 160),
      amount: num(body.amount),
      notes: str(body.notes, 2000),
      occurred_at: isoDate(body.occurredAt) || nowIso(),
      user_id: user.id, user_name: user.name, created_at: nowIso(),
    };
    db.activities.push(activity);
    save(db);
    return { activity, vehicle: decorate(db, vehicle) };
  }],

  ['DELETE', /^\/activities\/([^/]+)$/, async (db, p) => {
    const index = db.activities.findIndex((a) => a.id === p[0]);
    if (index < 0) fail(404, 'Activity not found');
    db.activities.splice(index, 1);
    save(db);
    return { ok: true };
  }],

  ['POST', /^\/vehicles\/([^/]+)\/appointments$/, async (db, p, body, user) => {
    const vehicle = db.vehicles.find((v) => v.id === p[0]);
    if (!vehicle) fail(404, 'Vehicle not found');
    const kind = str(body.kind, 20) || 'viewing';
    if (!APPOINTMENT_KINDS.includes(kind)) fail(400, 'Unknown appointment type');
    const customer = str(body.customerName, 120);
    const scheduled = isoDate(body.scheduledAt);
    if (!customer) fail(400, 'Who is coming in?');
    if (!scheduled) fail(400, 'Pick a date and time');

    const appointment = {
      id: uid(), vehicle_id: vehicle.id, kind, customer_name: customer,
      customer_phone: str(body.customerPhone, 40),
      customer_email: str(body.customerEmail, 160),
      scheduled_at: scheduled, status: 'scheduled',
      deposit: num(body.deposit), notes: str(body.notes, 2000),
      created_by: user.id, created_at: nowIso(), updated_at: nowIso(),
    };
    db.appointments.push(appointment);
    if ((kind === 'collection' || kind === 'delivery') && num(body.deposit)
      && ['in_stock', 'prep'].includes(vehicle.status)) {
      vehicle.status = 'reserved';
      vehicle.buyer_name = customer;
      vehicle.updated_at = nowIso();
    }
    save(db);
    return { appointment, vehicle: decorate(db, vehicle) };
  }],

  ['PATCH', /^\/appointments\/([^/]+)$/, async (db, p, body, user) => {
    const appointment = db.appointments.find((a) => a.id === p[0]);
    if (!appointment) fail(404, 'Appointment not found');
    const wasStatus = appointment.status;
    if ('status' in body) {
      if (!APPOINTMENT_STATUSES.includes(body.status)) fail(400, 'Unknown appointment status');
      appointment.status = body.status;
    }
    if ('kind' in body && APPOINTMENT_KINDS.includes(body.kind)) appointment.kind = body.kind;
    if ('customerName' in body) appointment.customer_name = str(body.customerName, 120) || appointment.customer_name;
    if ('customerPhone' in body) appointment.customer_phone = str(body.customerPhone, 40);
    if ('customerEmail' in body) appointment.customer_email = str(body.customerEmail, 160);
    if ('scheduledAt' in body) appointment.scheduled_at = isoDate(body.scheduledAt) || appointment.scheduled_at;
    if ('deposit' in body) appointment.deposit = num(body.deposit);
    if ('notes' in body) appointment.notes = str(body.notes, 2000);
    appointment.updated_at = nowIso();

    if (appointment.status === 'completed' && wasStatus !== 'completed') {
      const map = { viewing: 'viewing', test_drive: 'test_drive', valuation: 'note', collection: 'note', delivery: 'note' };
      db.activities.push({
        id: uid(), vehicle_id: appointment.vehicle_id, kind: map[appointment.kind] || 'note',
        contact_name: appointment.customer_name, contact_phone: appointment.customer_phone,
        contact_email: appointment.customer_email,
        notes: `${appointment.kind.replace('_', ' ')} completed`,
        occurred_at: nowIso(), user_id: user.id, user_name: user.name, created_at: nowIso(),
      });
    }
    save(db);
    const vehicle = db.vehicles.find((v) => v.id === appointment.vehicle_id);
    return { appointment, vehicle: vehicle ? decorate(db, vehicle) : null };
  }],

  ['DELETE', /^\/appointments\/([^/]+)$/, async (db, p) => {
    const index = db.appointments.findIndex((a) => a.id === p[0]);
    if (index < 0) fail(404, 'Appointment not found');
    db.appointments.splice(index, 1);
    save(db);
    return { ok: true };
  }],

  ['GET', /^\/appointments$/, async (db) => {
    const from = new Date(Date.now() - 86400000).toISOString();
    const to = new Date(Date.now() + 60 * 86400000).toISOString();
    const appointments = db.appointments
      .filter((a) => a.scheduled_at >= from && a.scheduled_at <= to)
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
      .map((a) => {
        const v = db.vehicles.find((x) => x.id === a.vehicle_id) || {};
        return { ...a, plate: v.plate, make: v.make, model: v.model, year: v.year, asking_price: v.asking_price };
      });
    return { appointments };
  }],

  ['POST', /^\/vehicles\/([^/]+)\/valuations$/, async (db, p, body, user) => {
    const vehicle = db.vehicles.find((v) => v.id === p[0]);
    if (!vehicle) fail(404, 'Vehicle not found');
    const estimate = estimateValue(vehicle, {
      currency: db.dealership.currency,
      distanceUnit: db.dealership.distance_unit,
    });
    db.valuations.push({
      id: uid(), vehicle_id: vehicle.id,
      trade_value: num(body.tradeValue) ?? estimate.trade,
      retail_value: num(body.retailValue) ?? estimate.retail,
      private_value: num(body.privateValue) ?? estimate.private,
      method: str(body.method, 60) || (body.retailValue ? 'Manual' : estimate.method),
      notes: str(body.notes, 1000), user_name: user.name, created_at: nowIso(),
    });
    save(db);
    return {
      valuations: db.valuations.filter((v) => v.vehicle_id === vehicle.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    };
  }],

  ['GET', /^\/dashboard$/, async (db) => {
    const now = Date.now();
    const weekAgo = new Date(now - 7 * 86400000).toISOString();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const dayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const dayEnd = new Date(Date.parse(dayStart) + 86400000).toISOString();

    const byStatus = {};
    let live = 0; let value = 0; let invested = 0; let ageSum = 0;
    for (const v of db.vehicles) {
      const entry = byStatus[v.status] || (byStatus[v.status] = { count: 0, asking: 0, invested: 0 });
      entry.count++;
      entry.asking += v.asking_price || 0;
      entry.invested += (v.purchase_price || 0) + (v.prep_cost || 0);
      if (['in_stock', 'prep', 'reserved'].includes(v.status)) {
        live++;
        value += v.asking_price || 0;
        invested += (v.purchase_price || 0) + (v.prep_cost || 0);
        ageSum += daysBetween(v.date_in || v.created_at);
      }
    }

    const week = db.activities.filter((a) => a.occurred_at >= weekAgo);
    const countKind = (...kinds) => week.filter((a) => kinds.includes(a.kind)).length;

    const sold = db.vehicles.filter((v) => v.status === 'sold' && (v.date_sold || v.updated_at) >= monthStart);
    const vehicleOf = (id) => db.vehicles.find((v) => v.id === id) || {};

    const upcoming = db.appointments
      .filter((a) => a.status === 'scheduled' && a.scheduled_at >= dayStart)
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
      .slice(0, 12)
      .map((a) => {
        const v = vehicleOf(a.vehicle_id);
        return { ...a, plate: v.plate, make: v.make, model: v.model, year: v.year };
      });

    const fortnightAgo = new Date(now - 14 * 86400000).toISOString();
    const hot = db.vehicles
      .filter((v) => ['in_stock', 'prep', 'reserved'].includes(v.status))
      .map((v) => ({
        id: v.id, plate: v.plate, make: v.make, model: v.model, year: v.year,
        asking_price: v.asking_price, status: v.status,
        interest: db.activities.filter((a) => a.vehicle_id === v.id && a.occurred_at >= fortnightAgo).length,
      }))
      .filter((v) => v.interest > 0)
      .sort((a, b) => b.interest - a.interest)
      .slice(0, 5);

    const aging = db.vehicles
      .filter((v) => ['in_stock', 'prep'].includes(v.status))
      .map((v) => ({
        id: v.id, plate: v.plate, make: v.make, model: v.model, year: v.year,
        asking_price: v.asking_price,
        days: daysBetween(v.date_in || v.created_at),
        interest: db.activities.filter((a) => a.vehicle_id === v.id).length,
      }))
      .sort((a, b) => b.days - a.days)
      .slice(0, 5);

    const feed = [...db.activities]
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
      .slice(0, 15)
      .map((a) => {
        const v = vehicleOf(a.vehicle_id);
        return { ...a, plate: v.plate, make: v.make, model: v.model };
      });

    return {
      stock: { live, byStatus, value: Math.round(value), invested: Math.round(invested), avgDays: live ? Math.round(ageSum / live) : 0 },
      week: {
        viewings: countKind('viewing'), calls: countKind('call'),
        enquiries: countKind('enquiry', 'message'), testDrives: countKind('test_drive'),
        offers: countKind('offer'),
      },
      month: {
        sold: sold.length,
        revenue: Math.round(sold.reduce((s, v) => s + (v.sold_price || 0), 0)),
        profit: Math.round(sold.reduce((s, v) => s + (v.sold_price || 0) - (v.purchase_price || 0) - (v.prep_cost || 0), 0)),
      },
      appointments: {
        today: db.appointments.filter((a) => a.status === 'scheduled' && a.scheduled_at >= dayStart && a.scheduled_at < dayEnd).length,
        upcoming,
      },
      hot,
      aging,
      feed,
    };
  }],

  ['GET', /^\/team$/, async (db) => ({
    team: db.users.map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role,
      created_at: u.created_at, last_seen_at: u.last_seen_at,
      logged: db.activities.filter((a) => a.user_id === u.id).length,
    })),
    joinCode: db.dealership.join_code,
  })],

  ['PATCH', /^\/team\/([^/]+)$/, async (db, p, body, user) => {
    if (user.role !== 'owner') fail(403, 'Only the account owner can change roles');
    const member = db.users.find((u) => u.id === p[0]);
    if (!member) fail(404, 'Team member not found');
    member.role = body.role === 'owner' ? 'owner' : 'member';
    save(db);
    return { ok: true };
  }],

  ['DELETE', /^\/team\/([^/]+)$/, async (db, p, _b, user) => {
    if (user.role !== 'owner') fail(403, 'Only the account owner can remove people');
    if (p[0] === user.id) fail(400, 'You cannot remove yourself');
    db.users = db.users.filter((u) => u.id !== p[0]);
    save(db);
    return { ok: true };
  }],

  ['POST', /^\/team\/code$/, async (db, _p, _b, user) => {
    if (user.role !== 'owner') fail(403, 'Only the account owner can reset the team code');
    db.dealership.join_code = joinCode();
    save(db);
    return { joinCode: db.dealership.join_code };
  }],

  ['PATCH', /^\/settings$/, async (db, _p, body, user) => {
    if (user.role !== 'owner') fail(403, 'Only the account owner can change these settings');
    const d = db.dealership;
    if (body.name) d.name = str(body.name, 120);
    if (body.currency) d.currency = str(body.currency, 4).toUpperCase();
    if (body.country) d.country = str(body.country, 4).toUpperCase();
    if (body.distanceUnit) d.distance_unit = body.distanceUnit === 'km' ? 'km' : 'mi';
    save(db);
    return { user: publicUser(db, user) };
  }],

  ['POST', /^\/demo$/, async (db, _p, _b, user) => {
    if (db.vehicles.length) fail(400, 'Sample stock can only be added to an empty account');
    const now = Date.now();
    const samples = [
      ['LT20XYZ', 'Volkswagen', 'Golf', 'Life TSI 1.5', 2020, 'Grey', 'Petrol', 'Manual', 'Hatchback', 1498, 34210, 13495, 10800, 'in_stock', 96],
      ['MA68KDR', 'BMW', '320d', 'M Sport Touring', 2018, 'Black', 'Diesel', 'Automatic', 'Estate', 1995, 68400, 15995, 12750, 'in_stock', 41],
      ['YB21WNP', 'Ford', 'Puma', 'ST-Line X', 2021, 'Blue', 'Petrol', 'Manual', 'SUV', 999, 22980, 15750, 13200, 'reserved', 18],
      ['SK17FGH', 'Audi', 'A4', 'S Line TDI', 2017, 'White', 'Diesel', 'Automatic', 'Saloon', 1968, 89250, 11450, 8900, 'in_stock', 74],
      ['LR69TMA', 'Toyota', 'Yaris', 'Icon Hybrid', 2019, 'Red', 'Hybrid', 'Automatic', 'Hatchback', 1490, 41100, 11250, 9100, 'in_stock', 9],
      ['BD23OLV', 'Tesla', 'Model 3', 'Long Range', 2023, 'White', 'Electric', 'Automatic', 'Saloon', null, 18400, 26950, 23500, 'prep', 4],
    ];
    const names = ['Dave Harris', 'Priya Shah', 'Tom Nolan', 'Grace Bennett', 'Marcus Reid', 'Ellie Fry'];
    const kinds = ['viewing', 'call', 'enquiry', 'call', 'viewing', 'test_drive', 'offer'];

    samples.forEach((s, i) => {
      const [plate, make, model, variant, year, colour, fuel, transmission, body, cc, mileage, asking, purchase, status, days] = s;
      const created = new Date(now - days * 86400000).toISOString();
      const id = uid();
      db.vehicles.push({
        id, plate: formatPlate(plate), plate_key: plateKey(plate), make, model, variant, year, colour,
        fuel, transmission, body, engine_cc: cc, mileage, condition: 'good',
        purchase_price: purchase, asking_price: asking, status,
        date_in: created.slice(0, 10), stock_number: `S${1001 + i}`, location: 'Main forecourt',
        service_history: 'Full service history', created_by: user.id, created_at: created, updated_at: created,
      });
      const events = Math.min(9, 2 + ((i * 3) % 8));
      for (let e = 0; e < events; e++) {
        const at = new Date(now - Math.max(1, days - e * 2) * 86400000 + e * 3600000).toISOString();
        const kind = kinds[(i + e) % kinds.length];
        db.activities.push({
          id: uid(), vehicle_id: id, kind, contact_name: names[(i + e) % names.length],
          contact_phone: `07${700 + ((i * 7 + e) % 99)} ${100000 + ((i * 13 + e * 7) % 899999)}`,
          amount: kind === 'offer' ? 11800 + i * 250 : null,
          notes: kind === 'call' ? 'Asked about the service history' : kind === 'offer' ? 'Cash today, no part-ex' : null,
          occurred_at: at, user_id: user.id, user_name: user.name, created_at: at,
        });
      }
    });

    const soon = (h) => new Date(now + h * 3600000).toISOString();
    const bookings = [
      [2, 'collection', 'Priya Shah', '07700 900123', 26, 500, 'Paying balance on collection'],
      [1, 'viewing', 'Tom Nolan', '07700 900456', 5, null, 'Coming after work'],
      [0, 'test_drive', 'Grace Bennett', '07700 900789', 51, null, 'Bringing licence'],
    ];
    for (const [index, kind, customer, phone, hours, deposit, notes] of bookings) {
      db.appointments.push({
        id: uid(), vehicle_id: db.vehicles[index].id, kind, customer_name: customer,
        customer_phone: phone, scheduled_at: soon(hours), status: 'scheduled',
        deposit, notes, created_by: user.id, created_at: nowIso(), updated_at: nowIso(),
      });
    }
    save(db);
    return { ok: true, added: samples.length };
  }],
];

const OPEN_ROUTES = ['/auth/signup', '/auth/join', '/auth/login', '/auth/logout', '/me'];

globalThis.FORECOURT_LOCAL = async function localApi(path, { method = 'GET', body } = {}) {
  const [rawPath, search] = String(path).split('?');
  const query = new URLSearchParams(search || '');
  const db = load();
  const user = currentUser(db);

  if (!user && !OPEN_ROUTES.includes(rawPath)) {
    const err = new Error('Sign in to continue');
    err.status = 401;
    throw err;
  }
  if (rawPath === '/me' && !user) {
    const err = new Error('Sign in to continue');
    err.status = 401;
    throw err;
  }

  for (const [routeMethod, pattern, handler] of LOCAL_ROUTES) {
    if (routeMethod !== method) continue;
    const match = rawPath.match(pattern);
    if (!match) continue;
    try {
      return await handler(db, match.slice(1), body || {}, user, query);
    } catch (err) {
      const wrapped = new Error(err.message);
      wrapped.status = err.status || 500;
      wrapped.data = err.extra || {};
      if (err.extra) Object.assign(wrapped, err.extra);
      throw wrapped;
    }
  }

  const err = new Error(`Not found: ${method} ${rawPath}`);
  err.status = 404;
  throw err;
};

/** CSV export: the deployed app links to the Worker, here we build it in-page. */
globalThis.FORECOURT_CSV = function buildCsv() {
  const db = load();
  const cols = ['plate', 'stock_number', 'make', 'model', 'variant', 'year', 'colour', 'fuel',
    'transmission', 'mileage', 'status', 'purchase_price', 'prep_cost', 'asking_price',
    'sold_price', 'date_in', 'date_sold', 'buyer_name', 'location', 'mot_expiry', 'vin'];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [[...cols, 'viewings', 'calls', 'enquiries', 'days_in_stock', 'guide_retail'].join(',')];
  for (const v of db.vehicles) {
    const c = counts(db, v.id);
    const est = estimateValue(v, { currency: db.dealership.currency, distanceUnit: db.dealership.distance_unit });
    lines.push([...cols.map((k) => escape(v[k])), c.viewings, c.calls, c.enquiries,
      daysBetween(v.date_in || v.created_at), est.retail].join(','));
  }
  return lines.join('\n');
};
