-- ════════════════════════════════════════════════════
-- SafePass Phase 3 — SOCIAL: Groups, Reels, Messaging
-- Chạy trong Supabase SQL Editor
-- ════════════════════════════════════════════════════

-- DM Conversations
CREATE TABLE IF NOT EXISTS dm_conversations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  type text DEFAULT 'direct' CHECK (type IN ('direct','group')),
  name text,
  avatar_url text,
  created_by uuid,
  last_message text,
  last_message_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dm_participants (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id uuid REFERENCES dm_conversations(id) ON DELETE CASCADE,
  user_id uuid,
  role text DEFAULT 'member',
  joined_at timestamptz DEFAULT now(),
  last_read_at timestamptz DEFAULT now(),
  UNIQUE(conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS dm_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id uuid REFERENCES dm_conversations(id) ON DELETE CASCADE,
  sender_id uuid,
  content text,
  msg_type text DEFAULT 'text' CHECK (msg_type IN ('text','image','video','product','voice','location')),
  media_url text,
  product_id uuid,
  is_deleted boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dm_message_reactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id uuid REFERENCES dm_messages(id) ON DELETE CASCADE,
  user_id uuid,
  emoji text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(message_id, user_id)
);

-- Group Posts
CREATE TABLE IF NOT EXISTS sn_group_posts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid,
  user_id uuid,
  content text,
  media_urls text[] DEFAULT '{}',
  post_type text DEFAULT 'text',
  listing_id uuid,
  likes_count int DEFAULT 0,
  comments_count int DEFAULT 0,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sn_group_post_likes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id uuid REFERENCES sn_group_posts(id) ON DELETE CASCADE,
  user_id uuid,
  created_at timestamptz DEFAULT now(),
  UNIQUE(post_id, user_id)
);

CREATE TABLE IF NOT EXISTS sn_group_post_comments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id uuid REFERENCES sn_group_posts(id) ON DELETE CASCADE,
  user_id uuid,
  content text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sn_group_rules (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid,
  title text NOT NULL,
  description text,
  position int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sn_group_invites (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid,
  inviter_id uuid,
  invitee_id uuid,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

-- Saved/bookmarked reels
CREATE TABLE IF NOT EXISTS social_saved (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  video_id uuid,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, video_id)
);

-- Add missing columns
ALTER TABLE social_videos ADD COLUMN IF NOT EXISTS shares_count int DEFAULT 0;
ALTER TABLE social_videos ADD COLUMN IF NOT EXISTS saves_count int DEFAULT 0;
ALTER TABLE sn_groups ADD COLUMN IF NOT EXISTS posts_count int DEFAULT 0;

-- Disable RLS for new tables
ALTER TABLE dm_conversations DISABLE ROW LEVEL SECURITY;
ALTER TABLE dm_participants DISABLE ROW LEVEL SECURITY;
ALTER TABLE dm_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE dm_message_reactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE sn_group_posts DISABLE ROW LEVEL SECURITY;
ALTER TABLE sn_group_post_likes DISABLE ROW LEVEL SECURITY;
ALTER TABLE sn_group_post_comments DISABLE ROW LEVEL SECURITY;
ALTER TABLE sn_group_rules DISABLE ROW LEVEL SECURITY;
ALTER TABLE sn_group_invites DISABLE ROW LEVEL SECURITY;
ALTER TABLE social_saved DISABLE ROW LEVEL SECURITY;
