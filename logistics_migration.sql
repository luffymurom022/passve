-- ══════════════════════════════════════════════════════════
-- SAFEPASS LOGISTICS HUB — Migration SQL
-- Chạy file này trong Supabase SQL Editor
-- ══════════════════════════════════════════════════════════

-- 1. Warehouses (kho trung chuyển)
CREATE TABLE IF NOT EXISTS lg_warehouses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  province TEXT NOT NULL,
  district TEXT,
  phone TEXT,
  manager TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE lg_warehouses DISABLE ROW LEVEL SECURITY;
INSERT INTO lg_warehouses (name, address, province, district, phone, manager) VALUES
  ('Kho HCM - Bình Thạnh', '123 Phan Văn Trị, P.10', 'Hồ Chí Minh', 'Bình Thạnh', '0901111001', 'Nguyễn Văn A'),
  ('Kho HCM - Gò Vấp',    '456 Quang Trung, P.8',   'Hồ Chí Minh', 'Gò Vấp',    '0901111002', 'Trần Thị B'),
  ('Kho Hà Nội - Hoàn Kiếm','789 Đinh Tiên Hoàng',  'Hà Nội',      'Hoàn Kiếm', '0901111003', 'Lê Văn C'),
  ('Kho Đà Nẵng - Hải Châu','321 Lê Duẩn',          'Đà Nẵng',     'Hải Châu',  '0901111004', 'Phạm Thị D')
ON CONFLICT DO NOTHING;

-- 2. Drivers (tài xế)
CREATE TABLE IF NOT EXISTS lg_drivers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  vehicle_type TEXT DEFAULT 'motorbike', -- motorbike | van | truck
  vehicle_plate TEXT,
  province TEXT,
  status TEXT DEFAULT 'available', -- available | busy | offline
  total_deliveries INT DEFAULT 0,
  rating NUMERIC(3,2) DEFAULT 5.0,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE lg_drivers DISABLE ROW LEVEL SECURITY;

-- 3. Shipments (đơn giao hàng chính)
CREATE TABLE IF NOT EXISTS lg_shipments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tracking_number TEXT UNIQUE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Sender info
  sender_name TEXT NOT NULL,
  sender_phone TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  sender_district TEXT,
  sender_province TEXT NOT NULL,
  -- Receiver info
  receiver_name TEXT NOT NULL,
  receiver_phone TEXT NOT NULL,
  receiver_address TEXT NOT NULL,
  receiver_district TEXT,
  receiver_province TEXT NOT NULL,
  -- Package info
  cargo_type TEXT DEFAULT 'general', -- general | fragile | electronics | documents | food | clothing
  weight NUMERIC(6,2) DEFAULT 0.5, -- kg
  length NUMERIC(6,2), -- cm
  width NUMERIC(6,2),
  height NUMERIC(6,2),
  description TEXT,
  declared_value BIGINT DEFAULT 0,
  -- Pricing
  shipping_fee BIGINT DEFAULT 0,
  insurance_fee BIGINT DEFAULT 0,
  total_fee BIGINT DEFAULT 0,
  has_insurance BOOLEAN DEFAULT FALSE,
  cod_amount BIGINT DEFAULT 0, -- cash on delivery
  -- Assignment
  driver_id UUID REFERENCES lg_drivers(id) ON DELETE SET NULL,
  warehouse_id UUID REFERENCES lg_warehouses(id) ON DELETE SET NULL,
  -- Status
  status TEXT DEFAULT 'pending', -- pending | picked_up | in_transit | at_warehouse | out_for_delivery | delivered | returned | cancelled
  service_type TEXT DEFAULT 'standard', -- standard | express | same_day
  pickup_date DATE,
  pickup_time_slot TEXT,
  estimated_delivery DATE,
  delivered_at TIMESTAMPTZ,
  -- Payment
  payment_method TEXT DEFAULT 'sender', -- sender | receiver (COD)
  is_paid BOOLEAN DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE lg_shipments DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_lg_shipments_user ON lg_shipments(user_id);
CREATE INDEX IF NOT EXISTS idx_lg_shipments_status ON lg_shipments(status);
CREATE INDEX IF NOT EXISTS idx_lg_shipments_tracking ON lg_shipments(tracking_number);
CREATE INDEX IF NOT EXISTS idx_lg_shipments_created ON lg_shipments(created_at DESC);

-- 4. Tracking Events (lịch sử tracking)
CREATE TABLE IF NOT EXISTS lg_tracking_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  shipment_id UUID REFERENCES lg_shipments(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  location TEXT,
  description TEXT NOT NULL,
  created_by TEXT DEFAULT 'system', -- system | driver | admin
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE lg_tracking_events DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_lg_tracking_shipment ON lg_tracking_events(shipment_id, created_at ASC);

-- 5. Pickup Schedules (lịch lấy hàng)
CREATE TABLE IF NOT EXISTS lg_pickups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  shipment_id UUID REFERENCES lg_shipments(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  pickup_date DATE NOT NULL,
  time_slot TEXT NOT NULL, -- 08:00-12:00 | 12:00-17:00 | 17:00-21:00
  pickup_address TEXT NOT NULL,
  contact_name TEXT,
  contact_phone TEXT,
  status TEXT DEFAULT 'scheduled', -- scheduled | completed | cancelled
  driver_id UUID REFERENCES lg_drivers(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE lg_pickups DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_lg_pickups_user ON lg_pickups(user_id);
CREATE INDEX IF NOT EXISTS idx_lg_pickups_date ON lg_pickups(pickup_date, status);

-- 6. Routes (tuyến đường admin)
CREATE TABLE IF NOT EXISTS lg_routes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  from_province TEXT NOT NULL,
  to_province TEXT NOT NULL,
  base_fee BIGINT DEFAULT 20000,
  per_kg_fee BIGINT DEFAULT 5000,
  est_days INT DEFAULT 2,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE lg_routes DISABLE ROW LEVEL SECURITY;
-- Seed common routes
INSERT INTO lg_routes (name, from_province, to_province, base_fee, per_kg_fee, est_days) VALUES
  ('HCM nội thành',     'Hồ Chí Minh', 'Hồ Chí Minh', 15000, 3000, 1),
  ('HCM → Hà Nội',      'Hồ Chí Minh', 'Hà Nội',       45000, 8000, 3),
  ('HCM → Đà Nẵng',     'Hồ Chí Minh', 'Đà Nẵng',      35000, 7000, 2),
  ('Hà Nội nội thành',  'Hà Nội',      'Hà Nội',        15000, 3000, 1),
  ('Hà Nội → HCM',      'Hà Nội',      'Hồ Chí Minh',  45000, 8000, 3),
  ('Hà Nội → Đà Nẵng',  'Hà Nội',      'Đà Nẵng',       35000, 7000, 2),
  ('Nội tỉnh',          'other',       'other',          20000, 5000, 2),
  ('Liên tỉnh',         'other',       'other2',         30000, 6000, 3)
ON CONFLICT DO NOTHING;
