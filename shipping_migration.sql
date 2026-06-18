-- ══════════════════════════════════════════════════
--  SAFEPASS — PASS ĐỒ SHIPPING SYSTEM MIGRATION
--  Chạy toàn bộ file này trong Supabase SQL Editor
-- ══════════════════════════════════════════════════

-- Bảng shipping_orders: theo dõi vận chuyển hàng vật lý
CREATE TABLE IF NOT EXISTS shipping_orders (
  id              uuid    default gen_random_uuid() primary key,
  order_id        uuid    references orders(id) on delete cascade,
  carrier         text    not null,
  tracking_code   text    not null,
  shipping_status text    default 'shipping',
  -- shipping_status: pending | packed | shipping | delivered | completed | disputed
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

ALTER TABLE shipping_orders DISABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipping_order_id ON shipping_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_shipping_status ON shipping_orders(shipping_status, created_at DESC);

-- Thêm cột trust_score vào users nếu chưa có
ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_score int default 50;

-- Thêm cột shipping vào orders để track trạng thái mới
-- (orders.status sẽ có thêm trạng thái 'shipping' cho hàng vật lý)
-- Không cần ALTER TABLE vì status là text column tự do
