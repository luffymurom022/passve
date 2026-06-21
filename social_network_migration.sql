-- SafePass Social Network Core Migration
-- Run this in Supabase SQL Editor

-- ── 1. Extended User Profile ──
CREATE TABLE IF NOT EXISTS sn_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  avatar_url TEXT,
  cover_url TEXT,
  bio TEXT,
  location TEXT,
  website TEXT,
  birthday DATE,
  gender TEXT CHECK (gender IN ('male','female','other','hidden')),
  friends_count INT DEFAULT 0,
  followers_count INT DEFAULT 0,
  following_count INT DEFAULT 0,
  posts_count INT DEFAULT 0,
  is_private BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. Posts ──
CREATE TABLE IF NOT EXISTS sn_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID,
  page_id UUID,
  content TEXT,
  media_urls TEXT[] DEFAULT '{}',
  media_type TEXT DEFAULT 'none' CHECK (media_type IN ('none','image','video','mixed')),
  post_type TEXT DEFAULT 'post' CHECK (post_type IN ('post','share','product_share')),
  shared_post_id UUID REFERENCES sn_posts(id) ON DELETE SET NULL,
  product_ref_id UUID,
  reactions_count INT DEFAULT 0,
  comments_count INT DEFAULT 0,
  shares_count INT DEFAULT 0,
  visibility TEXT DEFAULT 'public' CHECK (visibility IN ('public','friends','private')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active','hidden','deleted')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. Reactions ──
CREATE TABLE IF NOT EXISTS sn_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES sn_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction TEXT NOT NULL CHECK (reaction IN ('like','love','haha','wow','sad','angry')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

-- ── 4. Comments ──
CREATE TABLE IF NOT EXISTS sn_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES sn_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES sn_comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  media_url TEXT,
  likes_count INT DEFAULT 0,
  replies_count INT DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','hidden','deleted')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 5. Comment Likes ──
CREATE TABLE IF NOT EXISTS sn_comment_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id UUID NOT NULL REFERENCES sn_comments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(comment_id, user_id)
);

-- ── 6. Friendships ──
CREATE TABLE IF NOT EXISTS sn_friendships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','blocked')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(requester_id, addressee_id)
);

-- ── 7. Groups ──
CREATE TABLE IF NOT EXISTS sn_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  avatar_url TEXT,
  cover_url TEXT,
  category TEXT DEFAULT 'general',
  privacy TEXT DEFAULT 'public' CHECK (privacy IN ('public','private','secret')),
  members_count INT DEFAULT 0,
  posts_count INT DEFAULT 0,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','archived','banned')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 8. Group Members ──
CREATE TABLE IF NOT EXISTS sn_group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES sn_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member' CHECK (role IN ('admin','moderator','member')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, user_id)
);

-- ── 9. Pages ──
CREATE TABLE IF NOT EXISTS sn_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  username TEXT UNIQUE,
  description TEXT,
  avatar_url TEXT,
  cover_url TEXT,
  category TEXT DEFAULT 'business',
  website TEXT,
  phone TEXT,
  email TEXT,
  followers_count INT DEFAULT 0,
  posts_count INT DEFAULT 0,
  is_verified BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','inactive','banned')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 10. Page Followers ──
CREATE TABLE IF NOT EXISTS sn_page_followers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES sn_pages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(page_id, user_id)
);

-- ── 11. Notifications ──
CREATE TABLE IF NOT EXISTS sn_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'friend_request','friend_accept',
    'post_reaction','post_comment','comment_reply','post_share',
    'group_invite','group_join_request','group_post',
    'page_follow','new_follower','mention','tag'
  )),
  entity_type TEXT CHECK (entity_type IN ('post','comment','group','page','user')),
  entity_id UUID,
  message TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_sn_posts_user ON sn_posts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sn_posts_group ON sn_posts(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sn_posts_status ON sn_posts(status);
CREATE INDEX IF NOT EXISTS idx_sn_reactions_post ON sn_reactions(post_id);
CREATE INDEX IF NOT EXISTS idx_sn_comments_post ON sn_comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sn_comments_parent ON sn_comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_sn_friendships_req ON sn_friendships(requester_id);
CREATE INDEX IF NOT EXISTS idx_sn_friendships_addr ON sn_friendships(addressee_id);
CREATE INDEX IF NOT EXISTS idx_sn_group_members_group ON sn_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_sn_group_members_user ON sn_group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_sn_notifications_user ON sn_notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sn_notifications_read ON sn_notifications(user_id, is_read);

-- ── Seed default profiles for existing users ──
INSERT INTO sn_profiles (user_id)
SELECT id FROM users
WHERE id NOT IN (SELECT user_id FROM sn_profiles)
ON CONFLICT DO NOTHING;
