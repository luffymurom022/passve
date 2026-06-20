-- ══════════════════════════════════════════════════
-- PHASE 6: DIGITAL ASSET MARKETPLACE (DAM)
-- Chạy trong Supabase SQL Editor
-- ══════════════════════════════════════════════════

-- 1. LISTINGS
CREATE TABLE IF NOT EXISTS dam_listings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  category      TEXT NOT NULL DEFAULT 'other',
  subcategory   TEXT NOT NULL DEFAULT 'other',
  price         BIGINT NOT NULL DEFAULT 0,
  image_url     TEXT,
  asset_info    TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('draft','active','sold','paused','deleted')),
  view_count    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. VAULT (encrypted credentials, unlocked after escrow)
CREATE TABLE IF NOT EXISTS dam_vault (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id       UUID NOT NULL REFERENCES dam_listings(id) ON DELETE CASCADE,
  username_enc     TEXT,
  password_enc     TEXT,
  email_enc        TEXT,
  backup_codes_enc TEXT,
  notes_enc        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. ORDERS (escrow-based)
CREATE TABLE IF NOT EXISTS dam_orders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id     UUID NOT NULL REFERENCES dam_listings(id),
  buyer_id       UUID NOT NULL REFERENCES users(id),
  seller_id      UUID NOT NULL REFERENCES users(id),
  price          BIGINT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending_payment'
                   CHECK (status IN ('pending_payment','funded','delivered','confirmed','disputed','refunded','cancelled')),
  checklist      JSONB NOT NULL DEFAULT '{"change_password":false,"change_email":false,"change_phone":false,"confirm_ownership":false,"complete_transfer":false}',
  dispute_reason TEXT,
  admin_notes    TEXT,
  admin_action_by TEXT,
  funded_at      TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ,
  confirmed_at   TIMESTAMPTZ,
  disputed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. REVIEWS
CREATE TABLE IF NOT EXISTS dam_reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID NOT NULL REFERENCES dam_orders(id) ON DELETE CASCADE,
  reviewer_id  UUID NOT NULL REFERENCES users(id),
  seller_id    UUID NOT NULL REFERENCES users(id),
  rating       INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. AUDIT LOGS
CREATE TABLE IF NOT EXISTS dam_audit_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID REFERENCES dam_orders(id),
  listing_id UUID REFERENCES dam_listings(id),
  user_id    UUID REFERENCES users(id),
  action     TEXT NOT NULL,
  details    JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. INDEXES
CREATE INDEX IF NOT EXISTS idx_dam_listings_seller   ON dam_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_dam_listings_category ON dam_listings(category);
CREATE INDEX IF NOT EXISTS idx_dam_listings_status   ON dam_listings(status);
CREATE INDEX IF NOT EXISTS idx_dam_orders_buyer      ON dam_orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_dam_orders_seller     ON dam_orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_dam_orders_listing    ON dam_orders(listing_id);
CREATE INDEX IF NOT EXISTS idx_dam_orders_status     ON dam_orders(status);
CREATE INDEX IF NOT EXISTS idx_dam_reviews_seller    ON dam_reviews(seller_id);
CREATE INDEX IF NOT EXISTS idx_dam_audit_logs_order  ON dam_audit_logs(order_id);

-- 7. RLS
ALTER TABLE dam_listings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE dam_vault      ENABLE ROW LEVEL SECURITY;
ALTER TABLE dam_orders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE dam_reviews    ENABLE ROW LEVEL SECURITY;
ALTER TABLE dam_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "service_role_dam_listings"   ON dam_listings   FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "service_role_dam_vault"      ON dam_vault      FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "service_role_dam_orders"     ON dam_orders     FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "service_role_dam_reviews"    ON dam_reviews    FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "service_role_dam_audit_logs" ON dam_audit_logs FOR ALL USING (true);
