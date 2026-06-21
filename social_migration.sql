-- Phase 18: SafePass Social Commerce Migration

-- Social Videos
CREATE TABLE IF NOT EXISTS social_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  video_url TEXT,
  thumbnail_url TEXT,
  hashtags TEXT[] DEFAULT '{}',
  views_count INT DEFAULT 0,
  likes_count INT DEFAULT 0,
  comments_count INT DEFAULT 0,
  shares_count INT DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','hidden','banned','processing')),
  is_live BOOLEAN DEFAULT FALSE,
  live_ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Video Products (attach listing to video)
CREATE TABLE IF NOT EXISTS social_video_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL REFERENCES social_videos(id) ON DELETE CASCADE,
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  custom_title TEXT,
  custom_price BIGINT,
  custom_image TEXT,
  display_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Video Likes
CREATE TABLE IF NOT EXISTS social_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id UUID NOT NULL REFERENCES social_videos(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, video_id)
);

-- Video Comments
CREATE TABLE IF NOT EXISTS social_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL REFERENCES social_videos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES social_comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  likes_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Follow System
CREATE TABLE IF NOT EXISTS social_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(follower_id, following_id)
);

-- Live Streams
CREATE TABLE IF NOT EXISTS social_livestreams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id UUID REFERENCES social_videos(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  stream_key TEXT UNIQUE DEFAULT gen_random_uuid()::TEXT,
  status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended')),
  viewers_count INT DEFAULT 0,
  peak_viewers INT DEFAULT 0,
  total_messages INT DEFAULT 0,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live Stream Products
CREATE TABLE IF NOT EXISTS social_live_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  livestream_id UUID NOT NULL REFERENCES social_livestreams(id) ON DELETE CASCADE,
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  custom_title TEXT,
  custom_price BIGINT,
  custom_image TEXT,
  is_featured BOOLEAN DEFAULT FALSE,
  display_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live Chat Messages
CREATE TABLE IF NOT EXISTS social_live_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  livestream_id UUID NOT NULL REFERENCES social_livestreams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'message' CHECK (type IN ('message','gift','system','join')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Creator Stats (denormalized for performance)
CREATE TABLE IF NOT EXISTS social_creator_stats (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  followers_count INT DEFAULT 0,
  following_count INT DEFAULT 0,
  total_videos INT DEFAULT 0,
  total_views BIGINT DEFAULT 0,
  total_likes BIGINT DEFAULT 0,
  total_sales INT DEFAULT 0,
  total_revenue BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_social_videos_user ON social_videos(user_id);
CREATE INDEX IF NOT EXISTS idx_social_videos_status ON social_videos(status);
CREATE INDEX IF NOT EXISTS idx_social_videos_created ON social_videos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_videos_views ON social_videos(views_count DESC);
CREATE INDEX IF NOT EXISTS idx_social_likes_video ON social_likes(video_id);
CREATE INDEX IF NOT EXISTS idx_social_comments_video ON social_comments(video_id);
CREATE INDEX IF NOT EXISTS idx_social_follows_follower ON social_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_social_follows_following ON social_follows(following_id);
CREATE INDEX IF NOT EXISTS idx_social_live_messages ON social_live_messages(livestream_id, created_at);
