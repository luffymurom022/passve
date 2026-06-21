-- ================================================================
-- PHASE 15: UNIVERSE OPERATING SYSTEM — MIGRATION SQL
-- Chạy file này trong Supabase SQL Editor
-- ================================================================

-- UNIVERSES (core table)
CREATE TABLE IF NOT EXISTS universes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  owner_name text,
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  description text,
  universe_type text DEFAULT 'social', -- social | business | education | gaming | events | commerce | xr
  cover_image text,
  avatar_image text,
  status text DEFAULT 'active', -- active | suspended | archived
  is_public boolean DEFAULT true,
  is_featured boolean DEFAULT false,
  membership_model text DEFAULT 'open', -- open | invite | paid
  entry_fee bigint DEFAULT 0,
  world_count int DEFAULT 0,
  member_count int DEFAULT 0,
  event_count int DEFAULT 0,
  revenue bigint DEFAULT 0,
  trust_score numeric DEFAULT 0,
  tags text[],
  universe_rules text,
  welcome_message text,
  primary_color text DEFAULT '#6366F1',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- UNIVERSE WORLDS (many-to-many: worlds belonging to universes)
CREATE TABLE IF NOT EXISTS universe_worlds (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  universe_id uuid REFERENCES universes(id) ON DELETE CASCADE,
  world_id uuid,
  world_name text,
  world_type text,
  is_featured boolean DEFAULT false,
  sort_order int DEFAULT 0,
  added_at timestamptz DEFAULT now(),
  UNIQUE(universe_id, world_id)
);

-- UNIVERSE MEMBERS
CREATE TABLE IF NOT EXISTS universe_members (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  universe_id uuid REFERENCES universes(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role text DEFAULT 'member', -- founder | governor | admin | world_owner | moderator | member
  status text DEFAULT 'active',
  joined_at timestamptz DEFAULT now(),
  last_active timestamptz DEFAULT now(),
  UNIQUE(universe_id, user_id)
);

-- UNIVERSE EVENTS
CREATE TABLE IF NOT EXISTS universe_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  universe_id uuid REFERENCES universes(id) ON DELETE CASCADE,
  creator_id uuid REFERENCES users(id),
  creator_name text,
  title text NOT NULL,
  description text,
  event_type text DEFAULT 'conference', -- festival | conference | exhibition | creator | community | vip
  cover_image text,
  start_time timestamptz,
  end_time timestamptz,
  max_attendees int DEFAULT 0,
  attendee_count int DEFAULT 0,
  ticket_price bigint DEFAULT 0,
  host_world text,
  status text DEFAULT 'upcoming',
  created_at timestamptz DEFAULT now()
);

-- UNIVERSE MARKETPLACE (cross-world products)
CREATE TABLE IF NOT EXISTS universe_marketplace (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  universe_id uuid REFERENCES universes(id) ON DELETE CASCADE,
  seller_id uuid REFERENCES users(id),
  seller_name text,
  title text NOT NULL,
  description text,
  category text DEFAULT 'digital',
  price bigint DEFAULT 0,
  cover_image text,
  visible_scope text DEFAULT 'universe', -- world | universe | global
  status text DEFAULT 'available',
  sale_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- UNIVERSE KNOWLEDGE
CREATE TABLE IF NOT EXISTS universe_knowledge (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  universe_id uuid REFERENCES universes(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  author_name text,
  type text DEFAULT 'doc', -- lore | history | rule | doc | faq | announcement
  title text NOT NULL,
  content text NOT NULL,
  is_pinned boolean DEFAULT false,
  view_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- UNIVERSE REPORTS
CREATE TABLE IF NOT EXISTS universe_reports (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  universe_id uuid REFERENCES universes(id) ON DELETE CASCADE,
  reporter_id uuid REFERENCES users(id),
  report_type text DEFAULT 'spam',
  description text,
  status text DEFAULT 'pending',
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- UNIVERSE ANALYTICS (daily snapshots)
CREATE TABLE IF NOT EXISTS universe_analytics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  universe_id uuid REFERENCES universes(id) ON DELETE CASCADE,
  date date DEFAULT CURRENT_DATE,
  new_members int DEFAULT 0,
  active_members int DEFAULT 0,
  new_events int DEFAULT 0,
  revenue bigint DEFAULT 0,
  page_views int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(universe_id, date)
);

-- UNIVERSE SOCIAL GRAPH (cross-universe relationships)
CREATE TABLE IF NOT EXISTS universe_social (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  target_id uuid REFERENCES users(id) ON DELETE CASCADE,
  relation_type text DEFAULT 'friend', -- friend | follow | block
  universe_id uuid REFERENCES universes(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, target_id, universe_id)
);

-- UNIVERSE GOVERNANCE
CREATE TABLE IF NOT EXISTS universe_governance (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  universe_id uuid REFERENCES universes(id) ON DELETE CASCADE UNIQUE,
  allow_world_creation boolean DEFAULT true,
  allow_marketplace boolean DEFAULT true,
  allow_events boolean DEFAULT true,
  allow_guests boolean DEFAULT true,
  moderation_mode text DEFAULT 'community',
  min_trust_score numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

-- ================================================================
-- DISABLE RLS
-- ================================================================
ALTER TABLE universes DISABLE ROW LEVEL SECURITY;
ALTER TABLE universe_worlds DISABLE ROW LEVEL SECURITY;
ALTER TABLE universe_members DISABLE ROW LEVEL SECURITY;
ALTER TABLE universe_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE universe_marketplace DISABLE ROW LEVEL SECURITY;
ALTER TABLE universe_knowledge DISABLE ROW LEVEL SECURITY;
ALTER TABLE universe_reports DISABLE ROW LEVEL SECURITY;
ALTER TABLE universe_analytics DISABLE ROW LEVEL SECURITY;
ALTER TABLE universe_social DISABLE ROW LEVEL SECURITY;
ALTER TABLE universe_governance DISABLE ROW LEVEL SECURITY;

-- ================================================================
-- INDEXES
-- ================================================================
CREATE INDEX IF NOT EXISTS idx_universes_owner ON universes(owner_id);
CREATE INDEX IF NOT EXISTS idx_universes_type ON universes(universe_type, status);
CREATE INDEX IF NOT EXISTS idx_universes_featured ON universes(is_featured, member_count DESC);
CREATE INDEX IF NOT EXISTS idx_universe_members_uni ON universe_members(universe_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_universe_members_user ON universe_members(user_id);
CREATE INDEX IF NOT EXISTS idx_universe_events_uni ON universe_events(universe_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_universe_marketplace_uni ON universe_marketplace(universe_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_universe_knowledge_uni ON universe_knowledge(universe_id, type);

-- ================================================================
-- SEED DATA — 8 featured universes
-- ================================================================
INSERT INTO universes (owner_id, owner_name, name, slug, description, universe_type, is_featured, member_count, tags)
SELECT
  (SELECT id FROM users LIMIT 1),
  'SafePass',
  u.name, u.slug, u.description, u.utype, true, u.members, u.tags
FROM (VALUES
  ('🌌 SafeUniverse', 'safeuniverse', 'Vũ trụ chính của SafePass — trung tâm của mọi nền kinh tế số', 'commerce', 89400, ARRAY['commerce','flagship','safepass']),
  ('⚡ GameUniverse', 'gameuniverse', 'Vũ trụ game — esports, metaverse gaming, NFT, vật phẩm số', 'gaming', 54200, ARRAY['gaming','esports','metaverse']),
  ('🎓 EduUniverse', 'eduuniverse', 'Vũ trụ giáo dục — đại học số, chứng chỉ blockchain, mentorship', 'education', 31800, ARRAY['education','university','blockchain']),
  ('🎨 CreatorUniverse', 'creatoruniverse', 'Vũ trụ sáng tạo — creator economy, NFT art, digital brands', 'commerce', 47600, ARRAY['creator','nft','art','brand']),
  ('🏢 BizUniverse', 'bizuniverse', 'Vũ trụ doanh nghiệp — B2B, investment, startup ecosystem', 'business', 28900, ARRAY['business','b2b','startup']),
  ('🎪 EventUniverse', 'eventuniverse', 'Vũ trụ sự kiện — festival toàn cầu, concert, triển lãm', 'events', 19300, ARRAY['events','festival','concert']),
  ('🥽 XRUniverse', 'xruniverse', 'Vũ trụ XR — VR, AR, spatial computing, avatar worlds', 'xr', 23100, ARRAY['xr','vr','ar','spatial']),
  ('🌐 SocialUniverse', 'socialuniverse', 'Vũ trụ xã hội — kết nối toàn cầu, cộng đồng đa chiều', 'social', 72000, ARRAY['social','community','global'])
) AS u(name, slug, description, utype, members, tags)
WHERE EXISTS (SELECT 1 FROM users LIMIT 1)
ON CONFLICT (slug) DO NOTHING;
