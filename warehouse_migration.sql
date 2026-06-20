-- ═══════════════════════════════════════════════════════════
-- PHASE 11: SAFEPASS WAREHOUSE NETWORK
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. WAREHOUSES TABLE
CREATE TABLE IF NOT EXISTS warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1000,
  used_slots INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','maintenance','full','inactive')),
  manager_name TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed 4 default warehouses
INSERT INTO warehouses (code, name, address, city, capacity) VALUES
  ('WH-HCM', 'Kho Hồ Chí Minh',    '123 Nguyễn Văn Linh, Q.7',     'Hồ Chí Minh', 5000),
  ('WH-HN',  'Kho Hà Nội',          '456 Giải Phóng, Hoàng Mai',     'Hà Nội',       4000),
  ('WH-DN',  'Kho Đà Nẵng',         '789 Nguyễn Tất Thành, Hải Châu','Đà Nẵng',      2000),
  ('WH-CT',  'Kho Cần Thơ',         '101 Trần Phú, Ninh Kiều',       'Cần Thơ',      1500)
ON CONFLICT (code) DO NOTHING;

-- 2. WAREHOUSE ZONES
CREATE TABLE IF NOT EXISTS warehouse_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  zone_code TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  shelf_count INTEGER NOT NULL DEFAULT 10,
  slots_per_shelf INTEGER NOT NULL DEFAULT 20,
  category_focus TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(warehouse_id, zone_code)
);

-- 3. STORAGE FEES TABLE
CREATE TABLE IF NOT EXISTS warehouse_storage_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  size_category TEXT NOT NULL UNIQUE
    CHECK (size_category IN ('small','medium','large','extra_large')),
  label TEXT NOT NULL,
  fee_per_day INTEGER NOT NULL DEFAULT 2000,
  fee_per_week INTEGER NOT NULL DEFAULT 12000,
  fee_per_month INTEGER NOT NULL DEFAULT 40000,
  max_weight_kg NUMERIC(8,2),
  description TEXT
);

INSERT INTO warehouse_storage_fees (size_category, label, fee_per_day, fee_per_week, fee_per_month, max_weight_kg, description) VALUES
  ('small',       'Nhỏ (< 1kg)',       2000,  12000,  40000,  1.0,  'Điện thoại, đồng hồ, phụ kiện nhỏ'),
  ('medium',      'Vừa (1–5kg)',        5000,  30000, 100000,  5.0,  'Laptop, máy ảnh, giày dép'),
  ('large',       'Lớn (5–20kg)',      10000,  60000, 200000, 20.0,  'TV, tủ nhỏ, xe đạp điện'),
  ('extra_large', 'Rất lớn (> 20kg)', 20000, 120000, 400000,  NULL, 'Máy móc, nội thất, hàng cồng kềnh')
ON CONFLICT (size_category) DO NOTHING;

-- 4. CONSIGNMENT / INVENTORY TABLE
CREATE TABLE IF NOT EXISTS warehouse_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT UNIQUE NOT NULL DEFAULT 'SKU-' || substr(gen_random_uuid()::TEXT, 1, 8),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  zone_id UUID REFERENCES warehouse_zones(id) ON DELETE SET NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  size_category TEXT NOT NULL DEFAULT 'small'
    CHECK (size_category IN ('small','medium','large','extra_large')),
  quantity INTEGER NOT NULL DEFAULT 1,
  weight_kg NUMERIC(8,2),
  condition TEXT NOT NULL DEFAULT 'new'
    CHECK (condition IN ('new','like_new','good','fair','poor')),
  status TEXT NOT NULL DEFAULT 'pending_arrival'
    CHECK (status IN ('pending_arrival','received','inspected','stored','reserved','picked','dispatched','returned','lost')),
  shelf_location TEXT,
  photo_urls JSONB DEFAULT '[]',
  notes TEXT,
  arrived_at TIMESTAMPTZ,
  stored_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. STORAGE BILLING TABLE
CREATE TABLE IF NOT EXISTS warehouse_billing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id UUID NOT NULL REFERENCES warehouse_inventory(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  billing_period TEXT NOT NULL CHECK (billing_period IN ('daily','weekly','monthly')),
  fee_per_unit INTEGER NOT NULL,
  days_stored INTEGER NOT NULL DEFAULT 0,
  total_fee INTEGER NOT NULL DEFAULT 0,
  paid BOOLEAN NOT NULL DEFAULT false,
  period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. WAREHOUSE TRANSFERS
CREATE TABLE IF NOT EXISTS warehouse_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id UUID NOT NULL REFERENCES warehouse_inventory(id) ON DELETE CASCADE,
  from_warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  to_warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  initiated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_transit','completed','cancelled')),
  tracking_code TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- 7. PICK & PACK ORDERS
CREATE TABLE IF NOT EXISTS warehouse_pickpack (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id UUID NOT NULL REFERENCES warehouse_inventory(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','picking','packing','ready','dispatched','cancelled')),
  tracking_code TEXT,
  carrier TEXT,
  packed_weight_kg NUMERIC(8,2),
  shipping_label_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ
);

-- 8. WAREHOUSE RECEIVING LOG
CREATE TABLE IF NOT EXISTS warehouse_receiving (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id UUID NOT NULL REFERENCES warehouse_inventory(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  actual_weight_kg NUMERIC(8,2),
  condition_on_arrival TEXT,
  photo_urls JSONB DEFAULT '[]',
  discrepancy_notes TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. INDEXES
CREATE INDEX IF NOT EXISTS idx_wh_inv_owner ON warehouse_inventory(owner_id);
CREATE INDEX IF NOT EXISTS idx_wh_inv_status ON warehouse_inventory(status);
CREATE INDEX IF NOT EXISTS idx_wh_inv_warehouse ON warehouse_inventory(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_wh_billing_owner ON warehouse_billing(owner_id);
CREATE INDEX IF NOT EXISTS idx_wh_transfer_inv ON warehouse_transfers(inventory_id);
CREATE INDEX IF NOT EXISTS idx_wh_pickpack_inv ON warehouse_pickpack(inventory_id);
CREATE INDEX IF NOT EXISTS idx_wh_receiving_inv ON warehouse_receiving(inventory_id);
