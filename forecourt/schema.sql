-- Forecourt schema (Cloudflare D1 / SQLite).
-- The Worker applies this automatically on first request, so running it by hand
-- is optional. It is kept here so the database can be inspected or rebuilt.

CREATE TABLE IF NOT EXISTS dealerships (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  join_code     TEXT NOT NULL UNIQUE,
  country       TEXT NOT NULL DEFAULT 'GB',
  currency      TEXT NOT NULL DEFAULT 'GBP',
  distance_unit TEXT NOT NULL DEFAULT 'mi',
  vat_scheme    TEXT NOT NULL DEFAULT 'margin',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  dealership_id TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_dealership ON users(dealership_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS vehicles (
  id               TEXT PRIMARY KEY,
  dealership_id    TEXT NOT NULL,
  plate            TEXT NOT NULL,
  plate_key        TEXT NOT NULL,
  vin              TEXT,
  make             TEXT,
  model            TEXT,
  variant          TEXT,
  year             INTEGER,
  colour           TEXT,
  fuel             TEXT,
  transmission     TEXT,
  body             TEXT,
  engine_cc        INTEGER,
  doors            INTEGER,
  seats            INTEGER,
  co2              INTEGER,
  mileage          INTEGER,
  condition        TEXT DEFAULT 'good',
  purchase_price   REAL,
  asking_price     REAL,
  sold_price       REAL,
  prep_cost        REAL,
  status           TEXT NOT NULL DEFAULT 'in_stock',
  location         TEXT,
  stock_number     TEXT,
  keys_count       INTEGER,
  service_history  TEXT,
  mot_expiry       TEXT,
  tax_status       TEXT,
  tax_due          TEXT,
  first_registered TEXT,
  region           TEXT,
  lookup_source    TEXT,
  lookup_json      TEXT,
  photo            TEXT,
  notes            TEXT,
  date_in          TEXT,
  date_sold        TEXT,
  buyer_name       TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles(dealership_id, plate_key);
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(dealership_id, status);

CREATE TABLE IF NOT EXISTS activities (
  id            TEXT PRIMARY KEY,
  dealership_id TEXT NOT NULL,
  vehicle_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  contact_name  TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  amount        REAL,
  notes         TEXT,
  occurred_at   TEXT NOT NULL,
  user_id       TEXT,
  user_name     TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_vehicle ON activities(vehicle_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_activities_dealership ON activities(dealership_id, occurred_at);

CREATE TABLE IF NOT EXISTS appointments (
  id             TEXT PRIMARY KEY,
  dealership_id  TEXT NOT NULL,
  vehicle_id     TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'viewing',
  customer_name  TEXT NOT NULL,
  customer_phone TEXT,
  customer_email TEXT,
  scheduled_at   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'scheduled',
  deposit        REAL,
  notes          TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_vehicle ON appointments(vehicle_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appointments_diary ON appointments(dealership_id, scheduled_at);

CREATE TABLE IF NOT EXISTS valuations (
  id            TEXT PRIMARY KEY,
  dealership_id TEXT NOT NULL,
  vehicle_id    TEXT NOT NULL,
  trade_value   REAL,
  retail_value  REAL,
  private_value REAL,
  method        TEXT,
  notes         TEXT,
  user_name     TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_valuations_vehicle ON valuations(vehicle_id, created_at);

CREATE TABLE IF NOT EXISTS plate_cache (
  plate_key  TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  source     TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
