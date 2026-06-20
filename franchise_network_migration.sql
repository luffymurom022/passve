-- ══════════════════════════════════════════════════════════
-- SAFEPASS PHASE 15: FRANCHISE NETWORK MIGRATION
-- Chạy file này trong Supabase SQL Editor
-- ══════════════════════════════════════════════════════════

-- 1. Franchise Partners (đối tác / đại lý)
CREATE TABLE IF NOT EXISTS franchise_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_type TEXT NOT NULL DEFAULT 'individual'
    CHECK (partner_type IN ('individual','store','business')),
  full_name TEXT NOT NULL,
  business_name TEXT,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email TEXT,
  address TEXT NOT NULL,
  province TEXT NOT NULL,
  district TEXT,
  ward TEXT,
  lat FLOAT,
  lng FLOAT,
  hotline TEXT,
  id_card TEXT,
  license_number TEXT,
  tax_id TEXT,
  -- Services offered
  service_receiving BOOLEAN DEFAULT true,
  service_consignment BOOLEAN DEFAULT false,
  service_inspection BOOLEAN DEFAULT false,
  service_delivery BOOLEAN DEFAULT false,
  -- Status & tier
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','active','suspended','rejected')),
  tier TEXT DEFAULT 'basic'
    CHECK (tier IN ('basic','silver','gold','platinum')),
  -- Performance
  wallet_balance BIGINT DEFAULT 0,
  total_earnings BIGINT DEFAULT 0,
  total_transactions INT DEFAULT 0,
  completion_rate FLOAT DEFAULT 0,
  avg_rating FLOAT DEFAULT 0,
  rating_count INT DEFAULT 0,
  rank_score INT DEFAULT 0,
  -- Admin
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  rejection_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE franchise_partners DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fp_phone    ON franchise_partners(phone);
CREATE INDEX IF NOT EXISTS idx_fp_status   ON franchise_partners(status);
CREATE INDEX IF NOT EXISTS idx_fp_province ON franchise_partners(province);
CREATE INDEX IF NOT EXISTS idx_fp_rank     ON franchise_partners(rank_score DESC);

-- 2. Service Points (điểm dịch vụ vật lý)
CREATE TABLE IF NOT EXISTS franchise_service_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES franchise_partners(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  province TEXT NOT NULL,
  district TEXT,
  ward TEXT,
  lat FLOAT,
  lng FLOAT,
  point_type TEXT NOT NULL DEFAULT 'receiving'
    CHECK (point_type IN ('receiving','consignment','inspection','delivery','full')),
  operating_hours TEXT DEFAULT '8:00 - 20:00',
  hotline TEXT,
  capacity INT DEFAULT 100,
  current_load INT DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','inactive','full')),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE franchise_service_points DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fsp_partner   ON franchise_service_points(partner_id);
CREATE INDEX IF NOT EXISTS idx_fsp_province  ON franchise_service_points(province);
CREATE INDEX IF NOT EXISTS idx_fsp_type      ON franchise_service_points(point_type);
CREATE INDEX IF NOT EXISTS idx_fsp_status    ON franchise_service_points(status);

-- 3. Franchise Transactions (giao dịch tại điểm)
CREATE TABLE IF NOT EXISTS franchise_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES franchise_partners(id) ON DELETE CASCADE,
  service_point_id UUID REFERENCES franchise_service_points(id),
  txn_type TEXT NOT NULL
    CHECK (txn_type IN ('receiving','consignment','inspection','delivery')),
  ref_code TEXT UNIQUE DEFAULT ('FTX-' || upper(substr(md5(random()::text),1,8))),
  sender_name TEXT,
  sender_phone TEXT,
  receiver_name TEXT,
  receiver_phone TEXT,
  item_description TEXT,
  item_value BIGINT DEFAULT 0,
  service_fee BIGINT DEFAULT 0,
  commission_rate FLOAT DEFAULT 0.05,
  commission_earned BIGINT DEFAULT 0,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','cancelled','returned')),
  notes TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE franchise_transactions DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_ftxn_partner ON franchise_transactions(partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ftxn_status  ON franchise_transactions(status);
CREATE INDEX IF NOT EXISTS idx_ftxn_ref     ON franchise_transactions(ref_code);
CREATE INDEX IF NOT EXISTS idx_ftxn_type    ON franchise_transactions(txn_type);

-- 4. Partner Earnings (hoa hồng / ví)
CREATE TABLE IF NOT EXISTS franchise_earnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES franchise_partners(id) ON DELETE CASCADE,
  txn_id UUID REFERENCES franchise_transactions(id),
  earning_type TEXT NOT NULL
    CHECK (earning_type IN ('commission','bonus','penalty','withdrawal','deposit','adjustment')),
  amount BIGINT NOT NULL,
  description TEXT,
  balance_after BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE franchise_earnings DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fe_partner ON franchise_earnings(partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fe_type    ON franchise_earnings(earning_type);

-- 5. Partner Ratings (đánh giá đại lý)
CREATE TABLE IF NOT EXISTS franchise_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES franchise_partners(id) ON DELETE CASCADE,
  txn_id UUID REFERENCES franchise_transactions(id),
  rater_name TEXT,
  rater_phone TEXT,
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE franchise_ratings DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fr_partner ON franchise_ratings(partner_id);

-- 6. Franchise Announcements (thông báo từ admin)
CREATE TABLE IF NOT EXISTS franchise_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tier_target TEXT DEFAULT 'all',
  is_pinned BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE franchise_announcements DISABLE ROW LEVEL SECURITY;

-- Seed sample announcements
INSERT INTO franchise_announcements (title, content, tier_target, is_pinned) VALUES
  ('Chào mừng đại lý mới!', 'Cảm ơn bạn đã tham gia mạng lưới SafePass. Hãy hoàn thiện hồ sơ để được duyệt nhanh nhất.', 'all', true),
  ('Chương trình thưởng tháng 6', 'Đại lý đạt 50+ giao dịch trong tháng 6 nhận thưởng thêm 500,000₫ vào ví.', 'all', false),
  ('Nâng cấp tier Gold & Platinum', 'Đại lý Gold: hoa hồng 7%. Platinum: 10% + hỗ trợ marketing. Liên hệ admin để biết thêm.', 'silver', false)
ON CONFLICT DO NOTHING;
