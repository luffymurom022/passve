-- Phase 20: SafePass Marketplace (Facebook-style) Migration

-- Main posts/listings table
CREATE TABLE IF NOT EXISTS marketplace_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT,
  post_type TEXT DEFAULT 'status' CHECK (post_type IN ('status','listing','want')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active','sold','deleted','banned')),

  -- Listing fields (when post_type = 'listing' or 'want')
  listing_title TEXT,
  listing_price BIGINT DEFAULT 0,
  listing_category TEXT DEFAULT 'other',
  listing_condition TEXT DEFAULT 'used' CHECK (listing_condition IN ('new','good','used')),
  listing_location TEXT,
  listing_description TEXT,

  -- Media
  images JSONB DEFAULT '[]',

  -- Stats
  likes_count INT DEFAULT 0,
  comments_count INT DEFAULT 0,
  shares_count INT DEFAULT 0,
  views_count INT DEFAULT 0,
  saves_count INT DEFAULT 0,

  -- Audience
  audience TEXT DEFAULT 'public' CHECK (audience IN ('public','friends','private')),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Comments
CREATE TABLE IF NOT EXISTS marketplace_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES marketplace_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES marketplace_comments(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  likes_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Likes
CREATE TABLE IF NOT EXISTS marketplace_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES marketplace_posts(id) ON DELETE CASCADE,
  comment_id UUID REFERENCES marketplace_comments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction TEXT DEFAULT 'like' CHECK (reaction IN ('like','love','haha','wow','sad','angry')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id),
  CHECK (post_id IS NOT NULL OR comment_id IS NOT NULL)
);

-- Saves/Bookmarks
CREATE TABLE IF NOT EXISTS marketplace_saves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES marketplace_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

-- Friend requests
CREATE TABLE IF NOT EXISTS marketplace_friends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','accepted','blocked')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, friend_id)
);

-- Groups (buy/sell groups)
CREATE TABLE IF NOT EXISTS marketplace_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  cover_url TEXT,
  privacy TEXT DEFAULT 'public' CHECK (privacy IN ('public','private')),
  members_count INT DEFAULT 0,
  posts_count INT DEFAULT 0,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Group memberships
CREATE TABLE IF NOT EXISTS marketplace_group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES marketplace_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member' CHECK (role IN ('member','moderator','admin')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, user_id)
);

-- Stories
CREATE TABLE IF NOT EXISTS marketplace_stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_url TEXT,
  media_type TEXT DEFAULT 'image' CHECK (media_type IN ('image','video')),
  text_content TEXT,
  background_color TEXT,
  views_count INT DEFAULT 0,
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Post reports
CREATE TABLE IF NOT EXISTS marketplace_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES marketplace_posts(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','reviewed','dismissed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mp_posts_user ON marketplace_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_mp_posts_status ON marketplace_posts(status);
CREATE INDEX IF NOT EXISTS idx_mp_posts_type ON marketplace_posts(post_type);
CREATE INDEX IF NOT EXISTS idx_mp_posts_category ON marketplace_posts(listing_category);
CREATE INDEX IF NOT EXISTS idx_mp_posts_created ON marketplace_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mp_posts_price ON marketplace_posts(listing_price);
CREATE INDEX IF NOT EXISTS idx_mp_comments_post ON marketplace_comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mp_likes_post ON marketplace_likes(post_id, user_id);
CREATE INDEX IF NOT EXISTS idx_mp_saves_user ON marketplace_saves(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mp_friends_user ON marketplace_friends(user_id, status);

-- Full text search on listings
CREATE INDEX IF NOT EXISTS idx_mp_posts_fts ON marketplace_posts USING gin(to_tsvector('simple', COALESCE(listing_title,'') || ' ' || COALESCE(content,'')));
