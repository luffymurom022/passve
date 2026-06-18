-- ══════════════════════════════════════════════
--  SafePass KYC Verification — Full SQL Setup
--  Run this in Supabase SQL Editor (once)
-- ══════════════════════════════════════════════

-- 1. Create kyc_requests table
CREATE TABLE IF NOT EXISTS kyc_requests (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID        REFERENCES users(id) ON DELETE CASCADE,
  front_image    TEXT        NOT NULL,
  back_image     TEXT        NOT NULL,
  selfie_image   TEXT        NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'approved', 'rejected')),
  review_notes   TEXT,
  reject_reason  TEXT,
  reviewed_by    TEXT,
  reviewed_at    TIMESTAMPTZ,
  full_name      TEXT,
  id_type        TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Disable RLS so server-side service key can read/write freely
ALTER TABLE kyc_requests DISABLE ROW LEVEL SECURITY;

-- 3. Performance indexes
CREATE INDEX IF NOT EXISTS idx_kyc_user    ON kyc_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_status  ON kyc_requests(status, created_at DESC);

-- 4. Ensure users table has is_verified column
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- 5. Create Supabase Storage bucket (run via dashboard or this statement if using pgSQL extension)
-- The bucket is also auto-created by the Node.js server on startup.
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('kyc-documents', 'kyc-documents', false)
-- ON CONFLICT (id) DO NOTHING;

-- ══════════════════════════════════════════════
--  HOW TO USE
-- ══════════════════════════════════════════════
-- 1. Paste this entire file into Supabase → SQL Editor → Run
-- 2. The server auto-creates the storage bucket on startup
-- 3. Users submit KYC via their profile page
-- 4. Admins review at /admin.html → KYC tab
