-- ══════════════════════════════════════════════════════════
-- PHASE 14: SAFEPASS BUSINESS & MERCHANT CENTER MIGRATION
-- Run in Supabase SQL Editor
-- ══════════════════════════════════════════════════════════

-- Extend business_accounts with merchant fields
ALTER TABLE business_accounts
  ADD COLUMN IF NOT EXISTS account_type TEXT DEFAULT 'store' CHECK (account_type IN ('individual','store','business','consignment')),
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS banner_url TEXT,
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS hotline TEXT,
  ADD COLUMN IF NOT EXISTS fanpage TEXT,
  ADD COLUMN IF NOT EXISTS store_slug TEXT,
  ADD COLUMN IF NOT EXISTS badge TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS is_verified_business BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'none' CHECK (verification_status IN ('none','pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS wallet_balance BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_revenue BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_orders INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_rate FLOAT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_rating FLOAT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rank_score INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_fees BIGINT DEFAULT 0;

-- Unique slug index (if not exists)
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_slug ON business_accounts(store_slug) WHERE store_slug IS NOT NULL;

-- ── MERCHANT STAFF ──
CREATE TABLE IF NOT EXISTS merchant_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','manager','staff')),
  permissions JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── MERCHANT INVENTORY ──
CREATE TABLE IF NOT EXISTS merchant_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT,
  description TEXT,
  price BIGINT NOT NULL DEFAULT 0,
  stock INT DEFAULT 0,
  category TEXT DEFAULT 'general',
  image_url TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','inactive','out_of_stock')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── MERCHANT CONSIGNMENTS ──
CREATE TABLE IF NOT EXISTS merchant_consignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  seller_name TEXT NOT NULL,
  seller_phone TEXT,
  item_name TEXT NOT NULL,
  description TEXT,
  quantity INT DEFAULT 1,
  asking_price BIGINT DEFAULT 0,
  selling_price BIGINT DEFAULT 0,
  commission_rate FLOAT DEFAULT 0.1,
  commission_earned BIGINT DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','accepted','listed','sold','returned')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── MERCHANT VERIFICATIONS ──
CREATE TABLE IF NOT EXISTS merchant_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  license_number TEXT,
  tax_id TEXT,
  representative_name TEXT,
  license_url TEXT,
  id_card_url TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

-- ── MERCHANT WALLET TRANSACTIONS ──
CREATE TABLE IF NOT EXISTS merchant_wallet_txns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('revenue','fee','withdrawal','deposit','refund')),
  amount BIGINT NOT NULL,
  description TEXT,
  ref_id TEXT,
  balance_after BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── MERCHANT FRANCHISE BRANCHES ──
CREATE TABLE IF NOT EXISTS merchant_franchises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  branch_name TEXT NOT NULL,
  address TEXT,
  manager_name TEXT,
  manager_phone TEXT,
  warehouse_id UUID,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── MERCHANT REVIEWS ──
CREATE TABLE IF NOT EXISTS merchant_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  reviewer_name TEXT,
  reviewer_phone TEXT,
  rating INT CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  order_ref TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── INDEXES ──
CREATE INDEX IF NOT EXISTS idx_merchant_staff_biz      ON merchant_staff(business_id);
CREATE INDEX IF NOT EXISTS idx_merchant_inventory_biz  ON merchant_inventory(business_id);
CREATE INDEX IF NOT EXISTS idx_merchant_consign_biz    ON merchant_consignments(business_id);
CREATE INDEX IF NOT EXISTS idx_merchant_verify_biz     ON merchant_verifications(business_id);
CREATE INDEX IF NOT EXISTS idx_merchant_wallet_biz     ON merchant_wallet_txns(business_id);
CREATE INDEX IF NOT EXISTS idx_merchant_franchise_biz  ON merchant_franchises(business_id);
CREATE INDEX IF NOT EXISTS idx_merchant_reviews_biz    ON merchant_reviews(business_id);
CREATE INDEX IF NOT EXISTS idx_biz_rank_score          ON business_accounts(rank_score DESC);
