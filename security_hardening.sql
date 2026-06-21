-- ═══════════════════════════════════════════════════════════════
-- SAFEPASS SECURITY HARDENING MIGRATION
-- Run this in Supabase SQL Editor BEFORE enabling security features
-- ═══════════════════════════════════════════════════════════════

-- ── 1. SECURITY SESSIONS (device + session tracking) ──
CREATE TABLE IF NOT EXISTS security_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,   -- SHA-256 of JWT (never store raw token)
  device_fp    TEXT,                   -- 16-char device fingerprint
  ip_address   TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,
  is_revoked   BOOLEAN DEFAULT FALSE,
  revoked_at   TIMESTAMPTZ,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_security_sessions_user_id ON security_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_security_sessions_token   ON security_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_security_sessions_active  ON security_sessions(user_id, is_revoked) WHERE is_revoked = FALSE;

-- ── 2. SECURITY EVENTS (audit trail) ──
CREATE TABLE IF NOT EXISTS security_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type   TEXT NOT NULL,  -- failed_login, brute_force_lock, suspicious_withdrawal,
                               -- spam_message, escrow_fraud_flag, content_flag, logout, new_device
  severity     TEXT DEFAULT 'low' CHECK (severity IN ('low','medium','high','critical')),
  ip_address   TEXT,
  device_fp    TEXT,
  user_agent   TEXT,
  details      JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_security_events_user_id    ON security_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type       ON security_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_severity   ON security_events(severity, created_at DESC);

-- ── 3. JWT BLACKLIST (logout + force-revoke) ──
CREATE TABLE IF NOT EXISTS jwt_blacklist (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  TEXT UNIQUE NOT NULL,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jwt_blacklist_hash       ON jwt_blacklist(token_hash);
CREATE INDEX IF NOT EXISTS idx_jwt_blacklist_user_id    ON jwt_blacklist(user_id);
CREATE INDEX IF NOT EXISTS idx_jwt_blacklist_expires    ON jwt_blacklist(expires_at);

-- ── 4. LOGIN ATTEMPTS (brute-force audit) ──
CREATE TABLE IF NOT EXISTS login_attempts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier  TEXT NOT NULL,   -- normalized phone or IP
  success     BOOLEAN DEFAULT FALSE,
  ip_address  TEXT,
  user_agent  TEXT,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_recent     ON login_attempts(created_at DESC);

-- ── 5. CONTENT FLAGS (moderation queue) ──
CREATE TABLE IF NOT EXISTS content_flags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  target_type     TEXT NOT NULL,  -- message, listing, ticket, review, post, dm
  target_id       TEXT NOT NULL,
  content_preview TEXT,           -- first 200 chars of flagged content
  flag_type       TEXT NOT NULL,  -- spam, abuse, scam, phishing, inappropriate, fake
  auto_flagged    BOOLEAN DEFAULT FALSE,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','reviewed','dismissed','actioned')),
  reviewer_id     UUID,
  admin_notes     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_content_flags_status      ON content_flags(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_flags_target      ON content_flags(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_content_flags_reporter    ON content_flags(reporter_id);

-- ── 6. WALLET DAILY GUARDS (per-user daily limits tracking) ──
CREATE TABLE IF NOT EXISTS wallet_daily_guards (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  guard_date         DATE DEFAULT CURRENT_DATE,
  daily_withdrawn    BIGINT DEFAULT 0,
  withdrawal_count   INT DEFAULT 0,
  daily_topup        BIGINT DEFAULT 0,
  topup_count        INT DEFAULT 0,
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wallet_daily_guards_user ON wallet_daily_guards(user_id);

-- ── 7. ESCROW FRAUD FLAGS ──
CREATE TABLE IF NOT EXISTS escrow_fraud_flags (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID,
  buyer_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  seller_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  flag_type    TEXT NOT NULL,  -- new_account, price_anomaly, velocity, suspicious_pattern
  risk_level   TEXT DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high','critical')),
  details      JSONB DEFAULT '{}',
  reviewed     BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_escrow_fraud_flags_order   ON escrow_fraud_flags(order_id);
CREATE INDEX IF NOT EXISTS idx_escrow_fraud_flags_buyer   ON escrow_fraud_flags(buyer_id);
CREATE INDEX IF NOT EXISTS idx_escrow_fraud_flags_review  ON escrow_fraud_flags(reviewed, created_at DESC);

-- ── 8. DEVICE REGISTRY (known devices per user) ──
CREATE TABLE IF NOT EXISTS user_devices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  device_fp   TEXT NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT,
  first_seen  TIMESTAMPTZ DEFAULT NOW(),
  last_seen   TIMESTAMPTZ DEFAULT NOW(),
  is_trusted  BOOLEAN DEFAULT FALSE,
  UNIQUE(user_id, device_fp)
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user    ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_fp      ON user_devices(device_fp);

-- ── AUTO-CLEAN: purge old blacklist entries + login attempts ──
-- Run this periodically or set up a pg_cron job:
-- DELETE FROM jwt_blacklist WHERE expires_at < NOW();
-- DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '30 days';
-- DELETE FROM security_events WHERE created_at < NOW() - INTERVAL '90 days';

-- Done. All security tables created.
