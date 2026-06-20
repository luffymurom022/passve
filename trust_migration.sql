-- ═══════════════════════════════════════════════════════════
-- PHASE 9: SAFEPASS VERIFIED SELLER & TRUST NETWORK
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. TRUST SCORES TABLE
CREATE TABLE IF NOT EXISTS trust_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 100 CHECK (score >= 0 AND score <= 1000),
  level TEXT NOT NULL DEFAULT 'bronze' CHECK (level IN ('bronze','silver','gold','platinum','diamond')),
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high')),
  phone_verified BOOLEAN NOT NULL DEFAULT false,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  id_verified BOOLEAN NOT NULL DEFAULT false,
  address_verified BOOLEAN NOT NULL DEFAULT false,
  face_verified BOOLEAN NOT NULL DEFAULT false,
  is_premium_seller BOOLEAN NOT NULL DEFAULT false,
  is_top_seller BOOLEAN NOT NULL DEFAULT false,
  total_transactions INTEGER NOT NULL DEFAULT 0,
  successful_transactions INTEGER NOT NULL DEFAULT 0,
  dispute_count INTEGER NOT NULL DEFAULT 0,
  refund_count INTEGER NOT NULL DEFAULT 0,
  avg_rating NUMERIC(3,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

-- 2. VERIFICATION DOCUMENTS TABLE
CREATE TABLE IF NOT EXISTS verification_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('cccd','passport','driver_license','address','face')),
  file_url TEXT NOT NULL,
  file_url_2 TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id)
);

-- 3. REPUTATION HISTORY TABLE
CREATE TABLE IF NOT EXISTS reputation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'transaction_complete','transaction_cancel','dispute_lost','dispute_won',
    'review_received','identity_verified','phone_verified','email_verified',
    'address_verified','face_verified','account_age_bonus','refund_issued',
    'score_recalculated'
  )),
  delta INTEGER NOT NULL DEFAULT 0,
  score_after INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  ref_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. INDEXES
CREATE INDEX IF NOT EXISTS idx_trust_scores_user ON trust_scores(user_id);
CREATE INDEX IF NOT EXISTS idx_trust_scores_score ON trust_scores(score DESC);
CREATE INDEX IF NOT EXISTS idx_trust_scores_level ON trust_scores(level);
CREATE INDEX IF NOT EXISTS idx_verification_docs_user ON verification_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_verification_docs_status ON verification_documents(status);
CREATE INDEX IF NOT EXISTS idx_reputation_history_user ON reputation_history(user_id);
CREATE INDEX IF NOT EXISTS idx_reputation_history_created ON reputation_history(created_at DESC);

-- 5. FUNCTION: auto-initialize trust_score on new user
CREATE OR REPLACE FUNCTION init_trust_score()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO trust_scores (user_id) VALUES (NEW.id) ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_init_trust_score ON users;
CREATE TRIGGER trg_init_trust_score
  AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION init_trust_score();

-- 6. BACKFILL existing users
INSERT INTO trust_scores (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;
