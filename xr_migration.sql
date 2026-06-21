-- ================================================================
-- PHASE SOCIAL 11: XR SOCIAL NETWORK
-- Run this in Supabase SQL Editor
-- ================================================================

-- 1. XR Spaces (virtual rooms/environments)
CREATE TABLE IF NOT EXISTS xr_spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  type text DEFAULT 'social',
  theme text DEFAULT 'cosmos',
  privacy text DEFAULT 'public',
  capacity int DEFAULT 50,
  visitors_count int DEFAULT 0,
  total_visits bigint DEFAULT 0,
  is_featured bool DEFAULT false,
  is_active bool DEFAULT true,
  tags text[],
  thumbnail text,
  xr_mode text DEFAULT 'webxr',
  created_at timestamptz DEFAULT now()
);

-- 2. XR Space Visits
CREATE TABLE IF NOT EXISTS xr_space_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid REFERENCES xr_spaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  duration_secs int DEFAULT 0,
  device_type text DEFAULT 'desktop',
  visited_at timestamptz DEFAULT now()
);

-- 3. XR Avatars (one per user)
CREATE TABLE IF NOT EXISTS xr_avatars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  display_name text,
  body_type text DEFAULT 'humanoid',
  skin_tone text DEFAULT '#f5c5a3',
  hair_style text DEFAULT 'short',
  hair_color text DEFAULT '#3d2b1f',
  outfit text DEFAULT 'casual',
  outfit_color text DEFAULT '#6c63ff',
  accessories text[] DEFAULT '{}',
  emote text DEFAULT 'wave',
  xp int DEFAULT 0,
  level int DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 4. XR Events (virtual concerts, conferences, etc.)
CREATE TABLE IF NOT EXISTS xr_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  space_id uuid REFERENCES xr_spaces(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  type text DEFAULT 'concert',
  image_url text,
  start_at timestamptz,
  end_at timestamptz,
  max_attendees int DEFAULT 200,
  attendees_count int DEFAULT 0,
  status text DEFAULT 'upcoming',
  is_featured bool DEFAULT false,
  ticket_price numeric DEFAULT 0,
  xr_mode text DEFAULT 'webxr',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS xr_event_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES xr_events(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz DEFAULT now(),
  UNIQUE(event_id, user_id)
);

-- 5. XR Devices
CREATE TABLE IF NOT EXISTS xr_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text DEFAULT 'webxr',
  platform text DEFAULT 'browser',
  is_primary bool DEFAULT false,
  last_used timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- 6. XR Creator Rooms
CREATE TABLE IF NOT EXISTS xr_creator_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  type text DEFAULT 'showcase',
  theme text DEFAULT 'studio',
  visits_count int DEFAULT 0,
  is_public bool DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_xr_spaces_owner ON xr_spaces(owner_id);
CREATE INDEX IF NOT EXISTS idx_xr_spaces_type ON xr_spaces(type);
CREATE INDEX IF NOT EXISTS idx_xr_spaces_featured ON xr_spaces(is_featured);
CREATE INDEX IF NOT EXISTS idx_xr_visits_space ON xr_space_visits(space_id);
CREATE INDEX IF NOT EXISTS idx_xr_visits_user ON xr_space_visits(user_id);
CREATE INDEX IF NOT EXISTS idx_xr_avatars_user ON xr_avatars(user_id);
CREATE INDEX IF NOT EXISTS idx_xr_events_status ON xr_events(status);
CREATE INDEX IF NOT EXISTS idx_xr_events_organizer ON xr_events(organizer_id);
CREATE INDEX IF NOT EXISTS idx_xr_event_attendees ON xr_event_attendees(event_id);
CREATE INDEX IF NOT EXISTS idx_xr_devices_user ON xr_devices(user_id);

-- Seed featured spaces
INSERT INTO xr_spaces (owner_id, name, description, type, theme, privacy, is_featured, visitors_count, tags)
SELECT
  (SELECT id FROM users ORDER BY created_at LIMIT 1),
  name, description, type, theme, 'public', true, visitors_count, tags
FROM (VALUES
  ('🎵 Concert Hall XR','Không gian hòa nhạc ảo — trải nghiệm âm nhạc 360°','concert','aurora',12480,ARRAY['concert','music','live']),
  ('🏢 Business District','Văn phòng ảo và trung tâm thương mại XR','office','corporate',8310,ARRAY['business','office','meeting']),
  ('🎮 Gaming Arena','Đấu trường game và esports ảo','gaming','neon',15920,ARRAY['gaming','esports','arena']),
  ('🌿 Zen Garden','Không gian thiền định và xã hội thư giãn','social','nature',6440,ARRAY['zen','social','relax']),
  ('🛍️ Shopping Mall XR','Trung tâm mua sắm ảo 3D','marketplace','luxury',9870,ARRAY['shopping','marketplace','3d']),
  ('🎓 Learning Hub','Không gian học tập và hội thảo XR','education','space',5230,ARRAY['education','learning','conference'])
) AS t(name, description, type, theme, visitors_count, tags)
WHERE EXISTS (SELECT 1 FROM users LIMIT 1)
ON CONFLICT DO NOTHING;

-- Seed featured XR events
INSERT INTO xr_events (organizer_id, title, description, type, status, is_featured, attendees_count, max_attendees, start_at, end_at)
SELECT
  (SELECT id FROM users ORDER BY created_at LIMIT 1),
  title, description, type, 'upcoming', true, attendees_count, max_attendees,
  now() + (days_ahead || ' days')::interval,
  now() + (days_ahead || ' days')::interval + interval '3 hours'
FROM (VALUES
  ('🎵 Virtual Concert Night','Đêm nhạc ảo với các nghệ sĩ hàng đầu trong không gian XR','concert',342,1000,3),
  ('🏢 XR Business Summit 2026','Hội nghị kinh doanh trong không gian ảo — networking & pitching','conference',156,500,7),
  ('🎮 Esports Championship XR','Giải đấu esports trong arena ảo — xem và trải nghiệm cùng','gaming',891,2000,5),
  ('🎨 Creator Showcase XR','Triển lãm tác phẩm sáng tạo trong không gian 3D','showcase',234,800,10)
) AS t(title, description, type, attendees_count, max_attendees, days_ahead)
WHERE EXISTS (SELECT 1 FROM users LIMIT 1)
ON CONFLICT DO NOTHING;
