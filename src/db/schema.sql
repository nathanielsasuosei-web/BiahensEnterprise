-- ============================================================================
--  Biahens Enterprise -- database schema (SQLite / better-sqlite3)
-- ============================================================================
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- people ----
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'customer'
                CHECK (role IN ('customer','staff','owner')),
  avatar        TEXT,
  is_blocked    INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS addresses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT    NOT NULL DEFAULT 'Home',
  receiver     TEXT    NOT NULL,
  phone        TEXT    NOT NULL,
  region       TEXT    NOT NULL,
  city         TEXT    NOT NULL,
  line         TEXT    NOT NULL,
  landmark     TEXT,
  is_default   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);

-- -------------------------------------------------------------- catalog ----
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  slug        TEXT    NOT NULL UNIQUE,
  parent_id   INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  description TEXT,
  icon        TEXT,
  image       TEXT,
  accent      TEXT    DEFAULT '#0F2A43',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  show_in_menu INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

CREATE TABLE IF NOT EXISTS brands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  slug       TEXT    NOT NULL UNIQUE,
  tagline    TEXT,
  logo       TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  slug              TEXT    NOT NULL UNIQUE,
  sku               TEXT,
  short_description TEXT,
  description       TEXT,
  category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  brand_id          INTEGER REFERENCES brands(id)     ON DELETE SET NULL,
  price             REAL    NOT NULL DEFAULT 0,
  compare_at_price  REAL,
  cost_price        REAL,
  stock             INTEGER NOT NULL DEFAULT 0,
  low_stock_at      INTEGER NOT NULL DEFAULT 5,
  weight_kg         REAL    DEFAULT 1,
  rating_avg        REAL    NOT NULL DEFAULT 0,
  rating_count      INTEGER NOT NULL DEFAULT 0,
  sold_count        INTEGER NOT NULL DEFAULT 0,
  views_count       INTEGER NOT NULL DEFAULT 0,
  image             TEXT,
  images            TEXT    NOT NULL DEFAULT '[]',   -- JSON array
  options           TEXT    NOT NULL DEFAULT '[]',   -- JSON [{name, values[]}]
  tags              TEXT    NOT NULL DEFAULT '',
  meta_title        TEXT,
  meta_description  TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  is_featured       INTEGER NOT NULL DEFAULT 0,
  status            TEXT    NOT NULL DEFAULT 'active'
                    CHECK (status IN ('draft','active','archived')),
  published_at      TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_brand    ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_active   ON products(is_active, status);
CREATE INDEX IF NOT EXISTS idx_products_price    ON products(price);

CREATE TABLE IF NOT EXISTS variants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,             -- "Black / 256GB"
  sku         TEXT,
  price_delta REAL    NOT NULL DEFAULT 0,
  stock       INTEGER NOT NULL DEFAULT 0,
  image       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);

CREATE TABLE IF NOT EXISTS reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id)   ON DELETE SET NULL,
  order_id      INTEGER REFERENCES orders(id)  ON DELETE SET NULL,
  author        TEXT    NOT NULL,
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title         TEXT,
  body          TEXT,
  is_approved   INTEGER NOT NULL DEFAULT 0,
  helpful_count INTEGER NOT NULL DEFAULT 0,
  reply         TEXT,
  replied_at    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, is_approved);

-- --------------------------------------------------------------- cart ------
CREATE TABLE IF NOT EXISTS cart_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES variants(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL DEFAULT 1,
  added_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id);
CREATE INDEX IF NOT EXISTS idx_cart_user    ON cart_items(user_id);

CREATE TABLE IF NOT EXISTS wishlists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, product_id)
);

-- ------------------------------------------------------------- checkout ----
CREATE TABLE IF NOT EXISTS coupons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  description     TEXT,
  type            TEXT    NOT NULL DEFAULT 'percent'
                  CHECK (type IN ('percent','fixed','free_shipping')),
  value           REAL    NOT NULL DEFAULT 0,
  max_discount    REAL,
  min_subtotal    REAL    NOT NULL DEFAULT 0,
  usage_limit     INTEGER,
  per_user_limit  INTEGER NOT NULL DEFAULT 1,
  used_count      INTEGER NOT NULL DEFAULT 0,
  starts_at       TEXT,
  expires_at      TEXT,
  scope           TEXT    NOT NULL DEFAULT 'all'
                  CHECK (scope IN ('all','category','brand','product')),
  scope_id        INTEGER,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shipping_rates (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  region    TEXT    NOT NULL UNIQUE,
  fee       REAL    NOT NULL DEFAULT 0,
  eta_days  TEXT    NOT NULL DEFAULT '1-3 days',
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number    TEXT    NOT NULL UNIQUE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  guest_name      TEXT,
  guest_email     TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending_payment'
                  CHECK (status IN ('pending_payment','paid','processing','shipped','delivered','cancelled','refunded')),
  payment_status  TEXT    NOT NULL DEFAULT 'unpaid'
                  CHECK (payment_status IN ('unpaid','paid','refunded','partially_refunded')),
  payment_method  TEXT    NOT NULL DEFAULT 'card'
                  CHECK (payment_method IN ('card','momo','cod')),
  subtotal        REAL    NOT NULL DEFAULT 0,
  discount        REAL    NOT NULL DEFAULT 0,
  shipping_fee    REAL    NOT NULL DEFAULT 0,
  tax             REAL    NOT NULL DEFAULT 0,
  total           REAL    NOT NULL DEFAULT 0,
  currency        TEXT    NOT NULL DEFAULT 'GHS',
  coupon_id       INTEGER REFERENCES coupons(id) ON DELETE SET NULL,
  coupon_code     TEXT,
  ship_name       TEXT    NOT NULL,
  ship_phone      TEXT    NOT NULL,
  ship_email      TEXT,
  ship_region     TEXT    NOT NULL,
  ship_city       TEXT    NOT NULL,
  ship_line       TEXT    NOT NULL,
  ship_landmark   TEXT,
  delivery_method TEXT    NOT NULL DEFAULT 'standard'
                  CHECK (delivery_method IN ('standard','express','pickup')),
  delivery_note   TEXT,
  tracking_number TEXT,
  carrier         TEXT,
  admin_notes     TEXT,
  cancel_reason   TEXT,
  placed_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_placed ON orders(placed_at);

CREATE TABLE IF NOT EXISTS order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  variant_id    INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  name          TEXT    NOT NULL,
  slug          TEXT,
  sku           TEXT,
  image         TEXT,
  variant_title TEXT,
  price         REAL    NOT NULL,
  qty           INTEGER NOT NULL,
  total         REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT    NOT NULL,
  note       TEXT,
  actor      TEXT    NOT NULL DEFAULT 'system',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reference     TEXT    NOT NULL UNIQUE,
  gateway       TEXT    NOT NULL DEFAULT 'biahens-stub',
  method        TEXT    NOT NULL DEFAULT 'card',
  status        TEXT    NOT NULL DEFAULT 'initiated'
                CHECK (status IN ('initiated','success','failed','abandoned','refunded')),
  amount        REAL    NOT NULL,
  currency      TEXT    NOT NULL DEFAULT 'GHS',
  channel       TEXT,             -- card | mobile_money | bank | cod
  last4         TEXT,
  payer         TEXT,
  gateway_ref   TEXT,
  raw           TEXT    NOT NULL DEFAULT '{}',
  error         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  paid_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ------------------------------------------------------- site management ----
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  grp        TEXT NOT NULL DEFAULT 'general',
  type       TEXT NOT NULL DEFAULT 'text',   -- text|textarea|number|boolean|json|image
  label      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS slides (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  subtitle   TEXT,
  badge      TEXT,
  image      TEXT,
  bg         TEXT    NOT NULL DEFAULT 'linear-gradient(120deg,#0F2A43,#1D4E6B)',
  link_text  TEXT    NOT NULL DEFAULT 'Shop now',
  link_url   TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS newsletter (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL DEFAULT 'info',   -- order|stock|review|system
  level      TEXT    NOT NULL DEFAULT 'info',   -- info|warn|danger|success
  title      TEXT    NOT NULL,
  body       TEXT,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name  TEXT,
  actor_role  TEXT,
  action      TEXT    NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  meta        TEXT    NOT NULL DEFAULT '{}',
  ip          TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL COLLATE NOCASE,
  token_hash TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  used_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_password_resets_email ON password_resets(email);

-- express-session store
CREATE TABLE IF NOT EXISTS sessions (
  sid    TEXT PRIMARY KEY,
  sess   TEXT NOT NULL,
  expire INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
