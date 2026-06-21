-- ================================================================
-- PHASE SOCIAL 10: VIRTUAL WORLDS NETWORK
-- Run this in Supabase SQL Editor
-- ================================================================

-- 1. Worlds
CREATE TABLE IF NOT EXISTS vw_worlds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  description text,
  cover_image text,
  avatar text,
  theme text DEFAULT 'default',
  type text DEFAULT 'community',
  privacy text DEFAULT 'public',
  status text DEFAULT 'active',
  members_count int DEFAULT 1,
  posts_count int DEFAULT 0,
  events_count int DEFAULT 0,
  listings_count int DEFAULT 0,
  is_featured bool DEFAULT false,
  is_verified bool DEFAULT false,
  tags text[],
  rules text[],
  created_at timestamptz DEFAULT now()
);

-- 2. World Members
CREATE TABLE IF NOT EXISTS vw_world_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid REFERENCES vw_worlds(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role text DEFAULT 'member',
  reputation int DEFAULT 0,
  joined_at timestamptz DEFAULT now(),
  UNIQUE(world_id, user_id)
);

-- 3. World Posts
CREATE TABLE IF NOT EXISTS vw_world_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid REFERENCES vw_worlds(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE CASCADE,
  type text DEFAULT 'post',
  content text NOT NULL,
  image_url text,
  is_pinned bool DEFAULT false,
  likes_count int DEFAULT 0,
  comments_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- 4. World Post Likes
CREATE TABLE IF NOT EXISTS vw_world_post_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid REFERENCES vw_world_posts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(post_id, user_id)
);

-- 5. World Events
CREATE TABLE IF NOT EXISTS vw_world_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid REFERENCES vw_worlds(id) ON DELETE CASCADE,
  organizer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  type text DEFAULT 'meetup',
  image_url text,
  start_at timestamptz,
  end_at timestamptz,
  location text DEFAULT 'Online',
  max_attendees int DEFAULT 100,
  attendees_count int DEFAULT 0,
  status text DEFAULT 'upcoming',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vw_world_event_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES vw_world_events(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(event_id, user_id)
);

-- 6. World Marketplace Listings
CREATE TABLE IF NOT EXISTS vw_world_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid REFERENCES vw_worlds(id) ON DELETE CASCADE,
  seller_id uuid REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  price numeric DEFAULT 0,
  category text DEFAULT 'other',
  image_url text,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);

-- 7. World Chat Messages
CREATE TABLE IF NOT EXISTS vw_world_chat (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid REFERENCES vw_worlds(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES users(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_vw_worlds_owner ON vw_worlds(owner_id);
CREATE INDEX IF NOT EXISTS idx_vw_worlds_type ON vw_worlds(type);
CREATE INDEX IF NOT EXISTS idx_vw_worlds_privacy ON vw_worlds(privacy);
CREATE INDEX IF NOT EXISTS idx_vw_worlds_featured ON vw_worlds(is_featured);
CREATE INDEX IF NOT EXISTS idx_vw_members_world ON vw_world_members(world_id);
CREATE INDEX IF NOT EXISTS idx_vw_members_user ON vw_world_members(user_id);
CREATE INDEX IF NOT EXISTS idx_vw_posts_world ON vw_world_posts(world_id);
CREATE INDEX IF NOT EXISTS idx_vw_events_world ON vw_world_events(world_id);
CREATE INDEX IF NOT EXISTS idx_vw_listings_world ON vw_world_listings(world_id);
CREATE INDEX IF NOT EXISTS idx_vw_chat_world ON vw_world_chat(world_id);

-- Seed featured worlds
INSERT INTO vw_worlds (owner_id, name, slug, description, theme, type, privacy, is_featured, is_verified, members_count, tags)
SELECT 
  (SELECT id FROM users ORDER BY created_at LIMIT 1),
  name, slug, description, theme, type, 'public', true, true, members_count, tags
FROM (VALUES
  ('🎮 Gaming Hub','gaming-hub','Thế giới game, mua bán tài khoản, skin, vật phẩm ảo.','gaming','business',8420,ARRAY['game','moba','fps','rpg']),
  ('🎵 Concert World','concert-world','Vé concert, merchandise, fan club & sự kiện âm nhạc.','concert','community',5310,ARRAY['nhac','concert','ticket','fanclub']),
  ('👟 Nike World','nike-world','Cộng đồng thể thao, giày, phụ kiện chính hãng.','brand','business',3190,ARRAY['brand','thethao','sneaker']),
  ('📚 Education World','education-world','Học tập, chia sẻ tài liệu, khóa học & mentoring.','education','community',7620,ARRAY['hocthuat','course','mentor'])
) AS t(name,slug,description,theme,type,members_count,tags)
WHERE EXISTS (SELECT 1 FROM users LIMIT 1)
ON CONFLICT (slug) DO NOTHING;
