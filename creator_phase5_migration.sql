-- ═══════════════════════════════════════════════════════
-- SAFEPASS PHASE 5 — CREATOR ECONOMY & AFFILIATE NETWORK
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════

-- Module 1: Creator profiles
CREATE TABLE IF NOT EXISTS creator_profiles (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  handle text UNIQUE NOT NULL,
  -- e.g. "minhtu_official"  → safepass.com/@minhtu_official
  display_name text,
  bio text,
  avatar_url text,
  cover_url text,
  category text DEFAULT 'general',
  -- general, music, gaming, fashion, tech, sports, food, travel
  badge_level text DEFAULT 'creator',
  -- creator, rising, verified, gold, diamond
  badge_score numeric DEFAULT 0,
  follower_count int DEFAULT 0,
  following_count int DEFAULT 0,
  total_views bigint DEFAULT 0,
  total_sales int DEFAULT 0,
  total_revenue bigint DEFAULT 0,
  -- in VND cents
  affiliate_rate numeric DEFAULT 5.0,
  -- % commission on affiliate sales
  is_verified boolean DEFAULT false,
  is_active boolean DEFAULT true,
  social_links jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creator_handle ON creator_profiles(handle);
CREATE INDEX IF NOT EXISTS idx_creator_badge ON creator_profiles(badge_level, badge_score DESC);
CREATE INDEX IF NOT EXISTS idx_creator_user ON creator_profiles(user_id);

-- Module 2: Affiliate links
CREATE TABLE IF NOT EXISTS affiliate_links (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  creator_id uuid REFERENCES creator_profiles(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  product_type text DEFAULT 'ticket',
  -- ticket, product, service
  code text UNIQUE NOT NULL,
  -- short code e.g. "minhtu-abc123"
  commission_rate numeric DEFAULT 5.0,
  click_count int DEFAULT 0,
  sale_count int DEFAULT 0,
  total_earned bigint DEFAULT 0,
  -- VND
  is_active boolean DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_affiliate_creator ON affiliate_links(creator_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_code ON affiliate_links(code);

-- Affiliate click tracking
CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  link_id uuid REFERENCES affiliate_links(id) ON DELETE CASCADE,
  visitor_ip text,
  user_agent text,
  referrer text,
  converted boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_link ON affiliate_clicks(link_id, created_at DESC);

-- Affiliate sales (commissions earned)
CREATE TABLE IF NOT EXISTS affiliate_sales (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  link_id uuid REFERENCES affiliate_links(id) ON DELETE CASCADE,
  creator_id uuid REFERENCES creator_profiles(id) ON DELETE CASCADE,
  order_id text,
  sale_amount bigint NOT NULL,
  -- VND
  commission_amount bigint NOT NULL,
  -- VND earned
  status text DEFAULT 'pending',
  -- pending, approved, paid
  paid_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Module 5/8: Brand collaboration campaigns
CREATE TABLE IF NOT EXISTS brand_campaigns (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand_name text NOT NULL,
  brand_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  category text,
  budget bigint DEFAULT 0,
  -- VND per creator
  commission_per_sale numeric DEFAULT 8.0,
  requirements jsonb DEFAULT '{}',
  -- { min_followers: 1000, categories: ['music'], badge: 'creator' }
  deadline timestamptz,
  status text DEFAULT 'active',
  -- active, paused, ended
  applicant_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Campaign applications
CREATE TABLE IF NOT EXISTS campaign_applications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id uuid REFERENCES brand_campaigns(id) ON DELETE CASCADE,
  creator_id uuid REFERENCES creator_profiles(id) ON DELETE CASCADE,
  pitch text,
  status text DEFAULT 'pending',
  -- pending, approved, rejected
  created_at timestamptz DEFAULT now(),
  UNIQUE(campaign_id, creator_id)
);

-- Module 11: SafeStar virtual gifting
CREATE TABLE IF NOT EXISTS creator_gifts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
  creator_id uuid REFERENCES creator_profiles(id) ON DELETE CASCADE,
  gift_type text DEFAULT 'star',
  -- star, heart, diamond, fire, crown
  quantity int DEFAULT 1,
  value_vnd bigint DEFAULT 0,
  -- VND equivalent
  context text DEFAULT 'reel',
  -- reel, live, post
  context_id text,
  message text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gifts_creator ON creator_gifts(creator_id, created_at DESC);

-- Module 12: Creator wallet transactions
CREATE TABLE IF NOT EXISTS creator_wallet_txns (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  creator_id uuid REFERENCES creator_profiles(id) ON DELETE CASCADE,
  txn_type text NOT NULL,
  -- affiliate_commission, gift_income, live_tip, product_sale, withdrawal, bonus
  amount bigint NOT NULL,
  -- VND (positive = income, negative = withdrawal)
  balance_after bigint DEFAULT 0,
  reference_id text,
  description text,
  status text DEFAULT 'completed',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creator_wallet_creator ON creator_wallet_txns(creator_id, created_at DESC);

-- Module 10: Creator reward badges seed
-- Badge levels are computed, not stored separately

-- Seed: brand campaigns sample data
INSERT INTO brand_campaigns (brand_name, title, description, category, budget, commission_per_sale, requirements, deadline, status) VALUES
('Coldplay Vietnam Tour', 'Quảng bá vé concert Coldplay 2026', 'Chia sẻ về trải nghiệm âm nhạc và vé VIP', 'music', 2000000, 10.0, '{"min_followers":500,"categories":["music"]}', now() + interval '30 days', 'active'),
('GameZone Pro', 'Review PS5 Pro Edition', 'Tạo video review sản phẩm gaming chuyên nghiệp', 'gaming', 1500000, 8.0, '{"min_followers":1000,"categories":["gaming","tech"]}', now() + interval '14 days', 'active'),
('SafePass Escrow', 'Giới thiệu dịch vụ ký quỹ SafePass', 'Hướng dẫn người dùng mới về tính năng escrow an toàn', 'general', 500000, 5.0, '{"min_followers":100}', now() + interval '60 days', 'active')
ON CONFLICT DO NOTHING;
