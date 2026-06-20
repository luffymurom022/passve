-- ══════════════════════════════════════════════════
-- OPEN ESCROW NETWORK — SQL Migration
-- Chạy trong Supabase SQL Editor
-- ══════════════════════════════════════════════════

-- 1. OPEN ESCROWS
CREATE TABLE IF NOT EXISTS open_escrows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  description     TEXT,
  category        TEXT NOT NULL DEFAULT 'other',
  amount          BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','funded','shipped','delivered','completed','disputed','cancelled','frozen')),

  buyer_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  seller_email    TEXT NOT NULL,
  seller_id       UUID REFERENCES users(id) ON DELETE SET NULL,

  tracking_info   TEXT,
  dispute_reason  TEXT,
  dispute_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  admin_notes     TEXT,
  admin_action_by TEXT,

  invite_token    TEXT UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),

  funded_at       TIMESTAMPTZ,
  shipped_at      TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  disputed_at     TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. ESCROW MESSAGES (real-time chat inside each room)
CREATE TABLE IF NOT EXISTS open_escrow_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id   UUID NOT NULL REFERENCES open_escrows(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  content     TEXT,
  type        TEXT NOT NULL DEFAULT 'user' CHECK (type IN ('user','system','file','image')),
  file_url    TEXT,
  file_name   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. ESCROW EVIDENCE (files for disputes)
CREATE TABLE IF NOT EXISTS open_escrow_evidence (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id   UUID NOT NULL REFERENCES open_escrows(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  file_url    TEXT NOT NULL,
  file_type   TEXT DEFAULT 'image',
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. INDEXES
CREATE INDEX IF NOT EXISTS idx_open_escrows_buyer   ON open_escrows(buyer_id);
CREATE INDEX IF NOT EXISTS idx_open_escrows_seller  ON open_escrows(seller_id);
CREATE INDEX IF NOT EXISTS idx_open_escrows_status  ON open_escrows(status);
CREATE INDEX IF NOT EXISTS idx_oe_messages_escrow   ON open_escrow_messages(escrow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_oe_evidence_escrow   ON open_escrow_evidence(escrow_id);

-- 5. RLS (Row Level Security) — optional but recommended
ALTER TABLE open_escrows         ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_escrow_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_escrow_evidence ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (used by server.js)
CREATE POLICY IF NOT EXISTS "service_role_all_escrows"   ON open_escrows         FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "service_role_all_messages"  ON open_escrow_messages FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "service_role_all_evidence"  ON open_escrow_evidence FOR ALL USING (true);
