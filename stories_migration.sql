-- ══════════════════════════════════════════════════════
-- PHASE 21: SAFEPASS STORIES — MIGRATION SQL
-- Chạy file này trong Supabase SQL Editor
-- ══════════════════════════════════════════════════════

-- 1. Stories (post 24h)
CREATE TABLE IF NOT EXISTS stories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'promo'
                CHECK (type IN ('product','flash_sale','promo','announcement')),
  caption     TEXT,
  image_url   TEXT,
  bg_color    TEXT DEFAULT '#1a2a4a',
  emoji       TEXT DEFAULT '🎫',
  listing_id  UUID REFERENCES listings(id) ON DELETE SET NULL,
  price       NUMERIC(15,0),
  original_price NUMERIC(15,0),
  discount_pct INTEGER CHECK (discount_pct BETWEEN 0 AND 100),
  cta_label   TEXT,
  cta_url     TEXT,
  views_count INTEGER NOT NULL DEFAULT 0,
  likes_count INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Story views (unique per viewer)
CREATE TABLE IF NOT EXISTS story_views (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id   UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(story_id, viewer_id)
);

-- 3. Story likes
CREATE TABLE IF NOT EXISTS story_likes (
  story_id   UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (story_id, user_id)
);

-- 4. Story follows (người dùng theo dõi người bán)
CREATE TABLE IF NOT EXISTS story_follows (
  follower_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_stories_user_id ON stories(user_id);
CREATE INDEX IF NOT EXISTS idx_stories_expires_at ON stories(expires_at);
CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);
CREATE INDEX IF NOT EXISTS idx_story_views_story_id ON story_views(story_id);
CREATE INDEX IF NOT EXISTS idx_story_views_viewer_id ON story_views(viewer_id);
CREATE INDEX IF NOT EXISTS idx_story_follows_follower ON story_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_story_follows_following ON story_follows(following_id);
