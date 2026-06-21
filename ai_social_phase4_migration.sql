-- ═══════════════════════════════════════════════════════
-- SAFEPASS PHASE 4 — AI SOCIAL GRAPH & RECOMMENDATION ENGINE
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════

-- Module 1: Social Graph — Follow relationships
CREATE TABLE IF NOT EXISTS user_follows (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  follower_id uuid REFERENCES users(id) ON DELETE CASCADE,
  following_id uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(follower_id, following_id)
);
CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_following ON user_follows(following_id);

-- Module 1: Interaction tracking (all engagement signals)
CREATE TABLE IF NOT EXISTS user_interactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  interaction_type text NOT NULL,
  -- Types: like, comment, share, save, purchase, view, watch, reel_view,
  --        reel_complete, reel_replay, message, group_join, live_watch, search
  target_type text NOT NULL,
  -- Targets: post, reel, product, user, group, live, seller
  target_id text NOT NULL,
  metadata jsonb DEFAULT '{}',
  -- e.g. { watch_seconds: 45, completion_pct: 80, category: 'music', tags: ['kpop'] }
  weight numeric DEFAULT 1.0,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_interactions_user ON user_interactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_interactions_target ON user_interactions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_user_interactions_type ON user_interactions(interaction_type);

-- Module 11: User preference profiles (auto-updated by interaction events)
CREATE TABLE IF NOT EXISTS user_preference_profiles (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  categories jsonb DEFAULT '{}',
  -- { "music": 85, "gaming": 60, "sports": 40, "fashion": 20 }
  tags jsonb DEFAULT '{}',
  -- { "kpop": 95, "concert": 80, "vip": 50 }
  preferred_sellers jsonb DEFAULT '[]',
  preferred_groups jsonb DEFAULT '[]',
  watch_history jsonb DEFAULT '[]',
  interaction_summary jsonb DEFAULT '{}',
  -- { total_likes: 120, total_watches: 300, avg_watch_pct: 72 }
  updated_at timestamptz DEFAULT now()
);

-- Module 9: Trending tracker
CREATE TABLE IF NOT EXISTS trending_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  item_type text NOT NULL,
  -- post, reel, product, group, live, topic, seller
  item_id text NOT NULL,
  title text,
  score numeric DEFAULT 0,
  interaction_count int DEFAULT 0,
  period text DEFAULT '24h',
  -- 1h, 6h, 24h, 7d
  metadata jsonb DEFAULT '{}',
  computed_at timestamptz DEFAULT now(),
  UNIQUE(item_type, item_id, period)
);
CREATE INDEX IF NOT EXISTS idx_trending_type_period ON trending_items(item_type, period, score DESC);

-- AI feed cache (scored personalized feed per user)
CREATE TABLE IF NOT EXISTS ai_feed_cache (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  feed_type text NOT NULL,
  -- posts, reels, products, sellers, groups, friends, lives
  items jsonb DEFAULT '[]',
  computed_at timestamptz DEFAULT now(),
  UNIQUE(user_id, feed_type)
);

-- Social graph edge scores (relationship strength)
CREATE TABLE IF NOT EXISTS social_graph_edges (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_a uuid REFERENCES users(id) ON DELETE CASCADE,
  user_b uuid REFERENCES users(id) ON DELETE CASCADE,
  strength numeric DEFAULT 0,
  -- computed from interactions, mutual follows, messages
  mutual_follows boolean DEFAULT false,
  common_groups int DEFAULT 0,
  interaction_count int DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_a, user_b)
);

-- AI admin metrics log
CREATE TABLE IF NOT EXISTS ai_analytics_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  metric_type text NOT NULL,
  metric_data jsonb DEFAULT '{}',
  period text DEFAULT '24h',
  computed_at timestamptz DEFAULT now()
);
