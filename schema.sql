-- ================================================================
-- SAFEPASS — SCHEMA CHÍNH
-- An toàn để chạy nhiều lần: dùng IF NOT EXISTS cho tất cả
-- ================================================================

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phone text UNIQUE NOT NULL,
  password text NOT NULL,
  name text NOT NULL,
  email text,
  balance bigint DEFAULT 0,
  escrow bigint DEFAULT 0,
  avg_rating numeric DEFAULT 0,
  review_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- TICKETS
CREATE TABLE IF NOT EXISTS tickets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  seller_id uuid REFERENCES users(id),
  seller_name text,
  event_name text NOT NULL,
  event_date text,
  location text,
  section text,
  price bigint NOT NULL,
  quantity int DEFAULT 1,
  description text,
  status text DEFAULT 'available', -- available | pending | sold
  created_at timestamptz DEFAULT now()
);

-- ORDERS
CREATE TABLE IF NOT EXISTS orders (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id uuid REFERENCES tickets(id),
  buyer_id uuid REFERENCES users(id),
  buyer_name text,
  seller_id uuid REFERENCES users(id),
  seller_name text,
  event_name text,
  price bigint,
  fee bigint,
  total bigint,
  qr_code text,
  status text DEFAULT 'waiting_qr', -- waiting_qr | waiting_confirm | completed | disputed | refunded
  created_at timestamptz DEFAULT now()
);

-- TRANSACTIONS
CREATE TABLE IF NOT EXISTS transactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  type text, -- topup | escrow_lock | escrow_release | payout | refund
  amount bigint,
  description text,
  order_id uuid,
  created_at timestamptz DEFAULT now()
);

-- REVIEWS
CREATE TABLE IF NOT EXISTS reviews (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id uuid REFERENCES orders(id),
  buyer_id uuid REFERENCES users(id),
  buyer_name text,
  seller_id uuid REFERENCES users(id),
  event_name text,
  rating int CHECK (rating BETWEEN 1 AND 5),
  text text,
  seller_reply text,
  seller_reply_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- ORDER MESSAGES (chat nội bộ trong đơn hàng)
CREATE TABLE IF NOT EXISTS order_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES users(id),
  sender_name text,
  text text NOT NULL,
  image_url text,
  message_type text DEFAULT 'text',
  read_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- KYC REQUESTS
CREATE TABLE IF NOT EXISTS kyc_requests (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  front_image text NOT NULL,
  back_image text NOT NULL,
  selfie_image text NOT NULL,
  status text DEFAULT 'pending',  -- pending | approved | rejected
  reject_reason text,
  created_at timestamptz DEFAULT now()
);

-- TICKET SCANS (QR Verification history)
CREATE TABLE IF NOT EXISTS ticket_scans (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  scanned_by text,
  scanner_type text,  -- admin | organizer
  scanned_at timestamptz DEFAULT now()
);

-- REFERRALS
CREATE TABLE IF NOT EXISTS referrals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  referred_id uuid REFERENCES users(id) ON DELETE CASCADE,
  referred_name text,
  referred_phone text,
  total_commission bigint DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- ================================================================
-- TẮT RLS (backend tự xác thực qua JWT — không cần Supabase RLS)
-- ================================================================
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE tickets DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE transactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE reviews DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_requests DISABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_scans DISABLE ROW LEVEL SECURITY;
ALTER TABLE referrals DISABLE ROW LEVEL SECURITY;

-- ================================================================
-- MIGRATIONS — thêm cột nếu chưa tồn tại (an toàn để chạy lại)
-- ================================================================

-- users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned boolean DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_earnings bigint DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_count int DEFAULT 0;

-- tickets
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category text DEFAULT 'concerts';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS image_url text;

-- orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_reason text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_description text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_opened_by text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_opened_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_resolved_by text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_resolved_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_note text;

-- reviews
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS seller_reply text;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS seller_reply_at timestamptz;

-- ================================================================
-- INDEXES — tối ưu query (an toàn để chạy lại)
-- ================================================================
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category);
CREATE INDEX IF NOT EXISTS idx_order_messages_order ON order_messages(order_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_kyc_user ON kyc_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scans_order ON ticket_scans(order_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id, created_at DESC);
