-- ================================================================
-- PHASE SOCIAL 9: SPATIAL COMMERCE PLATFORM
-- Run this in Supabase SQL Editor
-- ================================================================

-- 1. Spatial Avatars (user avatar customization)
CREATE TABLE IF NOT EXISTS spatial_avatars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  display_name text,
  face text DEFAULT '😊',
  skin_color text DEFAULT '#f5c89a',
  hair_style text DEFAULT 'short',
  hair_color text DEFAULT '#2c1810',
  outfit text DEFAULT 'casual',
  outfit_color text DEFAULT '#3b82f6',
  accessory text DEFAULT 'none',
  badge text DEFAULT 'none',
  bg_color text DEFAULT '#1e3a5f',
  bg_pattern text DEFAULT 'solid',
  bio text,
  status_emoji text DEFAULT '🟢',
  visits int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Spatial Spaces (virtual stores, showrooms, event venues)
CREATE TABLE IF NOT EXISTS spatial_spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  type text DEFAULT 'store',      -- store, showroom, event_venue, gallery, office, community
  theme text DEFAULT 'modern',    -- modern, retro, nature, space, minimal, luxury
  cover_url text,
  accent_color text DEFAULT '#3b82f6',
  is_public bool DEFAULT true,
  is_featured bool DEFAULT false,
  visitors_count int DEFAULT 0,
  products_count int DEFAULT 0,
  status text DEFAULT 'active',   -- active, draft, closed
  tags text[],
  location_label text,            -- "TP. Hồ Chí Minh", "Online", etc.
  xr_ready bool DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 3. Space Products (products placed inside a space)
CREATE TABLE IF NOT EXISTS spatial_space_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid REFERENCES spatial_spaces(id) ON DELETE CASCADE,
  ticket_id uuid,                 -- references tickets(id) — soft reference
  product_title text NOT NULL,
  product_price numeric DEFAULT 0,
  product_image text,
  product_description text,
  position_x int DEFAULT 0,      -- showroom grid position
  position_y int DEFAULT 0,
  is_featured bool DEFAULT false,
  views_count int DEFAULT 0,
  added_at timestamptz DEFAULT now()
);

-- 4. Spatial Events (virtual exhibitions, conferences, launches)
CREATE TABLE IF NOT EXISTS spatial_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid REFERENCES spatial_spaces(id) ON DELETE SET NULL,
  organizer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  event_type text DEFAULT 'exhibition',  -- exhibition, conference, launch, meetup, concert
  cover_url text,
  start_at timestamptz,
  end_at timestamptz,
  max_attendees int DEFAULT 100,
  attendees_count int DEFAULT 0,
  ticket_price numeric DEFAULT 0,
  status text DEFAULT 'upcoming',        -- upcoming, live, ended, cancelled
  stream_url text,
  xr_mode bool DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- 5. Spatial Event Attendees
CREATE TABLE IF NOT EXISTS spatial_event_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES spatial_events(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz DEFAULT now(),
  UNIQUE(event_id, user_id)
);

-- 6. Space Visits (analytics)
CREATE TABLE IF NOT EXISTS spatial_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid REFERENCES spatial_spaces(id) ON DELETE CASCADE,
  visitor_id uuid,                -- nullable (guest visits)
  visited_at timestamptz DEFAULT now()
);

-- 7. Avatar Interactions (wave, follow, react)
CREATE TABLE IF NOT EXISTS spatial_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user uuid REFERENCES users(id) ON DELETE CASCADE,
  to_user uuid REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,             -- wave, follow, react, gift
  emoji text DEFAULT '👋',
  message text,
  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_spatial_spaces_owner ON spatial_spaces(owner_id);
CREATE INDEX IF NOT EXISTS idx_spatial_spaces_type ON spatial_spaces(type);
CREATE INDEX IF NOT EXISTS idx_spatial_spaces_featured ON spatial_spaces(is_featured);
CREATE INDEX IF NOT EXISTS idx_spatial_space_products_space ON spatial_space_products(space_id);
CREATE INDEX IF NOT EXISTS idx_spatial_events_status ON spatial_events(status);
CREATE INDEX IF NOT EXISTS idx_spatial_events_organizer ON spatial_events(organizer_id);
CREATE INDEX IF NOT EXISTS idx_spatial_visits_space ON spatial_visits(space_id);
CREATE INDEX IF NOT EXISTS idx_spatial_interactions_to ON spatial_interactions(to_user);
