-- ================================================================
-- PHASE SOCIAL 13: METAVERSE COMMERCE + DIGITAL ECONOMY
-- Run this in Supabase SQL Editor
-- ================================================================

-- 1. Virtual Districts
CREATE TABLE IF NOT EXISTS mv_districts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  description text,
  theme text DEFAULT 'tech',
  icon text DEFAULT '🏙️',
  store_count int DEFAULT 0,
  is_active bool DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 2. Virtual Stores
CREATE TABLE IF NOT EXISTS mv_stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  district_id uuid REFERENCES mv_districts(id) ON DELETE SET NULL,
  name text NOT NULL,
  slug text UNIQUE,
  description text,
  store_type text DEFAULT 'shop',
  category text DEFAULT 'general',
  avatar_url text,
  banner_url text,
  rating numeric DEFAULT 0,
  review_count int DEFAULT 0,
  sales_count int DEFAULT 0,
  revenue numeric DEFAULT 0,
  is_verified bool DEFAULT false,
  is_featured bool DEFAULT false,
  is_active bool DEFAULT true,
  tags text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- 3. Products (all types)
CREATE TABLE IF NOT EXISTS mv_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid REFERENCES mv_stores(id) ON DELETE CASCADE,
  seller_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  product_type text DEFAULT 'physical',
  category text DEFAULT 'general',
  price numeric NOT NULL DEFAULT 0,
  currency text DEFAULT 'VND',
  stock int,
  sold_count int DEFAULT 0,
  rating numeric DEFAULT 0,
  image_url text,
  thumbnail text,
  is_featured bool DEFAULT false,
  is_active bool DEFAULT true,
  uses_escrow bool DEFAULT true,
  tags text[] DEFAULT '{}',
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- 4. Orders
CREATE TABLE IF NOT EXISTS mv_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  seller_id uuid REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid REFERENCES mv_products(id) ON DELETE SET NULL,
  store_id uuid REFERENCES mv_stores(id) ON DELETE SET NULL,
  quantity int DEFAULT 1,
  unit_price numeric NOT NULL,
  total_amount numeric NOT NULL,
  currency text DEFAULT 'VND',
  status text DEFAULT 'pending',
  escrow_status text DEFAULT 'held',
  payment_method text DEFAULT 'wallet',
  notes text,
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- 5. Subscriptions
CREATE TABLE IF NOT EXISTS mv_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id uuid REFERENCES users(id) ON DELETE CASCADE,
  creator_id uuid REFERENCES users(id) ON DELETE CASCADE,
  store_id uuid REFERENCES mv_stores(id) ON DELETE SET NULL,
  plan text DEFAULT 'basic',
  price numeric DEFAULT 0,
  billing_cycle text DEFAULT 'monthly',
  status text DEFAULT 'active',
  started_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  UNIQUE(subscriber_id, creator_id)
);

-- 6. Services
CREATE TABLE IF NOT EXISTS mv_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  category text DEFAULT 'freelance',
  price_from numeric DEFAULT 0,
  price_to numeric,
  delivery_days int DEFAULT 7,
  rating numeric DEFAULT 0,
  order_count int DEFAULT 0,
  is_featured bool DEFAULT false,
  is_active bool DEFAULT true,
  tags text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- 7. Reviews
CREATE TABLE IF NOT EXISTS mv_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid REFERENCES mv_products(id) ON DELETE CASCADE,
  store_id uuid REFERENCES mv_stores(id) ON DELETE SET NULL,
  rating int CHECK(rating BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(reviewer_id, product_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mvstores_district ON mv_stores(district_id);
CREATE INDEX IF NOT EXISTS idx_mvstores_owner ON mv_stores(owner_id);
CREATE INDEX IF NOT EXISTS idx_mvstores_featured ON mv_stores(is_featured);
CREATE INDEX IF NOT EXISTS idx_mvproducts_store ON mv_products(store_id);
CREATE INDEX IF NOT EXISTS idx_mvproducts_type ON mv_products(product_type);
CREATE INDEX IF NOT EXISTS idx_mvproducts_featured ON mv_products(is_featured);
CREATE INDEX IF NOT EXISTS idx_mvorders_buyer ON mv_orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_mvorders_seller ON mv_orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_mvservices_cat ON mv_services(category);

-- ── SEED DISTRICTS ──
INSERT INTO mv_districts (name, slug, description, theme, icon, store_count) VALUES
  ('Fashion District', 'fashion', 'Thế giới thời trang — outfit, phụ kiện, avatar skins', 'fashion', '👗', 24),
  ('Tech Hub', 'tech', 'Công nghệ, gadgets, digital products, NFT', 'tech', '💻', 31),
  ('Gaming Arena', 'gaming', 'Game items, esports, avatar packs, game tickets', 'gaming', '🎮', 18),
  ('Creator Mall', 'creator', 'Khóa học, membership, digital downloads, tools', 'creator', '🎨', 22),
  ('Event District', 'events', 'Vé sự kiện, concert, hội nghị, VIP passes', 'events', '🎪', 15),
  ('Food & Lifestyle', 'lifestyle', 'Ẩm thực, lifestyle, sức khỏe, wellness', 'lifestyle', '🍜', 19),
  ('Education Hub', 'education', 'Khóa học, mentoring, tài liệu, certification', 'education', '📚', 27),
  ('Services District', 'services', 'Freelancers, agencies, consultants, tutors', 'services', '💼', 33)
ON CONFLICT(slug) DO NOTHING;

-- ── SEED FEATURED PRODUCTS ──
INSERT INTO mv_products (seller_id, name, description, product_type, category, price, currency, is_featured, sold_count, tags)
SELECT
  (SELECT id FROM users ORDER BY created_at LIMIT 1),
  name, description, product_type, category, price, 'VND', true, sold_count, tags
FROM (VALUES
  ('🎵 VIP Concert Ticket','Vé VIP xem concert trong XR Space — hàng ghế đầu','event','events',450000,1240,ARRAY['concert','vip','xr']),
  ('👗 Cosmic Outfit Pack','Bộ trang phục avatar Cosmic 4 pieces — limited edition','digital','avatar',120000,3820,ARRAY['avatar','outfit','limited']),
  ('🎮 Pro Gaming Bundle','Gói game items cao cấp cho arena XR','digital','gaming',280000,892,ARRAY['gaming','bundle','pro']),
  ('📚 XR Marketing Course','Khóa học marketing trong Metaverse — 40 bài','digital','education',599000,456,ARRAY['course','metaverse','marketing']),
  ('💎 Premium Membership','Membership Creator Hub — 1 tháng full access','subscription','creator',199000,2341,ARRAY['membership','creator','monthly']),
  ('🎨 Design Pack Pro','1000+ assets thiết kế cho avatar và spaces','digital','creator',350000,671,ARRAY['design','assets','creator']),
  ('🏆 Esports Season Pass','Pass tham dự toàn bộ giải đấu esports XR 2026','event','gaming',750000,389,ARRAY['esports','season','pass']),
  ('🌌 Space Theme Bundle','Bộ theme vũ trụ cho XR Space của bạn','digital','space',180000,1560,ARRAY['theme','space','xr'])
) AS t(name, description, product_type, category, price, sold_count, tags)
WHERE EXISTS (SELECT 1 FROM users LIMIT 1)
ON CONFLICT DO NOTHING;

-- ── SEED FEATURED SERVICES ──
INSERT INTO mv_services (provider_id, name, description, category, price_from, price_to, delivery_days, is_featured, order_count, tags)
SELECT
  (SELECT id FROM users ORDER BY created_at LIMIT 1),
  name, description, category, price_from, price_to, delivery_days, true, order_count, tags
FROM (VALUES
  ('XR Space Design','Thiết kế XR Space chuyên nghiệp theo yêu cầu','design',2000000,10000000,14,128,ARRAY['xr','design','space']),
  ('Avatar Creator Pro','Tạo avatar 3D custom theo phong cách của bạn','design',500000,2000000,5,341,ARRAY['avatar','3d','custom']),
  ('Social Media Marketing','Quản lý mạng xã hội SafePass cho doanh nghiệp','marketing',3000000,8000000,30,89,ARRAY['marketing','social','business']),
  ('Metaverse Consultant','Tư vấn chiến lược kinh doanh trong Metaverse','consulting',1500000,5000000,7,56,ARRAY['consulting','metaverse','strategy'])
) AS t(name, description, category, price_from, price_to, delivery_days, order_count, tags)
WHERE EXISTS (SELECT 1 FROM users LIMIT 1)
ON CONFLICT DO NOTHING;
