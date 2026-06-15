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

-- Tắt RLS để backend có thể đọc/ghi tự do
alter table users disable row level security;
alter table tickets disable row level security;
alter table orders disable row level security;
alter table transactions disable row level security;
