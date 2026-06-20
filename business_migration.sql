-- ══════════════════════════════════════════════════════════
-- SAFEPASS BUSINESS — Migration SQL
-- Chạy file này trong Supabase SQL Editor
-- ══════════════════════════════════════════════════════════

-- 1. Business Accounts
CREATE TABLE IF NOT EXISTS business_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name TEXT NOT NULL,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone TEXT,
  website TEXT,
  status TEXT DEFAULT 'pending', -- pending | active | suspended
  plan TEXT DEFAULT 'starter',   -- starter | growth | enterprise
  plan_expires_at TIMESTAMPTZ,
  api_calls_this_month INT DEFAULT 0,
  transactions_this_month INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE business_accounts DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_business_email ON business_accounts(email);
CREATE INDEX IF NOT EXISTS idx_business_status ON business_accounts(status);

-- 2. API Keys
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES business_accounts(id) ON DELETE CASCADE,
  name TEXT DEFAULT 'Default Key',
  api_key TEXT NOT NULL UNIQUE,
  api_secret TEXT NOT NULL,
  env_type TEXT DEFAULT 'sandbox', -- sandbox | production
  status TEXT DEFAULT 'active',    -- active | revoked
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE api_keys DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_api_keys_business ON api_keys(business_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);

-- 3. Business Escrows (created via API)
CREATE TABLE IF NOT EXISTS business_escrows (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES business_accounts(id) ON DELETE CASCADE,
  api_key_id UUID REFERENCES api_keys(id),
  env_type TEXT DEFAULT 'sandbox',
  ref TEXT UNIQUE,               -- business-provided reference
  title TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  amount BIGINT NOT NULL,
  currency TEXT DEFAULT 'VND',
  buyer_email TEXT,
  buyer_name TEXT,
  seller_email TEXT,
  seller_name TEXT,
  status TEXT DEFAULT 'pending', -- pending | funded | delivered | completed | refunded | disputed | cancelled
  metadata JSONB,
  expires_at TIMESTAMPTZ,
  funded_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE business_escrows DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_biz_escrows_business ON business_escrows(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_biz_escrows_status ON business_escrows(status);
CREATE INDEX IF NOT EXISTS idx_biz_escrows_ref ON business_escrows(ref);

-- 4. Webhooks
CREATE TABLE IF NOT EXISTS business_webhooks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES business_accounts(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  events TEXT[] DEFAULT ARRAY['escrow.created','escrow.released','escrow.refunded'],
  retry_count INT DEFAULT 3,
  status TEXT DEFAULT 'active', -- active | disabled
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE business_webhooks DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_webhooks_business ON business_webhooks(business_id);

-- 5. API Call Logs (for billing/analytics)
CREATE TABLE IF NOT EXISTS business_api_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES business_accounts(id) ON DELETE CASCADE,
  api_key_id UUID REFERENCES api_keys(id),
  endpoint TEXT,
  method TEXT,
  status_code INT,
  env_type TEXT DEFAULT 'sandbox',
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE business_api_logs DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_api_logs_business ON business_api_logs(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_time ON business_api_logs(created_at DESC);

-- 6. White Label Config
CREATE TABLE IF NOT EXISTS white_label_configs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES business_accounts(id) ON DELETE CASCADE UNIQUE,
  brand_name TEXT,
  logo_url TEXT,
  primary_color TEXT DEFAULT '#3d8ef8',
  secondary_color TEXT DEFAULT '#a78bfa',
  domain TEXT,
  custom_css TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE white_label_configs DISABLE ROW LEVEL SECURITY;

-- 7. Business KYC (company documents)
CREATE TABLE IF NOT EXISTS business_kyc (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES business_accounts(id) ON DELETE CASCADE UNIQUE,
  license_url TEXT,   -- Giấy phép kinh doanh
  tax_url TEXT,       -- MST
  rep_name TEXT,      -- Tên đại diện
  rep_id_url TEXT,    -- CCCD đại diện
  address TEXT,
  status TEXT DEFAULT 'pending', -- pending | approved | rejected
  note TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE business_kyc DISABLE ROW LEVEL SECURITY;
