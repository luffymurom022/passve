-- ================================================================
-- PHASE SOCIAL 14: WORLD OPERATING SYSTEM — MIGRATION SQL
-- Chạy file này trong Supabase SQL Editor
-- ================================================================

-- WORLDS (core table)
CREATE TABLE IF NOT EXISTS worlds (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  owner_name text,
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  description text,
  template text DEFAULT 'social', -- social | business | education | gaming | event | creator
  cover_image text,
  avatar_image text,
  status text DEFAULT 'active', -- active | suspended | archived
  is_public boolean DEFAULT true,
  is_featured boolean DEFAULT false,
  membership_model text DEFAULT 'open', -- open | invite | paid | token-gated
  entry_fee bigint DEFAULT 0,
  member_count int DEFAULT 0,
  post_count int DEFAULT 0,
  event_count int DEFAULT 0,
  revenue bigint DEFAULT 0,
  trust_score numeric DEFAULT 0,
  tags text[],
  world_rules text,
  welcome_message text,
  primary_color text DEFAULT '#7C3AED',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- WORLD MEMBERS
CREATE TABLE IF NOT EXISTS world_members (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  world_id uuid REFERENCES worlds(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role text DEFAULT 'member', -- founder | governor | admin | moderator | member | visitor
  status text DEFAULT 'active', -- active | banned | pending
  joined_at timestamptz DEFAULT now(),
  last_active timestamptz DEFAULT now(),
  contribution_score int DEFAULT 0,
  UNIQUE(world_id, user_id)
);

-- WORLD DISTRICTS (cities, zones, communities within a world)
CREATE TABLE IF NOT EXISTS world_districts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  world_id uuid REFERENCES worlds(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text DEFAULT 'district', -- city | district | zone | community
  description text,
  icon text DEFAULT '🏙️',
  member_count int DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- WORLD PORTALS (travel between worlds)
CREATE TABLE IF NOT EXISTS world_portals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  from_world_id uuid REFERENCES worlds(id) ON DELETE CASCADE,
  to_world_id uuid REFERENCES worlds(id) ON DELETE CASCADE,
  portal_type text DEFAULT 'public', -- public | friend | featured | paid
  travel_count int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(from_world_id, to_world_id)
);

-- WORLD EVENTS
CREATE TABLE IF NOT EXISTS world_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  world_id uuid REFERENCES worlds(id) ON DELETE CASCADE,
  creator_id uuid REFERENCES users(id),
  creator_name text,
  title text NOT NULL,
  description text,
  event_type text DEFAULT 'community', -- conference | festival | creator | community | meetup | vip
  cover_image text,
  start_time timestamptz,
  end_time timestamptz,
  max_attendees int DEFAULT 0,
  attendee_count int DEFAULT 0,
  ticket_price bigint DEFAULT 0,
  status text DEFAULT 'upcoming', -- upcoming | live | ended | cancelled
  created_at timestamptz DEFAULT now()
);

-- WORLD EVENT ATTENDEES
CREATE TABLE IF NOT EXISTS world_event_attendees (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id uuid REFERENCES world_events(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  user_name text,
  ticket_type text DEFAULT 'free',
  joined_at timestamptz DEFAULT now(),
  UNIQUE(event_id, user_id)
);

-- WORLD KNOWLEDGE (wiki, rules, docs per world)
CREATE TABLE IF NOT EXISTS world_knowledge (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  world_id uuid REFERENCES worlds(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  author_name text,
  type text DEFAULT 'doc', -- doc | rule | history | announcement | faq
  title text NOT NULL,
  content text NOT NULL,
  is_pinned boolean DEFAULT false,
  view_count int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- WORLD POSTS (activity feed per world)
CREATE TABLE IF NOT EXISTS world_posts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  world_id uuid REFERENCES worlds(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  author_name text,
  content text NOT NULL,
  media_url text,
  post_type text DEFAULT 'post', -- post | announcement | marketplace | event
  like_count int DEFAULT 0,
  comment_count int DEFAULT 0,
  is_pinned boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- WORLD MARKETPLACE (economy per world)
CREATE TABLE IF NOT EXISTS world_marketplace (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  world_id uuid REFERENCES worlds(id) ON DELETE CASCADE,
  seller_id uuid REFERENCES users(id),
  seller_name text,
  title text NOT NULL,
  description text,
  category text DEFAULT 'digital', -- digital | service | experience | ticket | nft
  price bigint NOT NULL DEFAULT 0,
  cover_image text,
  status text DEFAULT 'available', -- available | sold | paused
  sale_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- WORLD REPORTS (moderation)
CREATE TABLE IF NOT EXISTS world_reports (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  world_id uuid REFERENCES worlds(id) ON DELETE CASCADE,
  reporter_id uuid REFERENCES users(id),
  reported_user_id uuid REFERENCES users(id),
  report_type text DEFAULT 'spam', -- spam | harassment | inappropriate | fraud | other
  description text,
  status text DEFAULT 'pending', -- pending | reviewed | resolved | dismissed
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- WORLD ANALYTICS (daily snapshots)
CREATE TABLE IF NOT EXISTS world_analytics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  world_id uuid REFERENCES worlds(id) ON DELETE CASCADE,
  date date DEFAULT CURRENT_DATE,
  new_members int DEFAULT 0,
  active_members int DEFAULT 0,
  new_posts int DEFAULT 0,
  new_events int DEFAULT 0,
  revenue bigint DEFAULT 0,
  page_views int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(world_id, date)
);

-- WORLD GOVERNANCE (rules and permissions per world)
CREATE TABLE IF NOT EXISTS world_governance (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  world_id uuid REFERENCES worlds(id) ON DELETE CASCADE UNIQUE,
  allow_posts boolean DEFAULT true,
  allow_marketplace boolean DEFAULT true,
  allow_events boolean DEFAULT true,
  allow_guests boolean DEFAULT true,
  post_approval_required boolean DEFAULT false,
  min_trust_score numeric DEFAULT 0,
  custom_roles jsonb DEFAULT '{}',
  moderation_mode text DEFAULT 'community', -- community | strict | ai | open
  updated_at timestamptz DEFAULT now()
);

-- ================================================================
-- DISABLE RLS
-- ================================================================
ALTER TABLE worlds DISABLE ROW LEVEL SECURITY;
ALTER TABLE world_members DISABLE ROW LEVEL SECURITY;
ALTER TABLE world_districts DISABLE ROW LEVEL SECURITY;
ALTER TABLE world_portals DISABLE ROW LEVEL SECURITY;
ALTER TABLE world_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE world_event_attendees DISABLE ROW LEVEL SECURITY;
ALTER TABLE world_knowledge DISABLE ROW LEVEL SECURITY;
ALTER TABLE world_posts DISABLE ROW LEVEL SECURITY;
ALTER TABLE world_marketplace DISABLE ROW LEVEL SECURITY;
ALTER TABLE world_reports DISABLE ROW LEVEL SECURITY;
ALTER TABLE world_analytics DISABLE ROW LEVEL SECURITY;
ALTER TABLE world_governance DISABLE ROW LEVEL SECURITY;

-- ================================================================
-- INDEXES
-- ================================================================
CREATE INDEX IF NOT EXISTS idx_worlds_owner ON worlds(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_worlds_template ON worlds(template, status);
CREATE INDEX IF NOT EXISTS idx_worlds_featured ON worlds(is_featured, member_count DESC);
CREATE INDEX IF NOT EXISTS idx_world_members_world ON world_members(world_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_world_members_user ON world_members(user_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_world_events_world ON world_events(world_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_world_posts_world ON world_posts(world_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_world_marketplace_world ON world_marketplace(world_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_world_knowledge_world ON world_knowledge(world_id, type);
CREATE INDEX IF NOT EXISTS idx_world_analytics_world ON world_analytics(world_id, date DESC);

-- ================================================================
-- SEED DATA — 8 featured worlds
-- ================================================================
INSERT INTO worlds (owner_id, owner_name, name, slug, description, template, is_featured, member_count, tags)
SELECT
  (SELECT id FROM users LIMIT 1),
  'SafePass',
  w.name, w.slug, w.description, w.template, true, w.members, w.tags
FROM (VALUES
  ('🏙️ SafeCity', 'safecity', 'Thành phố thương mại số lớn nhất — mua bán, kết nối, kinh doanh', 'business', 12400, ARRAY['commerce','business','city']),
  ('🎮 GameVerse', 'gameverse', 'Vũ trụ game — thi đấu, giao lưu, mua bán vật phẩm', 'gaming', 8900, ARRAY['gaming','esports','nft']),
  ('🎓 EduWorld', 'eduworld', 'Thế giới học tập — khóa học, mentorship, thi chứng chỉ', 'education', 6300, ARRAY['education','learning','courses']),
  ('🎨 CreatorHub', 'creatorhub', 'Không gian sáng tạo — nội dung, reels, monetize', 'creator', 9700, ARRAY['creator','content','monetize']),
  ('🎪 EventWorld', 'eventworld', 'Trung tâm sự kiện — concert, hội thảo, festival', 'event', 5100, ARRAY['events','concerts','festival']),
  ('🌿 SocialGarden', 'socialgarden', 'Cộng đồng kết nối — chia sẻ, trò chuyện, lan tỏa', 'social', 15200, ARRAY['social','community','lifestyle']),
  ('💼 BizNation', 'biznation', 'Quốc gia doanh nghiệp — B2B, startup, investment', 'business', 4600, ARRAY['business','startup','b2b']),
  ('🚀 FutureLab', 'futurelab', 'Phòng thí nghiệm tương lai — XR, AI, blockchain, metaverse', 'creator', 7800, ARRAY['xr','ai','future','tech'])
) AS w(name, slug, description, template, members, tags)
WHERE EXISTS (SELECT 1 FROM users LIMIT 1)
ON CONFLICT (slug) DO NOTHING;
