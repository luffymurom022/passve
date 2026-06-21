-- ================================================================
-- PHASE SOCIAL 12: AVATAR ECONOMY
-- Run this in Supabase SQL Editor
-- ================================================================

-- 1. Avatar Items (marketplace catalog)
CREATE TABLE IF NOT EXISTS avatar_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'outfit',
  rarity text DEFAULT 'common',
  price numeric DEFAULT 0,
  currency text DEFAULT 'SP',
  thumbnail_url text,
  item_data jsonb DEFAULT '{}',
  is_limited bool DEFAULT false,
  total_supply int,
  sold_count int DEFAULT 0,
  is_active bool DEFAULT true,
  is_featured bool DEFAULT false,
  tags text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- 2. Avatar Inventory (user-owned items)
CREATE TABLE IF NOT EXISTS avatar_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  item_id uuid REFERENCES avatar_items(id) ON DELETE CASCADE,
  acquired_at timestamptz DEFAULT now(),
  source text DEFAULT 'purchase',
  is_equipped bool DEFAULT false,
  UNIQUE(user_id, item_id)
);

-- 3. Avatar Wardrobe (saved outfits)
CREATE TABLE IF NOT EXISTS avatar_wardrobe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  outfit_data jsonb DEFAULT '{}',
  is_default bool DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- 4. Avatar Badges
CREATE TABLE IF NOT EXISTS avatar_badges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  badge_type text NOT NULL,
  label text NOT NULL,
  description text,
  awarded_at timestamptz DEFAULT now(),
  UNIQUE(user_id, badge_type)
);

-- 5. Avatar Economy Transactions
CREATE TABLE IF NOT EXISTS avatar_economy_txns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  seller_id uuid REFERENCES users(id) ON DELETE SET NULL,
  item_id uuid REFERENCES avatar_items(id) ON DELETE SET NULL,
  amount numeric NOT NULL DEFAULT 0,
  currency text DEFAULT 'SP',
  txn_type text DEFAULT 'purchase',
  created_at timestamptz DEFAULT now()
);

-- 6. Avatar Showrooms
CREATE TABLE IF NOT EXISTS avatar_showrooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  title text,
  bio text,
  featured_items uuid[] DEFAULT '{}',
  views_count int DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

-- 7. Creator Item Submissions
CREATE TABLE IF NOT EXISTS avatar_creator_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  category text,
  price numeric DEFAULT 0,
  item_data jsonb DEFAULT '{}',
  status text DEFAULT 'pending',
  submitted_at timestamptz DEFAULT now(),
  reviewed_at timestamptz
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_avitems_category ON avatar_items(category);
CREATE INDEX IF NOT EXISTS idx_avitems_featured ON avatar_items(is_featured);
CREATE INDEX IF NOT EXISTS idx_avitems_rarity ON avatar_items(rarity);
CREATE INDEX IF NOT EXISTS idx_avinventory_user ON avatar_inventory(user_id);
CREATE INDEX IF NOT EXISTS idx_avinventory_item ON avatar_inventory(item_id);
CREATE INDEX IF NOT EXISTS idx_avbadges_user ON avatar_badges(user_id);
CREATE INDEX IF NOT EXISTS idx_avtxns_buyer ON avatar_economy_txns(buyer_id);
CREATE INDEX IF NOT EXISTS idx_avwardrobe_user ON avatar_wardrobe(user_id);

-- ── SEED MARKETPLACE ITEMS ──
INSERT INTO avatar_items (name, description, category, rarity, price, currency, is_featured, tags, item_data)
VALUES
  -- Outfits
  ('🌌 Cosmic Suit','Bộ trang phục vũ trụ siêu ngầu','outfit','legendary',500,'SP',true,ARRAY['space','premium','popular'],'{"color":"#7c6dfa","style":"cosmic"}'),
  ('⚡ Neon Jacket','Áo khoác neon phát sáng trong XR','outfit','epic',300,'SP',true,ARRAY['neon','gamer','cool'],'{"color":"#00e5ff","style":"neon"}'),
  ('🌸 Sakura Dress','Bộ đầm hoa anh đào thanh lịch','outfit','rare',200,'SP',false,ARRAY['fashion','elegant','pink'],'{"color":"#ff6b9d","style":"sakura"}'),
  ('👔 Business Elite','Bộ vest doanh nhân chuyên nghiệp','outfit','uncommon',150,'SP',false,ARRAY['formal','business'],'{"color":"#1e3a5f","style":"formal"}'),
  ('🎮 Gamer Hoodie','Hoodie gamer thoải mái với logo','outfit','common',80,'SP',false,ARRAY['gaming','casual'],'{"color":"#2d1b69","style":"hoodie"}'),
  ('🏄 Summer Vibes','Bộ đồ mùa hè năng động','outfit','common',60,'SP',false,ARRAY['summer','casual','beach'],'{"color":"#f59e0b","style":"casual"}'),
  -- Accessories
  ('👑 Crown of Glory','Vương miện vàng cho người dẫn đầu','accessories','legendary',800,'SP',true,ARRAY['crown','prestige','limited'],'{"slot":"head","color":"#fbbf24"}'),
  ('🕶️ Cyber Shades','Kính mắt cyber futuristic','accessories','epic',250,'SP',true,ARRAY['glasses','cyber','cool'],'{"slot":"face","color":"#00e5ff"}'),
  ('🎩 Magic Hat','Chiếc mũ phù thủy huyền bí','accessories','rare',180,'SP',false,ARRAY['hat','magic'],'{"slot":"head","color":"#1a0a2a"}'),
  ('💍 Digital Ring','Nhẫn digital phát sáng','accessories','uncommon',120,'SP',false,ARRAY['ring','glow'],'{"slot":"hands","color":"#7c6dfa"}'),
  ('🎒 Space Backpack','Ba lô vũ trụ với hiệu ứng hạt','accessories','rare',200,'SP',false,ARRAY['backpack','space'],'{"slot":"back","color":"#0a1a2a"}'),
  -- Emotes
  ('💃 Dance Fever','Điệu nhảy sôi động không thể cưỡng','emote','epic',350,'SP',true,ARRAY['dance','fun','popular'],'{"animation":"dance_fever","duration":3}'),
  ('🤝 Legendary Handshake','Cú bắt tay huyền thoại','emote','rare',200,'SP',false,ARRAY['social','handshake'],'{"animation":"handshake","duration":2}'),
  ('🙅 Iconic Reject','Màn từ chối huyền thoại','emote','uncommon',100,'SP',false,ARRAY['funny','reject'],'{"animation":"reject","duration":2}'),
  ('❤️ Heart Shower','Tạo trận mưa tim xung quanh','emote','epic',280,'SP',false,ARRAY['love','hearts','social'],'{"animation":"heart_shower","duration":4}'),
  ('🎉 Confetti Pop','Bắn pháo giấy mừng lễ','emote','rare',180,'SP',false,ARRAY['celebrate','party'],'{"animation":"confetti","duration":3}'),
  -- Skins
  ('🌙 Lunar Skin','Da ánh trăng huyền ảo','skin','legendary',600,'SP',true,ARRAY['moon','glow','premium'],'{"effect":"lunar_glow","color":"#c0d8ff"}'),
  ('🔥 Fire Aura','Hiệu ứng lửa bao quanh người','skin','epic',400,'SP',false,ARRAY['fire','aura','epic'],'{"effect":"fire_aura","color":"#ff4500"}'),
  ('❄️ Ice Crystal','Da tinh thể băng trong suốt','skin','rare',250,'SP',false,ARRAY['ice','crystal'],'{"effect":"ice_crystal","color":"#a8d8ff"}'),
  ('🌿 Nature Spirit','Hòa mình với thiên nhiên','skin','uncommon',160,'SP',false,ARRAY['nature','green'],'{"effect":"nature_glow","color":"#39ff14"}'),
  -- Badges
  ('⭐ Early Adopter Badge','Huy hiệu người dùng sớm','badge','limited',0,'SP',false,ARRAY['badge','founder'],'{"icon":"⭐","color":"#fbbf24"}'),
  ('🏆 Champion Badge','Huy hiệu nhà vô địch','badge','epic',500,'SP',false,ARRAY['badge','champion'],'{"icon":"🏆","color":"#7c6dfa"}')
ON CONFLICT DO NOTHING;

-- Seed default badges for first user
INSERT INTO avatar_badges (user_id, badge_type, label, description)
SELECT id, 'early_adopter', '⭐ Early Adopter', 'Người dùng SafePass từ những ngày đầu'
FROM users ORDER BY created_at LIMIT 1
ON CONFLICT DO NOTHING;
