-- ═══════════════════════════════════════════════════════════
-- PHASE 18: SAFEPASS PAY — WALLET SYSTEM MIGRATION
-- Run in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. Wallets
CREATE TABLE IF NOT EXISTS wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  balance bigint NOT NULL DEFAULT 0,
  frozen_balance bigint NOT NULL DEFAULT 0,
  safecoin bigint NOT NULL DEFAULT 0,
  total_deposited bigint NOT NULL DEFAULT 0,
  total_withdrawn bigint NOT NULL DEFAULT 0,
  total_transferred_out bigint NOT NULL DEFAULT 0,
  total_transferred_in bigint NOT NULL DEFAULT 0,
  is_frozen boolean DEFAULT false,
  tier text DEFAULT 'basic' CHECK (tier IN ('basic','silver','gold','platinum')),
  daily_limit bigint DEFAULT 20000000,
  monthly_limit bigint DEFAULT 200000000,
  today_spent bigint DEFAULT 0,
  month_spent bigint DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

-- 2. Wallet Transactions
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid REFERENCES wallets(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id),
  type text NOT NULL CHECK (type IN (
    'deposit','withdrawal','transfer_in','transfer_out',
    'escrow_hold','escrow_release','escrow_refund',
    'safecoin_earn','safecoin_redeem','fee','cashback','refund','adjustment'
  )),
  amount bigint NOT NULL,
  balance_before bigint DEFAULT 0,
  balance_after bigint DEFAULT 0,
  fee bigint DEFAULT 0,
  reference_id uuid,
  reference_type text,
  counterpart_user_id uuid REFERENCES users(id),
  note text,
  status text DEFAULT 'completed' CHECK (status IN ('pending','completed','failed','reversed')),
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- 3. Payment Requests (yêu cầu thanh toán)
CREATE TABLE IF NOT EXISTS payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid REFERENCES users(id),
  payer_id uuid REFERENCES users(id),
  amount bigint NOT NULL,
  note text,
  status text DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','cancelled')),
  expires_at timestamptz DEFAULT now() + INTERVAL '24 hours',
  paid_at timestamptz,
  paid_txn_id uuid,
  created_at timestamptz DEFAULT now()
);

-- 4. SafeCoin Ledger
CREATE TABLE IF NOT EXISTS safecoin_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  wallet_id uuid REFERENCES wallets(id),
  amount bigint NOT NULL,
  balance_after bigint DEFAULT 0,
  reason text,
  reference_id uuid,
  reference_type text,
  created_at timestamptz DEFAULT now()
);

-- 5. Deposit Requests (nạp tiền)
CREATE TABLE IF NOT EXISTS deposit_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  amount bigint NOT NULL,
  method text DEFAULT 'bank_transfer' CHECK (method IN ('bank_transfer','qr_code','cash','admin')),
  status text DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed','expired')),
  bank_ref text,
  confirmed_at timestamptz,
  expires_at timestamptz DEFAULT now() + INTERVAL '2 hours',
  note text,
  created_at timestamptz DEFAULT now()
);

-- 6. Withdrawal Requests (rút tiền)
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  wallet_id uuid REFERENCES wallets(id),
  amount bigint NOT NULL,
  fee bigint DEFAULT 0,
  net_amount bigint,
  bank_name text,
  bank_account text,
  bank_holder text,
  status text DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','rejected')),
  processed_at timestamptz,
  note text,
  admin_note text,
  created_at timestamptz DEFAULT now()
);

-- RLS Policies
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE safecoin_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawal_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wallets_own" ON wallets FOR ALL USING (true);
CREATE POLICY "wallet_txns_own" ON wallet_transactions FOR ALL USING (true);
CREATE POLICY "pay_req_own" ON payment_requests FOR ALL USING (true);
CREATE POLICY "safecoin_own" ON safecoin_ledger FOR ALL USING (true);
CREATE POLICY "deposit_own" ON deposit_requests FOR ALL USING (true);
CREATE POLICY "withdrawal_own" ON withdrawal_requests FOR ALL USING (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wtxn_user ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wtxn_created ON wallet_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_preq_requester ON payment_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_preq_payer ON payment_requests(payer_id);
CREATE INDEX IF NOT EXISTS idx_safecoin_user ON safecoin_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_deposit_user ON deposit_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_withdraw_user ON withdrawal_requests(user_id);
