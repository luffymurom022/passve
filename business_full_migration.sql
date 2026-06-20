-- ══════════════════════════════════════════════════════════
-- SAFEPASS BUSINESS FULL MIGRATION (Base + Phase 14)
-- Chạy file này trong Supabase SQL Editor
-- Thay thế business_migration.sql + business_phase14_migration.sql
-- ══════════════════════════════════════════════════════════

-- ── PHẦN 1: BASE TABLES (business_migration.sql) ──

-- 1. Business Accounts
CREATE TABLE IF NOT EXISTS business_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name TEXT NOT NULL,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone TEXT,
  website TEXT,
  status TEXT DEFAULT 'pending',
  plan TEXT DEFAULT 'starter',
  plan_expires_at TIMESTAMPTZ,
  api_calls_this_month INT DEFAULT 0,
  transactions_this_month INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE business_accounts DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_business_email  ON business_accounts(email);
CREATE INDEX IF NOT EXISTS idx_business_status ON business_accounts(status);

-- 2. API Keys
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES business_accounts(id) ON DELETE CASCADE,
  name TEXT DEFAULT 'Default Key',
  api_key TEXT NOT NULL UNIQUE,
  api_secret TEXT NOT NULL,
  env_type TEXT DEFAULT 'sandbox',
  status TEXT DEFAULT 'active',
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE api_keys DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_api_keys_business ON api_keys(business_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key     ON api_keys(api_key);

-- 3. Business Escrows
CREATE TABLE IF NOT EXISTS business_escrows (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES business_accounts(id) ON DELETE CASCADE,
  api_key_id UUID REFERENCES api_keys(id),
  env_type TEXT DEFAULT 'sandbox',
  ref TEXT UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  amount BIGINT NOT NULL,
  currency TEXT DEFAULT 'VND',
  buyer_email TEXT, buyer_name TEXT,
  seller_email TEXT, seller_name TEXT,
  status TEXT DEFAULT 'pending',
  metadata JSONB,
  expires_at TIMESTAMPTZ, funded_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ, refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE business_escrows DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_biz_escrows_business ON business_escrows(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_biz_escrows_status   ON business_escrows(status);
CREATE INDEX IF NOT EXISTS idx_biz_escrows_ref      ON business_escrows(ref);

-- 4. Webhooks
CREATE TABLE IF NOT EXISTS business_webhooks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES business_accounts(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  events TEXT[] DEFAULT ARRAY['escrow.created','escrow.released','escrow.refunded'],
  retry_count INT DEFAULT 3,
  status TEXT DEFAULT 'active',
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE business_webhooks DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_webhooks_business ON business_webhooks(business_id);

-- 5. API Call Logs
CREATE TABLE IF NOT EXISTS business_api_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES business_accounts(id) ON DELETE CASCADE,
  api_key_id UUID REFERENCES api_keys(id),
  endpoint TEXT, method TEXT, status_code INT,
  env_type TEXT DEFAULT 'sandbox',
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE business_api_logs DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_api_logs_business ON business_api_logs(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_time     ON business_api_logs(created_at DESC);

-- 6. White Label Config
CREATE TABLE IF NOT EXISTS white_label_configs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES business_accounts(id) ON DELETE CASCADE UNIQUE,
  brand_name TEXT,
  logo_url TEXT,
  primary_color TEXT DEFAULT '#3d8ef8',
  secondary_color TEXT DEFAULT '#a78bfa',
  domain TEXT, custom_css TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE white_label_configs DISABLE ROW LEVEL SECURITY;

-- 7. Business KYC
CREATE TABLE IF NOT EXISTS business_kyc (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES business_accounts(id) ON DELETE CASCADE UNIQUE,
  license_url TEXT, tax_url TEXT, rep_name TEXT, rep_id_url TEXT,
  address TEXT, status TEXT DEFAULT 'pending',
  note TEXT, reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE business_kyc DISABLE ROW LEVEL SECURITY;

-- ── PHẦN 2: PHASE 14 — MERCHANT CENTER COLUMNS & TABLES ──

-- Thêm cột merchant vào business_accounts
ALTER TABLE business_accounts
  ADD COLUMN IF NOT EXISTS account_type        TEXT DEFAULT 'store',
  ADD COLUMN IF NOT EXISTS logo_url            TEXT,
  ADD COLUMN IF NOT EXISTS banner_url          TEXT,
  ADD COLUMN IF NOT EXISTS bio                 TEXT,
  ADD COLUMN IF NOT EXISTS address             TEXT,
  ADD COLUMN IF NOT EXISTS hotline             TEXT,
  ADD COLUMN IF NOT EXISTS fanpage             TEXT,
  ADD COLUMN IF NOT EXISTS store_slug          TEXT,
  ADD COLUMN IF NOT EXISTS badge               TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS is_verified_business BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS wallet_balance      BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_revenue       BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_orders        INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_rate     FLOAT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_rating          FLOAT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_count        INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rank_score          INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_fees          BIGINT DEFAULT 0;

-- Unique slug index
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_slug
  ON business_accounts(store_slug) WHERE store_slug IS NOT NULL;

-- Merchant Staff
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
ALTER TABLE merchant_staff DISABLE ROW LEVEL SECURITY;

-- Merchant Inventory
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
ALTER TABLE merchant_inventory DISABLE ROW LEVEL SECURITY;

-- Merchant Consignments
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
ALTER TABLE merchant_consignments DISABLE ROW LEVEL SECURITY;

-- Merchant Verifications
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
ALTER TABLE merchant_verifications DISABLE ROW LEVEL SECURITY;

-- Merchant Wallet Transactions
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
ALTER TABLE merchant_wallet_txns DISABLE ROW LEVEL SECURITY;

-- Merchant Franchise Branches
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
ALTER TABLE merchant_franchises DISABLE ROW LEVEL SECURITY;

-- Merchant Reviews
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
ALTER TABLE merchant_reviews DISABLE ROW LEVEL SECURITY;

-- ── INDEXES ──
CREATE INDEX IF NOT EXISTS idx_merchant_staff_biz     ON merchant_staff(business_id);
CREATE INDEX IF NOT EXISTS idx_merchant_inventory_biz ON merchant_inventory(business_id);
CREATE INDEX IF NOT EXISTS idx_merchant_consign_biz   ON merchant_consignments(business_id);
CREATE INDEX IF NOT EXISTS idx_merchant_verify_biz    ON merchant_verifications(business_id);
CREATE INDEX IF NOT EXISTS idx_merchant_wallet_biz    ON merchant_wallet_txns(business_id);
CREATE INDEX IF NOT EXISTS idx_merchant_franchise_biz ON merchant_franchises(business_id);
CREATE INDEX IF NOT EXISTS idx_merchant_reviews_biz   ON merchant_reviews(business_id);
CREATE INDEX IF NOT EXISTS idx_biz_rank_score         ON business_accounts(rank_score DESC);
