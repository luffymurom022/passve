-- USERS
create table users (
  id uuid default gen_random_uuid() primary key,
  phone text unique not null,
  password text not null,
  name text not null,
  email text,
  balance bigint default 0,
  escrow bigint default 0,
  avg_rating numeric default 0,
  review_count int default 0,
  created_at timestamptz default now()
);

-- Migration: add email column to existing table (run in Supabase SQL Editor if table already exists)
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;

-- TICKETS
create table tickets (
  id uuid default gen_random_uuid() primary key,
  seller_id uuid references users(id),
  seller_name text,
  event_name text not null,
  event_date text,
  location text,
  section text,
  price bigint not null,
  quantity int default 1,
  description text,
  status text default 'available', -- available | pending | sold
  created_at timestamptz default now()
);

-- ORDERS
create table orders (
  id uuid default gen_random_uuid() primary key,
  ticket_id uuid references tickets(id),
  buyer_id uuid references users(id),
  buyer_name text,
  seller_id uuid references users(id),
  seller_name text,
  event_name text,
  price bigint,
  fee bigint,
  total bigint,
  qr_code text,
  status text default 'waiting_qr', -- waiting_qr | waiting_confirm | completed | disputed | refunded
  created_at timestamptz default now()
);

-- TRANSACTIONS
create table transactions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references users(id),
  type text, -- topup | escrow_lock | escrow_release | payout | refund
  amount bigint,
  description text,
  order_id uuid,
  created_at timestamptz default now()
);

-- REVIEWS
create table if not exists reviews (
  id uuid default gen_random_uuid() primary key,
  order_id uuid references orders(id),
  buyer_id uuid references users(id),
  buyer_name text,
  seller_id uuid references users(id),
  event_name text,
  rating int check (rating between 1 and 5),
  text text,
  seller_reply text,
  seller_reply_at timestamptz,
  created_at timestamptz default now()
);

-- Tắt RLS để backend có thể đọc/ghi tự do
alter table users disable row level security;
alter table tickets disable row level security;
alter table orders disable row level security;
alter table transactions disable row level security;
alter table reviews disable row level security;

-- ═══════════════════════════════════════════════
-- MIGRATIONS (chạy trong Supabase SQL Editor nếu bảng đã tồn tại)
-- ═══════════════════════════════════════════════

-- Thêm cột is_banned vào users (ban/unban users)
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned boolean default false;

-- Thêm cột email vào users (nếu chưa có)
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;

-- Thêm các cột dispute vào orders
-- ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_reason text;
-- ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_description text;
-- ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_opened_by text;
-- ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_opened_at timestamptz;
-- ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_resolved_by text;
-- ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_resolved_at timestamptz;
-- ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_note text;

-- Thêm seller_reply vào reviews (nếu bảng đã tồn tại)
-- ALTER TABLE reviews ADD COLUMN IF NOT EXISTS seller_reply text;
-- ALTER TABLE reviews ADD COLUMN IF NOT EXISTS seller_reply_at timestamptz;

-- Thêm cột category vào tickets (tìm kiếm nâng cao)
-- ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category text default 'concerts';

-- Bảng order_messages (chat nội bộ trong đơn hàng)
-- CREATE TABLE IF NOT EXISTS order_messages (
--   id uuid default gen_random_uuid() primary key,
--   order_id uuid references orders(id) on delete cascade,
--   sender_id uuid references users(id),
--   sender_name text,
--   text text not null,
--   image_url text,
--   message_type text default 'text',
--   read_at timestamptz,
--   created_at timestamptz default now()
-- );
-- ALTER TABLE order_messages DISABLE ROW LEVEL SECURITY;
-- CREATE INDEX IF NOT EXISTS idx_order_messages_order ON order_messages(order_id, created_at ASC);

-- Migration: nếu bảng đã tồn tại, thêm các cột mới cho chat nâng cao
-- ALTER TABLE order_messages ADD COLUMN IF NOT EXISTS image_url text;
-- ALTER TABLE order_messages ADD COLUMN IF NOT EXISTS message_type text DEFAULT 'text';
-- ALTER TABLE order_messages ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- ═══════════════════════════════════════════════
-- KYC REQUESTS TABLE
-- ═══════════════════════════════════════════════
-- Chạy trong Supabase SQL Editor:
-- CREATE TABLE IF NOT EXISTS kyc_requests (
--   id uuid default gen_random_uuid() primary key,
--   user_id uuid references users(id) on delete cascade,
--   front_image text not null,
--   back_image text not null,
--   selfie_image text not null,
--   status text default 'pending',  -- pending | approved | rejected
--   reject_reason text,
--   created_at timestamptz default now()
-- );
-- ALTER TABLE kyc_requests DISABLE ROW LEVEL SECURITY;
-- CREATE INDEX IF NOT EXISTS idx_kyc_user ON kyc_requests(user_id, created_at DESC);

-- ═══════════════════════════════════════════════
-- TICKET SCANS TABLE (QR Verification history)
-- ═══════════════════════════════════════════════
-- CREATE TABLE IF NOT EXISTS ticket_scans (
--   id uuid default gen_random_uuid() primary key,
--   order_id uuid references orders(id) on delete cascade,
--   scanned_by text,
--   scanner_type text,  -- admin | organizer
--   scanned_at timestamptz default now()
-- );
-- ALTER TABLE ticket_scans DISABLE ROW LEVEL SECURITY;
-- CREATE INDEX IF NOT EXISTS idx_scans_order ON ticket_scans(order_id, scanned_at DESC);

-- Index tối ưu query
-- CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
-- CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
-- CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
-- CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);
-- CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
-- CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category);
