-- ══════════════════════════════════════════════
--  SafePass Admin Dashboard — SQL Migration
--  Run this in Supabase SQL Editor
-- ══════════════════════════════════════════════

-- 1. admins table (email/password auth, role-based)
CREATE TABLE IF NOT EXISTS admins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'moderator' CHECK (role IN ('super_admin', 'moderator')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. admin_logs table (audit trail for every admin action)
CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_id UUID REFERENCES admins(id) ON DELETE SET NULL,
  admin_email TEXT NOT NULL DEFAULT 'legacy',
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_logs_created_at_idx ON admin_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS admin_logs_admin_id_idx ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS admin_logs_action_idx ON admin_logs(action);

-- 3. Extra columns for kyc_requests (full_name, id_type for display)
ALTER TABLE kyc_requests ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE kyc_requests ADD COLUMN IF NOT EXISTS id_type text;
ALTER TABLE kyc_requests ADD COLUMN IF NOT EXISTS reject_reason text;

-- 4. Extra columns for order_messages (type, read_at)
ALTER TABLE order_messages ADD COLUMN IF NOT EXISTS message_type text DEFAULT 'text';
ALTER TABLE order_messages ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- ══════════════════════════════════════════════
--  HOW TO USE
-- ══════════════════════════════════════════════
-- 1. Run ALL previous migrations from tientrinhethong.md first (schema, tables, indexes)
-- 2. Then run THIS file in Supabase SQL Editor
-- 3. Create first super admin via POST /api/admin/auth/setup
--    Body: { "secret": "<ADMIN_SECRET env var>", "email": "you@example.com", "password": "min8chars" }
-- 4. Login at /admin.html
