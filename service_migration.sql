-- ══════════════════════════════════════════════════════════
--  SAFEPASS — PASS DỊCH VỤ (Freelance Marketplace)
--  Chạy file này trong Supabase SQL Editor
-- ══════════════════════════════════════════════════════════

-- ── 1. service_listings ──────────────────────────────────
CREATE TABLE IF NOT EXISTS service_listings (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  seller_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      TEXT        NOT NULL,
  title         TEXT        NOT NULL,
  description   TEXT        NOT NULL,
  price         NUMERIC     NOT NULL DEFAULT 0,
  delivery_days INTEGER     NOT NULL DEFAULT 3,
  revision_count INTEGER    NOT NULL DEFAULT 1,
  status        TEXT        NOT NULL DEFAULT 'active',  -- active | paused | rejected
  image_url     TEXT,
  avg_rating    NUMERIC     DEFAULT 0,
  review_count  INTEGER     DEFAULT 0,
  total_orders  INTEGER     DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. service_packages (Basic / Standard / Premium) ─────
CREATE TABLE IF NOT EXISTS service_packages (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  service_id     UUID        NOT NULL REFERENCES service_listings(id) ON DELETE CASCADE,
  package_name   TEXT        NOT NULL,
  price          NUMERIC     NOT NULL,
  delivery_days  INTEGER     NOT NULL,
  revision_count INTEGER     NOT NULL DEFAULT 1,
  features       JSONB       DEFAULT '[]',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. service_orders ────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_orders (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  service_id      UUID        NOT NULL REFERENCES service_listings(id),
  package_id      UUID        REFERENCES service_packages(id),
  buyer_id        UUID        NOT NULL REFERENCES users(id),
  seller_id       UUID        NOT NULL REFERENCES users(id),
  package_name    TEXT,
  service_title   TEXT,
  price           NUMERIC     NOT NULL,
  fee             NUMERIC     NOT NULL DEFAULT 0,
  seller_payout   NUMERIC     NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending',
  -- pending | in_progress | submitted | revision_requested | completed | cancelled | disputed
  requirements    TEXT,
  revision_count  INTEGER     DEFAULT 0,
  max_revisions   INTEGER     DEFAULT 1,
  deadline_at     TIMESTAMPTZ,
  submitted_at    TIMESTAMPTZ,
  approved_at     TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  disputed_at     TIMESTAMPTZ,
  auto_release_at TIMESTAMPTZ,
  dispute_reason  TEXT,
  admin_note      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 4. deliverables ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS deliverables (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id   UUID        NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  seller_id  UUID        NOT NULL,
  file_url   TEXT,
  file_name  TEXT,
  message    TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 5. service_reviews ───────────────────────────────────
CREATE TABLE IF NOT EXISTS service_reviews (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id   UUID        NOT NULL REFERENCES service_orders(id),
  service_id UUID        NOT NULL,
  buyer_id   UUID        NOT NULL,
  seller_id  UUID        NOT NULL,
  rating     INTEGER     NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(order_id)
);

-- ── 6. service_messages (order chat) ─────────────────────
CREATE TABLE IF NOT EXISTS service_messages (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id   UUID        NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  sender_id  UUID        NOT NULL,
  content    TEXT,
  file_url   TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_svc_listings_seller   ON service_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_svc_listings_status   ON service_listings(status);
CREATE INDEX IF NOT EXISTS idx_svc_listings_cat      ON service_listings(category);
CREATE INDEX IF NOT EXISTS idx_svc_orders_buyer      ON service_orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_svc_orders_seller     ON service_orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_svc_orders_status     ON service_orders(status);
CREATE INDEX IF NOT EXISTS idx_svc_orders_autorel    ON service_orders(auto_release_at);
CREATE INDEX IF NOT EXISTS idx_deliverables_order    ON deliverables(order_id);
CREATE INDEX IF NOT EXISTS idx_svc_messages_order    ON service_messages(order_id);
CREATE INDEX IF NOT EXISTS idx_svc_reviews_service   ON service_reviews(service_id);
