-- ══════════════════════════════════════════════════════════
-- SAFEPASS — PHASE SOCIAL 7: BUSINESS & BRAND ECOSYSTEM
-- Chạy file này trong Supabase SQL Editor
-- ══════════════════════════════════════════════════════════

-- 1. Brand Posts (Facebook-style posts on brand pages)
CREATE TABLE IF NOT EXISTS brand_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES business_accounts(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'post', -- post, promo, event, announcement, product
  content text NOT NULL,
  image_url text,
  cta_text text,
  cta_url text,
  likes_count int DEFAULT 0,
  comments_count int DEFAULT 0,
  views_count int DEFAULT 0,
  is_pinned bool DEFAULT false,
  status text DEFAULT 'active', -- active, hidden, deleted
  created_at timestamptz DEFAULT now()
);

-- 2. Brand Post Likes
CREATE TABLE IF NOT EXISTS brand_post_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid REFERENCES brand_posts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(post_id, user_id)
);

-- 3. Brand Post Comments
CREATE TABLE IF NOT EXISTS brand_post_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid REFERENCES brand_posts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 4. Brand Campaigns (Flash Sales, Coupons, Promos, Events)
CREATE TABLE IF NOT EXISTS brand_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES business_accounts(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'promo', -- promo, flash_sale, coupon, event
  title text NOT NULL,
  description text,
  discount_type text DEFAULT 'percent', -- percent, fixed
  discount_value numeric DEFAULT 0,
  min_order_value numeric DEFAULT 0,
  max_uses int DEFAULT 100,
  uses_count int DEFAULT 0,
  coupon_code text UNIQUE,
  starts_at timestamptz DEFAULT now(),
  ends_at timestamptz,
  status text DEFAULT 'active', -- active, paused, ended, draft
  event_location text,
  event_date timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 5. Campaign Coupon Uses
CREATE TABLE IF NOT EXISTS brand_campaign_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES brand_campaigns(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  used_at timestamptz DEFAULT now(),
  UNIQUE(campaign_id, user_id)
);

-- 6. Brand Collaborations (Influencer/Creator Programs)
CREATE TABLE IF NOT EXISTS brand_collaborations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES business_accounts(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  requirements text,
  budget_min numeric DEFAULT 0,
  budget_max numeric DEFAULT 0,
  commission_rate numeric DEFAULT 10,
  collaboration_type text DEFAULT 'affiliate', -- affiliate, sponsored, gifted, event, ambassador
  status text DEFAULT 'open', -- open, closed, draft
  applications_count int DEFAULT 0,
  deadline timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 7. Brand Collab Applications
CREATE TABLE IF NOT EXISTS brand_collab_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collaboration_id uuid REFERENCES brand_collaborations(id) ON DELETE CASCADE,
  creator_id uuid REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES business_accounts(id) ON DELETE CASCADE,
  message text,
  portfolio_url text,
  follower_count int DEFAULT 0,
  status text DEFAULT 'pending', -- pending, approved, rejected
  created_at timestamptz DEFAULT now(),
  UNIQUE(collaboration_id, creator_id)
);

-- 8. Business Inbox (Customer → Brand messages)
CREATE TABLE IF NOT EXISTS business_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES business_accounts(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  subject text,
  message text NOT NULL,
  reply text,
  replied_at timestamptz,
  is_auto_replied bool DEFAULT false,
  status text DEFAULT 'unread', -- unread, read, replied, closed
  created_at timestamptz DEFAULT now()
);

-- 9. Business Auto-Reply Rules
CREATE TABLE IF NOT EXISTS business_auto_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES business_accounts(id) ON DELETE CASCADE,
  trigger_keyword text NOT NULL,
  reply_text text NOT NULL,
  is_active bool DEFAULT true,
  trigger_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- 10. Brand Follows (Users following brands)
CREATE TABLE IF NOT EXISTS brand_follows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES business_accounts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(business_id, user_id)
);

-- 11. Add followers_count to business_accounts if not exists
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS followers_count int DEFAULT 0;
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS posts_count int DEFAULT 0;
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS trust_score numeric DEFAULT 0;
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS cover_image_url text;
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS category text DEFAULT 'retail';
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS tags text[];

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_brand_posts_business ON brand_posts(business_id);
CREATE INDEX IF NOT EXISTS idx_brand_posts_status ON brand_posts(status);
CREATE INDEX IF NOT EXISTS idx_brand_campaigns_business ON brand_campaigns(business_id);
CREATE INDEX IF NOT EXISTS idx_brand_campaigns_status ON brand_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_brand_collabs_status ON brand_collaborations(status);
CREATE INDEX IF NOT EXISTS idx_business_inbox_business ON business_inbox(business_id);
CREATE INDEX IF NOT EXISTS idx_brand_follows_business ON brand_follows(business_id);
CREATE INDEX IF NOT EXISTS idx_brand_follows_user ON brand_follows(user_id);
