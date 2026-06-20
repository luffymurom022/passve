-- ═══════════════════════════════════════════════════════════
-- PHASE 12: SAFEPASS DELIVERY NETWORK
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. DELIVERY HUBS
CREATE TABLE IF NOT EXISTS delivery_hubs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  lat NUMERIC(10,7),
  lng NUMERIC(10,7),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive','maintenance')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO delivery_hubs (code, name, address, city) VALUES
  ('HUB-HCM-1', 'Hub Quận 7 HCM',    '123 Nguyễn Văn Linh, Q.7',     'Hồ Chí Minh'),
  ('HUB-HCM-2', 'Hub Bình Thạnh',     '456 Xô Viết Nghệ Tĩnh, BT',   'Hồ Chí Minh'),
  ('HUB-HN-1',  'Hub Hoàn Kiếm HN',   '789 Đinh Tiên Hoàng, HK',      'Hà Nội'),
  ('HUB-DN-1',  'Hub Đà Nẵng',        '101 Trần Phú, Hải Châu',       'Đà Nẵng')
ON CONFLICT (code) DO NOTHING;

-- 2. DRIVERS TABLE
CREATE TABLE IF NOT EXISTS drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  cccd TEXT,
  license_number TEXT,
  vehicle_type TEXT NOT NULL DEFAULT 'motorbike'
    CHECK (vehicle_type IN ('motorbike','car','truck','bicycle')),
  vehicle_plate TEXT,
  hub_id UUID REFERENCES delivery_hubs(id) ON DELETE SET NULL,
  service_areas TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'offline'
    CHECK (status IN ('online','offline','delivering','suspended')),
  level TEXT NOT NULL DEFAULT 'driver'
    CHECK (level IN ('driver','senior','partner','premium')),
  rating NUMERIC(3,2) DEFAULT 5.0,
  total_deliveries INTEGER NOT NULL DEFAULT 0,
  success_rate NUMERIC(5,2) DEFAULT 100.0,
  wallet_balance INTEGER NOT NULL DEFAULT 0,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  lat NUMERIC(10,7),
  lng NUMERIC(10,7),
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. DRIVER VERIFICATION DOCS
CREATE TABLE IF NOT EXISTS driver_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('cccd','gplx','face','vehicle')),
  doc_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  reviewer_notes TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(driver_id, doc_type)
);

-- 4. DELIVERY ORDERS
CREATE TABLE IF NOT EXISTS delivery_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
  hub_id UUID REFERENCES delivery_hubs(id) ON DELETE SET NULL,

  pickup_address TEXT NOT NULL,
  pickup_city TEXT NOT NULL,
  pickup_lat NUMERIC(10,7),
  pickup_lng NUMERIC(10,7),
  pickup_contact TEXT,

  delivery_address TEXT NOT NULL,
  delivery_city TEXT NOT NULL,
  delivery_lat NUMERIC(10,7),
  delivery_lng NUMERIC(10,7),
  delivery_contact TEXT,

  distance_km NUMERIC(8,2),
  estimated_minutes INTEGER,
  delivery_fee INTEGER NOT NULL DEFAULT 0,

  item_description TEXT,
  item_value INTEGER,
  weight_kg NUMERIC(6,2),
  is_fragile BOOLEAN NOT NULL DEFAULT false,
  cod_amount INTEGER DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','assigned','picking_up','picked','delivering','delivered','failed','cancelled','returned')),

  proof_photo_url TEXT,
  signature_url TEXT,
  otp_code TEXT,
  otp_verified BOOLEAN NOT NULL DEFAULT false,
  fail_reason TEXT,

  assigned_at TIMESTAMPTZ,
  picked_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. DRIVER EARNINGS
CREATE TABLE IF NOT EXISTS driver_earnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  delivery_id UUID REFERENCES delivery_orders(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('delivery_fee','bonus','penalty','withdrawal','adjustment')),
  amount INTEGER NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. DRIVER RATINGS
CREATE TABLE IF NOT EXISTS driver_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  rated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  attitude_score INTEGER CHECK (attitude_score >= 1 AND attitude_score <= 5),
  speed_score INTEGER CHECK (speed_score >= 1 AND speed_score <= 5),
  accuracy_score INTEGER CHECK (accuracy_score >= 1 AND accuracy_score <= 5),
  overall_score NUMERIC(3,2),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(delivery_id, rated_by)
);

-- 7. DELIVERY TRACKING LOG
CREATE TABLE IF NOT EXISTS delivery_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  lat NUMERIC(10,7),
  lng NUMERIC(10,7),
  note TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. INDEXES
CREATE INDEX IF NOT EXISTS idx_del_ord_driver ON delivery_orders(driver_id);
CREATE INDEX IF NOT EXISTS idx_del_ord_sender ON delivery_orders(sender_id);
CREATE INDEX IF NOT EXISTS idx_del_ord_status ON delivery_orders(status);
CREATE INDEX IF NOT EXISTS idx_del_earn_driver ON driver_earnings(driver_id);
CREATE INDEX IF NOT EXISTS idx_del_track_del ON delivery_tracking(delivery_id);
CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_hub ON drivers(hub_id);
