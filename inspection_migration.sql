-- ═══════════════════════════════════════════════════════════
-- PHASE 10: SAFEPASS INSPECTION CENTER
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. INSPECTION FEES TABLE (admin-configurable)
CREATE TABLE IF NOT EXISTS inspection_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  fee INTEGER NOT NULL DEFAULT 50000,
  icon TEXT DEFAULT '📦',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default fees
INSERT INTO inspection_fees (category, label, fee, icon) VALUES
  ('phone',       'Điện thoại',         50000,  '📱'),
  ('laptop',      'Laptop',            100000,  '💻'),
  ('camera',      'Máy ảnh',           100000,  '📷'),
  ('watch',       'Đồng hồ',           200000,  '⌚'),
  ('shoes',       'Giày',               50000,  '👟'),
  ('bag',         'Túi xách',           80000,  '👜'),
  ('collectible', 'Đồ sưu tầm',        150000,  '🎖️'),
  ('electronics', 'Linh kiện điện tử',  70000,  '🔌'),
  ('gadget',      'Đồ công nghệ',       80000,  '🎮')
ON CONFLICT (category) DO NOTHING;

-- 2. INSPECTION REQUESTS TABLE
CREATE TABLE IF NOT EXISTS inspection_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id UUID REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  item_title TEXT NOT NULL,
  item_description TEXT,
  fee INTEGER NOT NULL DEFAULT 50000,
  status TEXT NOT NULL DEFAULT 'pending_shipment'
    CHECK (status IN ('pending_shipment','received','inspecting','completed','rejected_by_buyer','cancelled')),
  paid BOOLEAN NOT NULL DEFAULT false,
  tracking_code TEXT,
  inspector_id UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- 3. INSPECTION REPORTS TABLE
CREATE TABLE IF NOT EXISTS inspection_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES inspection_requests(id) ON DELETE CASCADE,
  overall_score INTEGER CHECK (overall_score >= 0 AND overall_score <= 10),
  overall_condition TEXT CHECK (overall_condition IN ('excellent','good','fair','poor','reject')),
  is_authentic BOOLEAN,
  matches_description BOOLEAN,
  accessories_complete BOOLEAN,
  no_major_defects BOOLEAN,
  safepass_verified BOOLEAN NOT NULL DEFAULT false,
  checklist JSONB DEFAULT '{}',
  inspector_notes TEXT,
  video_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(request_id)
);

-- 4. INSPECTION PHOTOS TABLE
CREATE TABLE IF NOT EXISTS inspection_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES inspection_requests(id) ON DELETE CASCADE,
  photo_url TEXT NOT NULL,
  photo_type TEXT NOT NULL DEFAULT 'detail'
    CHECK (photo_type IN ('detail','defect','accessory','overall')),
  caption TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. INDEXES
CREATE INDEX IF NOT EXISTS idx_insp_req_requester ON inspection_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_insp_req_status ON inspection_requests(status);
CREATE INDEX IF NOT EXISTS idx_insp_req_order ON inspection_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_insp_photos_req ON inspection_photos(request_id);
CREATE INDEX IF NOT EXISTS idx_insp_report_req ON inspection_reports(request_id);

-- 6. STORAGE BUCKET for inspection media (run via API or dashboard)
-- supabase.storage.createBucket('inspection-media', { public: true })
