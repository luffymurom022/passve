-- ================================================================
-- PHASE SOCIAL 8: SUPER APP ECOSYSTEM
-- Run this in Supabase SQL Editor
-- ================================================================

-- 1. Event Hub
CREATE TABLE IF NOT EXISTS sp_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid,
  title text NOT NULL,
  description text,
  type text DEFAULT 'concert',
  image_url text,
  location text,
  venue text,
  start_at timestamptz,
  end_at timestamptz,
  ticket_price numeric DEFAULT 0,
  capacity int DEFAULT 100,
  attendees_count int DEFAULT 0,
  status text DEFAULT 'upcoming',
  tags text[],
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sp_event_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES sp_events(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  ticket_type text DEFAULT 'general',
  status text DEFAULT 'confirmed',
  created_at timestamptz DEFAULT now(),
  UNIQUE(event_id, user_id)
);

-- 2. Booking System
CREATE TABLE IF NOT EXISTS sp_booking_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  type text DEFAULT 'appointment',
  price numeric DEFAULT 0,
  duration_mins int DEFAULT 60,
  image_url text,
  category text DEFAULT 'other',
  is_active bool DEFAULT true,
  bookings_count int DEFAULT 0,
  rating numeric DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sp_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid REFERENCES sp_booking_services(id) ON DELETE SET NULL,
  provider_id uuid REFERENCES users(id),
  customer_id uuid REFERENCES users(id),
  service_name text NOT NULL,
  price numeric DEFAULT 0,
  scheduled_at timestamptz,
  duration_mins int DEFAULT 60,
  location text,
  notes text,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

-- 3. Mini Apps
CREATE TABLE IF NOT EXISTS sp_mini_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  icon text DEFAULT '📱',
  color text DEFAULT '#3d8ef8',
  url text NOT NULL,
  category text DEFAULT 'utilities',
  is_featured bool DEFAULT false,
  is_active bool DEFAULT true,
  opens_count int DEFAULT 0,
  developer text DEFAULT 'SafePass',
  version text DEFAULT '1.0',
  created_at timestamptz DEFAULT now()
);

-- Seed built-in mini apps
INSERT INTO sp_mini_apps (name,description,icon,color,url,category,is_featured,developer) VALUES
  ('SafePass Pay','Ví điện tử, chuyển tiền, SafeCoin','💳','#10b981','/pay','finance',true,'SafePass'),
  ('Brand Hub','Quản lý thương hiệu & quảng cáo','🏢','#f59e0b','/brand','business',true,'SafePass'),
  ('Creator Hub','Kiếm tiền từ nội dung & affiliate','🎨','#8b5cf6','/creator','social',true,'SafePass'),
  ('Giao Hàng','Đặt xe, giao hàng nhanh','🚴','#ef4444','/delivery','lifestyle',true,'SafePass'),
  ('Trust Center','Xác minh danh tính & uy tín','🛡️','#3b82f6','/trust','utilities',false,'SafePass'),
  ('AI Commerce','Thương mại thông minh AI','🤖','#6366f1','/aicommerce','entertainment',false,'SafePass'),
  ('Freelance','Thuê & tìm việc tự do','💼','#0ea5e9','/freelance','business',false,'SafePass'),
  ('Social','Mạng xã hội & Reels','📱','#f97316','/social','social',false,'SafePass'),
  ('Kho Bãi','Lưu kho thông minh','🏭','#78716c','/warehouse','business',false,'SafePass'),
  ('Chuỗi Nhượng Quyền','Mạng lưới đối tác','🤝','#ec4899','/franchise','business',false,'SafePass'),
  ('Trung Tâm Kiểm Định','Kiểm tra hàng hóa chuyên nghiệp','🔬','#14b8a6','/inspection','utilities',false,'SafePass'),
  ('Rủi Ro AI','Đánh giá rủi ro giao dịch','🔮','#a855f7','/risk','utilities',false,'SafePass')
ON CONFLICT DO NOTHING;

-- Fix seed (icon/url column order was mixed above, re-seed clean)
DELETE FROM sp_mini_apps WHERE url='/social' AND name='Social';
INSERT INTO sp_mini_apps (name,description,icon,color,url,category,is_featured,developer) VALUES
  ('Social','Mạng xã hội & Reels','📱','#f97316','/social','social',false,'SafePass')
ON CONFLICT DO NOTHING;

-- 4. Loyalty Program
CREATE TABLE IF NOT EXISTS sp_loyalty (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  points int DEFAULT 0,
  lifetime_points int DEFAULT 0,
  level text DEFAULT 'bronze',
  streak_days int DEFAULT 0,
  last_checkin date,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sp_loyalty_txns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  points int NOT NULL,
  type text NOT NULL,
  description text,
  reference_id text,
  created_at timestamptz DEFAULT now()
);

-- 5. Digital Products
CREATE TABLE IF NOT EXISTS sp_digital_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  type text DEFAULT 'ebook',
  price numeric DEFAULT 0,
  image_url text,
  file_size text,
  format text DEFAULT 'PDF',
  tags text[],
  sales_count int DEFAULT 0,
  rating numeric DEFAULT 0,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sp_digital_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES sp_digital_products(id) ON DELETE CASCADE,
  buyer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  seller_id uuid REFERENCES users(id),
  amount numeric NOT NULL,
  status text DEFAULT 'completed',
  created_at timestamptz DEFAULT now(),
  UNIQUE(product_id, buyer_id)
);

-- 6. Subscription Plans & Subscriptions
CREATE TABLE IF NOT EXISTS sp_subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  owner_type text DEFAULT 'creator',
  tier text DEFAULT 'basic',
  name text NOT NULL,
  description text,
  price_monthly numeric DEFAULT 0,
  perks text[],
  subscribers_count int DEFAULT 0,
  is_active bool DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sp_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id uuid REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES sp_subscription_plans(id) ON DELETE CASCADE,
  owner_id uuid REFERENCES users(id),
  status text DEFAULT 'active',
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(subscriber_id, plan_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sp_events_status ON sp_events(status);
CREATE INDEX IF NOT EXISTS idx_sp_events_type ON sp_events(type);
CREATE INDEX IF NOT EXISTS idx_sp_bookings_customer ON sp_bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_sp_bookings_provider ON sp_bookings(provider_id);
CREATE INDEX IF NOT EXISTS idx_sp_loyalty_user ON sp_loyalty(user_id);
CREATE INDEX IF NOT EXISTS idx_sp_loyalty_txns_user ON sp_loyalty_txns(user_id);
CREATE INDEX IF NOT EXISTS idx_sp_digital_products_seller ON sp_digital_products(seller_id);
CREATE INDEX IF NOT EXISTS idx_sp_digital_purchases_buyer ON sp_digital_purchases(buyer_id);
CREATE INDEX IF NOT EXISTS idx_sp_subscriptions_subscriber ON sp_subscriptions(subscriber_id);
