-- ══════════════════════════════════════════════
--  SafePass — payment_transactions Table
--  Run this in Supabase SQL Editor (once)
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payment_transactions (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           UUID        REFERENCES users(id) ON DELETE SET NULL,
  amount            BIGINT      NOT NULL,
  gateway           TEXT        NOT NULL DEFAULT 'vnpay',
  status            TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'success', 'failed')),
  txn_ref           TEXT        UNIQUE NOT NULL,
  vnp_transaction_no TEXT,
  response_code     TEXT,
  order_info        TEXT,
  bank_code         TEXT,
  pay_date          TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Disable RLS so server-side service key can access freely
ALTER TABLE payment_transactions DISABLE ROW LEVEL SECURITY;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_pay_txn_user   ON payment_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pay_txn_ref    ON payment_transactions(txn_ref);
CREATE INDEX IF NOT EXISTS idx_pay_txn_status ON payment_transactions(status, created_at DESC);

-- ══════════════════════════════════════════════
--  HOW TO USE
-- ══════════════════════════════════════════════
-- 1. Paste this entire file into Supabase → SQL Editor → Run
-- 2. Add VNPAY_TMN_CODE and VNPAY_HASH_SECRET to Replit Secrets
-- 3. Configure VNPay IPN URL in merchant portal:
--    https://your-domain.replit.app/api/payment/webhook
-- 4. Configure VNPay Return URL:
--    https://your-domain.replit.app/api/payment/vnpay-return
