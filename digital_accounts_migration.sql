-- ══════════════════════════════════════════════════════════
--  SAFEPASS — DIGITAL ACCOUNT PASS MIGRATION
--  Chạy toàn bộ file này trong Supabase SQL Editor
-- ══════════════════════════════════════════════════════════

-- 1. Bảng digital_listings: listing tài khoản số (giống tickets nhưng cho digital)
CREATE TABLE IF NOT EXISTS digital_listings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  asset_type   TEXT NOT NULL,
  price        BIGINT NOT NULL,
  fee_percent  NUMERIC(4,2) NOT NULL DEFAULT 3,
  status       TEXT NOT NULL DEFAULT 'active', -- active | paused | deleted
  total_qty    INT NOT NULL DEFAULT 0,
  sold_qty     INT NOT NULL DEFAULT 0,
  available_qty INT NOT NULL DEFAULT 0,
  image_url    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Bảng asset_inventory: kho tài khoản thực tế (mã hóa)
CREATE TABLE IF NOT EXISTS asset_inventory (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id     UUID NOT NULL REFERENCES digital_listings(id) ON DELETE CASCADE,
  seller_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username_enc   TEXT NOT NULL,
  password_enc   TEXT NOT NULL,
  backup_email_enc TEXT,
  notes_enc      TEXT,
  status         TEXT NOT NULL DEFAULT 'available', -- available | reserved | sold | disabled
  reserved_at    TIMESTAMPTZ,
  sold_at        TIMESTAMPTZ,
  digital_order_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Bảng digital_orders: đơn hàng tài khoản số
CREATE TABLE IF NOT EXISTS digital_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      UUID NOT NULL REFERENCES digital_listings(id),
  inventory_id    UUID REFERENCES asset_inventory(id),
  buyer_id        UUID NOT NULL REFERENCES users(id),
  seller_id       UUID NOT NULL REFERENCES users(id),
  listing_title   TEXT NOT NULL,
  asset_type      TEXT NOT NULL,
  price           BIGINT NOT NULL,
  fee             BIGINT NOT NULL DEFAULT 0,
  seller_payout   BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending_delivery',
  -- pending_delivery | delivered | confirmed | disputed | refunded | replaced
  delivered_at    TIMESTAMPTZ,
  confirmed_at    TIMESTAMPTZ,
  dispute_reason  TEXT,
  dispute_at      TIMESTAMPTZ,
  admin_note      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Index để query nhanh
CREATE INDEX IF NOT EXISTS idx_digital_listings_seller ON digital_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_digital_listings_type ON digital_listings(asset_type);
CREATE INDEX IF NOT EXISTS idx_digital_listings_status ON digital_listings(status);
CREATE INDEX IF NOT EXISTS idx_asset_inventory_listing ON asset_inventory(listing_id);
CREATE INDEX IF NOT EXISTS idx_asset_inventory_status ON asset_inventory(status);
CREATE INDEX IF NOT EXISTS idx_digital_orders_buyer ON digital_orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_digital_orders_seller ON digital_orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_digital_orders_listing ON digital_orders(listing_id);

-- 5. FK ngược: asset_inventory.digital_order_id → digital_orders.id
ALTER TABLE asset_inventory
  ADD CONSTRAINT fk_inventory_digital_order
  FOREIGN KEY (digital_order_id) REFERENCES digital_orders(id)
  ON DELETE SET NULL;
