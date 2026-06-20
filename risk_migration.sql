-- ═══════════════════════════════════════════════════════════
-- PHASE 13: SAFEPASS AI ANTI-FRAUD & RISK ENGINE
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. USER RISK PROFILES
CREATE TABLE IF NOT EXISTS risk_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
  risk_level TEXT NOT NULL DEFAULT 'safe'
    CHECK (risk_level IN ('safe','medium','high','critical')),
  flagged BOOLEAN NOT NULL DEFAULT false,
  banned_reason TEXT,
  -- behavior signals
  dispute_rate NUMERIC(5,2) DEFAULT 0,
  refund_rate NUMERIC(5,2) DEFAULT 0,
  avg_review_score NUMERIC(3,2) DEFAULT 5,
  total_transactions INTEGER DEFAULT 0,
  suspicious_logins INTEGER DEFAULT 0,
  -- ai meta
  last_analyzed TIMESTAMPTZ,
  analysis_version TEXT DEFAULT 'v1',
  ml_features JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. RISK ALERTS
CREATE TABLE IF NOT EXISTS risk_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL
    CHECK (alert_type IN ('user','product','transaction','delivery','account','system')),
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low','medium','high','critical')),
  title TEXT NOT NULL,
  description TEXT,
  entity_id UUID,
  entity_type TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','reviewing','resolved','dismissed','actioned')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  reviewer_notes TEXT,
  auto_flagged BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. RISK RULES (configurable thresholds)
CREATE TABLE IF NOT EXISTS risk_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key TEXT NOT NULL UNIQUE,
  rule_name TEXT NOT NULL,
  description TEXT,
  threshold NUMERIC(20,4) NOT NULL,
  score_delta INTEGER NOT NULL DEFAULT 10,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO risk_rules (rule_key, rule_name, description, threshold, score_delta) VALUES
  ('high_dispute_rate',     'Tỷ lệ tranh chấp cao',      'Dispute rate vượt ngưỡng',        0.2,  20),
  ('high_refund_rate',      'Tỷ lệ hoàn tiền cao',        'Refund rate vượt ngưỡng',         0.3,  15),
  ('low_review_score',      'Đánh giá thấp',              'Điểm review dưới ngưỡng',         3.0,  10),
  ('suspicious_logins',     'Đăng nhập đáng ngờ',         'Nhiều IP/device khác nhau',       3.0,  25),
  ('price_anomaly',         'Giá bất thường',             'Giá thấp hơn 60% thị trường',     0.6,  15),
  ('spam_listings',         'Spam đăng bán',              'Đăng quá nhiều bài trong 24h',    10.0, 20),
  ('large_transaction',     'Giao dịch giá trị lớn',      'Giao dịch trên 50 triệu VND',50000000,  5),
  ('no_kyc_high_value',     'Không KYC giao dịch lớn',    'Chưa xác minh nhưng giao dịch lớn', 5000000, 20)
ON CONFLICT (rule_key) DO NOTHING;

-- 4. RISK EVENTS (audit log)
CREATE TABLE IF NOT EXISTS risk_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB DEFAULT '{}',
  risk_delta INTEGER DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. DEVICE FINGERPRINTS
CREATE TABLE IF NOT EXISTS device_fingerprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  user_agent TEXT,
  ip_address TEXT,
  country TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  login_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(user_id, fingerprint)
);

-- 6. INDEXES
CREATE INDEX IF NOT EXISTS idx_risk_profiles_score ON risk_profiles(risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_risk_profiles_level ON risk_profiles(risk_level);
CREATE INDEX IF NOT EXISTS idx_risk_alerts_status ON risk_alerts(status);
CREATE INDEX IF NOT EXISTS idx_risk_alerts_severity ON risk_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_risk_alerts_user ON risk_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_risk_events_user ON risk_events(user_id);
CREATE INDEX IF NOT EXISTS idx_device_fp_user ON device_fingerprints(user_id);
