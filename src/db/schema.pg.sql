-- ============================================================================
--  POINTGH -- PostgreSQL database schema (for Neon / Vercel migration)
-- ============================================================================

-- Migration log table (tracks applied schema and data migrations)
CREATE TABLE IF NOT EXISTS app_migrations (
  name VARCHAR(120) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------- people ----
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  phone         VARCHAR(50),
  password_hash TEXT NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'customer'
                CHECK (role IN ('customer','staff','owner')),
  avatar        TEXT,
  is_blocked    INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0,1)),
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0,1)),
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));

CREATE TABLE IF NOT EXISTS addresses (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        VARCHAR(50) NOT NULL DEFAULT 'Home',
  receiver     VARCHAR(150) NOT NULL,
  phone        VARCHAR(50) NOT NULL,
  region       VARCHAR(100) NOT NULL,
  city         VARCHAR(100) NOT NULL,
  line         TEXT NOT NULL,
  landmark     TEXT,
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);

-- -------------------------------------------------------------- catalog ----
CREATE TABLE IF NOT EXISTS categories (
  id           BIGSERIAL PRIMARY KEY,
  name         VARCHAR(150) NOT NULL,
  slug         VARCHAR(150) NOT NULL UNIQUE,
  parent_id    BIGINT REFERENCES categories(id) ON DELETE CASCADE,
  description  TEXT,
  icon         VARCHAR(100),
  image        TEXT,
  accent       VARCHAR(20) DEFAULT '#0F2A43',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  show_in_menu INTEGER NOT NULL DEFAULT 1 CHECK (show_in_menu IN (0,1)),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

CREATE TABLE IF NOT EXISTS brands (
  id         BIGSERIAL PRIMARY KEY,
  name       VARCHAR(150) NOT NULL,
  slug       VARCHAR(150) NOT NULL UNIQUE,
  tagline    TEXT,
  logo       TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id                BIGSERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  slug              VARCHAR(255) NOT NULL UNIQUE,
  sku               VARCHAR(100),
  short_description TEXT,
  description       TEXT,
  category_id       BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  brand_id          BIGINT REFERENCES brands(id)     ON DELETE SET NULL,
  price             NUMERIC(12,2) NOT NULL DEFAULT 0,
  compare_at_price  NUMERIC(12,2),
  cost_price        NUMERIC(12,2),
  stock             INTEGER NOT NULL DEFAULT 0,
  low_stock_at      INTEGER NOT NULL DEFAULT 5,
  weight_kg         NUMERIC(8,2) DEFAULT 1,
  rating_avg        NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count      INTEGER NOT NULL DEFAULT 0,
  sold_count        INTEGER NOT NULL DEFAULT 0,
  views_count       INTEGER NOT NULL DEFAULT 0,
  image             TEXT,
  images            JSONB NOT NULL DEFAULT '[]'::jsonb,
  options           JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags              TEXT NOT NULL DEFAULT '',
  meta_title        TEXT,
  meta_description  TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  is_featured       INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0,1)),
  status            VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('draft','active','archived')),
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_brand    ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_active   ON products(is_active, status);
CREATE INDEX IF NOT EXISTS idx_products_price    ON products(price);

CREATE TABLE IF NOT EXISTS variants (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,
  sku         VARCHAR(100),
  price_delta NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock       INTEGER NOT NULL DEFAULT 0,
  image       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);

CREATE TABLE IF NOT EXISTS reviews (
  id            BIGSERIAL PRIMARY KEY,
  product_id    BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id       BIGINT REFERENCES users(id)   ON DELETE SET NULL,
  order_id      BIGINT,
  author        VARCHAR(150) NOT NULL,
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title         TEXT,
  body          TEXT,
  is_approved   INTEGER NOT NULL DEFAULT 0 CHECK (is_approved IN (0,1)),
  helpful_count INTEGER NOT NULL DEFAULT 0,
  reply         TEXT,
  replied_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, is_approved);

-- --------------------------------------------------------------- cart ------
CREATE TABLE IF NOT EXISTS cart_items (
  id         BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(128),
  user_id    BIGINT REFERENCES users(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id BIGINT REFERENCES variants(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL DEFAULT 1,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id);
CREATE INDEX IF NOT EXISTS idx_cart_user    ON cart_items(user_id);

CREATE TABLE IF NOT EXISTS wishlists (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, product_id)
);

-- ------------------------------------------------------------- checkout ----
CREATE TABLE IF NOT EXISTS coupons (
  id              BIGSERIAL PRIMARY KEY,
  code            VARCHAR(50) NOT NULL UNIQUE,
  description     TEXT,
  type            VARCHAR(20) NOT NULL DEFAULT 'percent'
                  CHECK (type IN ('percent','fixed','free_shipping')),
  value           NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_discount    NUMERIC(12,2),
  min_subtotal    NUMERIC(12,2) NOT NULL DEFAULT 0,
  usage_limit     INTEGER,
  per_user_limit  INTEGER NOT NULL DEFAULT 1,
  used_count      INTEGER NOT NULL DEFAULT 0,
  starts_at       TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  scope           VARCHAR(20) NOT NULL DEFAULT 'all'
                  CHECK (scope IN ('all','category','brand','product')),
  scope_id        BIGINT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_code_lower ON coupons(LOWER(code));

CREATE TABLE IF NOT EXISTS shipping_rates (
  id         BIGSERIAL PRIMARY KEY,
  region     VARCHAR(100) NOT NULL UNIQUE,
  fee        NUMERIC(12,2) NOT NULL DEFAULT 0,
  eta_days   VARCHAR(50) NOT NULL DEFAULT '1-3 days',
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id              BIGSERIAL PRIMARY KEY,
  order_number    VARCHAR(100) NOT NULL UNIQUE,
  user_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  guest_name      VARCHAR(150),
  guest_email     VARCHAR(255),
  status          VARCHAR(30) NOT NULL DEFAULT 'pending_payment'
                  CHECK (status IN ('pending_payment','paid','processing','shipped','delivered','cancelled','refunded')),
  payment_status  VARCHAR(30) NOT NULL DEFAULT 'unpaid'
                  CHECK (payment_status IN ('unpaid','paid','refunded','partially_refunded')),
  payment_method  VARCHAR(20) NOT NULL DEFAULT 'card'
                  CHECK (payment_method IN ('card','momo','cod')),
  subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  shipping_fee    NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax             NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_rate        NUMERIC(5,2) CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 100)),
  total           NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency        VARCHAR(10) NOT NULL DEFAULT 'GHS',
  coupon_id       BIGINT REFERENCES coupons(id) ON DELETE SET NULL,
  coupon_code     VARCHAR(50),
  ship_name       VARCHAR(150) NOT NULL,
  ship_phone      VARCHAR(50) NOT NULL,
  ship_email      VARCHAR(255),
  ship_region     VARCHAR(100) NOT NULL,
  ship_city       VARCHAR(100) NOT NULL,
  ship_line       TEXT NOT NULL,
  ship_landmark   TEXT,
  delivery_method VARCHAR(20) NOT NULL DEFAULT 'standard'
                  CHECK (delivery_method IN ('standard','express','pickup')),
  delivery_note   TEXT,
  tracking_number VARCHAR(100),
  carrier         VARCHAR(100),
  admin_notes     TEXT,
  cancel_reason   TEXT,
  stock_state     VARCHAR(20) NOT NULL DEFAULT 'none'
                  CHECK (stock_state IN ('none','allocated','released')),
  sold_recorded   INTEGER NOT NULL DEFAULT 0 CHECK (sold_recorded IN (0,1)),
  stock_held_until TIMESTAMPTZ,
  placed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_placed ON orders(placed_at);

CREATE TABLE IF NOT EXISTS order_items (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    BIGINT REFERENCES products(id) ON DELETE SET NULL,
  variant_id    BIGINT REFERENCES variants(id) ON DELETE SET NULL,
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(255),
  sku           VARCHAR(100),
  image         TEXT,
  variant_title VARCHAR(200),
  price         NUMERIC(12,2) NOT NULL,
  qty           INTEGER NOT NULL,
  total         NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id         BIGSERIAL PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     VARCHAR(50) NOT NULL,
  note       TEXT,
  actor      VARCHAR(50) NOT NULL DEFAULT 'system',
  is_public  INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id                BIGSERIAL PRIMARY KEY,
  order_id          BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reference         VARCHAR(120) NOT NULL UNIQUE,
  gateway           VARCHAR(50) NOT NULL DEFAULT 'biahens-stub',
  method            VARCHAR(50) NOT NULL DEFAULT 'card',
  status            VARCHAR(30) NOT NULL DEFAULT 'initiated'
                    CHECK (status IN ('initiated','success','failed','abandoned','refunded')),
  amount            NUMERIC(12,2) NOT NULL,
  currency          VARCHAR(10) NOT NULL DEFAULT 'GHS',
  channel           VARCHAR(50),
  last4             VARCHAR(10),
  payer             VARCHAR(255),
  gateway_ref       VARCHAR(120),
  provider_mode     VARCHAR(20),
  authorization_url TEXT,
  initialized_at    TIMESTAMPTZ,
  verified_at       TIMESTAMPTZ,
  needs_review      INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_receipt
  ON payments(gateway, provider_mode, gateway_ref)
  WHERE gateway = 'paystack' AND gateway_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_webhook_receipts (
  digest      VARCHAR(128) PRIMARY KEY,
  event       VARCHAR(100) NOT NULL,
  reference   VARCHAR(120),
  outcome     VARCHAR(100) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------- site management ----
CREATE TABLE IF NOT EXISTS settings (
  key        VARCHAR(100) PRIMARY KEY,
  value      TEXT,
  grp        VARCHAR(50) NOT NULL DEFAULT 'general',
  type       VARCHAR(30) NOT NULL DEFAULT 'text',
  label      VARCHAR(100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slides (
  id         BIGSERIAL PRIMARY KEY,
  title      VARCHAR(255) NOT NULL,
  subtitle   TEXT,
  badge      VARCHAR(100),
  image      TEXT,
  bg         VARCHAR(255) NOT NULL DEFAULT 'linear-gradient(120deg,#0F2A43,#1D4E6B)',
  link_text  VARCHAR(100) NOT NULL DEFAULT 'Shop now',
  link_url   TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);

CREATE TABLE IF NOT EXISTS newsletter (
  id         BIGSERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_email_lower ON newsletter(LOWER(email));

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  type       VARCHAR(50) NOT NULL DEFAULT 'info',
  level      VARCHAR(20) NOT NULL DEFAULT 'info',
  title      VARCHAR(255) NOT NULL,
  body       TEXT,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_name VARCHAR(150),
  actor_role VARCHAR(50),
  action     VARCHAR(100) NOT NULL,
  entity     VARCHAR(100),
  entity_id  VARCHAR(100),
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip         VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS password_resets (
  id         BIGSERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  token_hash VARCHAR(128) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_email ON password_resets(email);

-- express-session store for PostgreSQL
CREATE TABLE IF NOT EXISTS sessions (
  sid    VARCHAR(128) PRIMARY KEY,
  sess   JSONB NOT NULL,
  expire BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);

-- Durable delivery log for owner alerts (email and WhatsApp)
CREATE TABLE IF NOT EXISTS notification_outbox (
  id              BIGSERIAL PRIMARY KEY,
  channel         VARCHAR(20) NOT NULL CHECK (channel IN ('email','whatsapp')),
  order_id        BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  dedupe_key      VARCHAR(128) NOT NULL UNIQUE,
  recipient       VARCHAR(255) NOT NULL,
  subject         VARCHAR(255) NOT NULL,
  text            TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          VARCHAR(20) NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sending','sent','failed','unconfigured')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  locked_at       TIMESTAMPTZ,
  provider_id     VARCHAR(120),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_status ON notification_outbox(status, next_attempt_at);

-- -------------------------------------------------- baseline data & settings ----
INSERT INTO app_migrations (name, applied_at)
VALUES
  ('schema.pg.v1', NOW()),
  ('orders.public-events.v1', NOW()),
  ('store.pointgh-vat.v1', NOW()),
  ('commerce.verified-payments.v1', NOW())
ON CONFLICT (name) DO NOTHING;

INSERT INTO settings (key, value, grp, type, label, updated_at)
VALUES
  ('store_name', 'POINTGH', 'identity', 'text', 'store_name', NOW()),
  ('store_short', 'POINTGH', 'identity', 'text', 'store_short', NOW()),
  ('tax_rate', '1', 'commerce', 'number', 'VAT (%)', NOW()),
  ('currency', 'GHS', 'commerce', 'text', 'Currency', NOW())
ON CONFLICT (key) DO NOTHING;

