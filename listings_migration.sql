-- ═══════════════════════════════════════════════════════
--  SafePass Multi-Category Marketplace Migration
--  Run this in Supabase SQL Editor (Dashboard → SQL Editor)
-- ═══════════════════════════════════════════════════════

-- 1. Create listings table (6 listing types)
CREATE TABLE IF NOT EXISTS listings (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_name   TEXT    NOT NULL DEFAULT '',
  type          TEXT    NOT NULL DEFAULT 'ticket'
                        CHECK (type IN ('ticket','product','account','course','service','booking')),
  title         TEXT    NOT NULL,
  description   TEXT    DEFAULT '',
  price         NUMERIC NOT NULL CHECK (price > 0),
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  images        JSONB   DEFAULT '[]',
  status        TEXT    NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','pending','sold','hidden')),
  -- Extra metadata fields (all optional)
  event_date    TEXT,
  location      TEXT    DEFAULT '',
  section       TEXT    DEFAULT '',
  category      TEXT    DEFAULT '',
  delivery_hint TEXT    DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Add listing reference columns to orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS listing_id   UUID REFERENCES listings(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS listing_type TEXT;

-- 3. Performance indexes
CREATE INDEX IF NOT EXISTS listings_seller_id_idx  ON listings(seller_id);
CREATE INDEX IF NOT EXISTS listings_type_idx       ON listings(type);
CREATE INDEX IF NOT EXISTS listings_status_idx     ON listings(status);
CREATE INDEX IF NOT EXISTS listings_created_at_idx ON listings(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_listing_id_idx   ON orders(listing_id);

-- 4. Optional: Enable Row Level Security (service role key bypasses RLS automatically)
-- ALTER TABLE listings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE listings IS 'Multi-category marketplace: ticket, product, account, course, service, booking';
COMMENT ON COLUMN listings.type IS 'ticket=Pass Vé, product=Pass Đồ, account=Pass Tài Khoản, course=Pass Khóa Học, service=Pass Dịch Vụ, booking=Pass Booking';
COMMENT ON COLUMN orders.listing_id IS 'Reference to listings table (new system). Legacy orders use ticket_id instead.';
