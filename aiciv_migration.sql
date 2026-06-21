-- ═══════════════════════════════════════
-- PHASE 16: AI CIVILIZATION ENGINE
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════

-- AI Governors
CREATE TABLE IF NOT EXISTS ai_governors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  avatar TEXT DEFAULT '🤖',
  personality TEXT DEFAULT 'friendly',
  world_id UUID,
  universe_id UUID,
  status TEXT DEFAULT 'active',
  messages_sent INT DEFAULT 0,
  decisions_made INT DEFAULT 0,
  users_welcomed INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Mayors
CREATE TABLE IF NOT EXISTS ai_mayors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  avatar TEXT DEFAULT '🏛️',
  city_name TEXT NOT NULL,
  world_id UUID,
  announcements_count INT DEFAULT 0,
  events_managed INT DEFAULT 0,
  engagement_score FLOAT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI NPCs
CREATE TABLE IF NOT EXISTS ai_npcs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  avatar TEXT DEFAULT '🧙',
  role TEXT NOT NULL,
  world_id UUID,
  personality TEXT DEFAULT 'helpful',
  conversations INT DEFAULT 0,
  recommendations_given INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Quests
CREATE TABLE IF NOT EXISTS ai_quests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  type TEXT DEFAULT 'mission',
  difficulty TEXT DEFAULT 'easy',
  reward_coins INT DEFAULT 100,
  world_id UUID,
  completions INT DEFAULT 0,
  participants INT DEFAULT 0,
  status TEXT DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Generated Events
CREATE TABLE IF NOT EXISTS ai_generated_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  event_type TEXT DEFAULT 'community',
  world_id UUID,
  participants INT DEFAULT 0,
  status TEXT DEFAULT 'upcoming',
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by_ai TEXT DEFAULT 'event_generator',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Knowledge Base
CREATE TABLE IF NOT EXISTS ai_knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id UUID,
  title TEXT NOT NULL,
  content TEXT,
  category TEXT DEFAULT 'history',
  auto_generated BOOLEAN DEFAULT TRUE,
  views INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Agents Marketplace
CREATE TABLE IF NOT EXISTS ai_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID,
  name TEXT NOT NULL,
  avatar TEXT DEFAULT '🤖',
  role TEXT NOT NULL,
  description TEXT,
  capabilities JSONB DEFAULT '[]',
  price_coins INT DEFAULT 0,
  rating FLOAT DEFAULT 5.0,
  deployments INT DEFAULT 0,
  is_marketplace BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Agent Deployments
CREATE TABLE IF NOT EXISTS ai_agent_deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES ai_agents(id) ON DELETE CASCADE,
  user_id UUID,
  world_id UUID,
  status TEXT DEFAULT 'active',
  deployed_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Moderation Logs
CREATE TABLE IF NOT EXISTS ai_moderation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type TEXT,
  target_id UUID,
  action TEXT,
  reason TEXT,
  confidence FLOAT DEFAULT 0.9,
  reviewed_by_human BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── SEED DATA ──

-- Governors
INSERT INTO ai_governors (name, avatar, personality, status, messages_sent, decisions_made, users_welcomed) VALUES
  ('Governor Atlas', '🌌', 'wise', 'active', 12847, 3241, 8920),
  ('Governor Nova', '⭐', 'friendly', 'active', 9234, 2187, 6310),
  ('Governor Orion', '🔭', 'strategic', 'active', 7821, 1923, 4891),
  ('Governor Aurora', '🌅', 'nurturing', 'active', 15023, 4012, 11234)
ON CONFLICT DO NOTHING;

-- Mayors
INSERT INTO ai_mayors (name, avatar, city_name, announcements_count, events_managed, engagement_score) VALUES
  ('Mayor Crest', '🏛️', 'Capital City Alpha', 234, 89, 94.2),
  ('Mayor Dawn', '🌇', 'New Commerce Hub', 187, 67, 91.8),
  ('Mayor Vox', '📢', 'Social District 7', 312, 124, 96.5),
  ('Mayor Terra', '🌱', 'Green Valley', 156, 45, 88.3)
ON CONFLICT DO NOTHING;

-- NPCs
INSERT INTO ai_npcs (name, avatar, role, personality, conversations, recommendations_given) VALUES
  ('Sage Lumis', '🧙', 'World Guide', 'wise', 45821, 23410),
  ('Trader Kira', '🛒', 'Market Assistant', 'helpful', 32014, 18920),
  ('Guard Rex', '⚔️', 'Security NPC', 'stern', 8234, 2341),
  ('Healer Mira', '💊', 'Support NPC', 'caring', 21034, 15820),
  ('Explorer Jin', '🗺️', 'Discovery NPC', 'adventurous', 18923, 12034)
ON CONFLICT DO NOTHING;

-- Quests
INSERT INTO ai_quests (title, description, type, difficulty, reward_coins, completions, participants, status) VALUES
  ('First Steps', 'Complete your profile and join a community', 'mission', 'easy', 50, 8234, 9120, 'active'),
  ('Market Master', 'Complete 10 successful trades in the marketplace', 'challenge', 'medium', 200, 3421, 4012, 'active'),
  ('Community Builder', 'Invite 5 friends to your world', 'mission', 'easy', 100, 5123, 5891, 'active'),
  ('Grand Festival', 'Participate in the Universe Festival', 'festival', 'hard', 500, 1234, 2341, 'active'),
  ('Knowledge Seeker', 'Read 20 articles in the knowledge base', 'mission', 'medium', 150, 2891, 3120, 'active'),
  ('Economy Champion', 'Generate 1,000,000₫ in sales', 'challenge', 'hard', 1000, 423, 891, 'active')
ON CONFLICT DO NOTHING;

-- Generated Events
INSERT INTO ai_generated_events (title, description, event_type, participants, status) VALUES
  ('Universe Grand Festival 2026', 'Annual celebration across all universes', 'festival', 45234, 'upcoming'),
  ('AI Economy Summit', 'AI-powered market analysis and predictions', 'competition', 12034, 'active'),
  ('Creator Championship', 'Best creator content competition', 'competition', 8921, 'upcoming'),
  ('Community Builders Cup', 'Who can grow the largest community?', 'challenge', 23410, 'active'),
  ('Trade Wars Season 3', 'Cross-universe trading competition', 'competition', 34120, 'upcoming')
ON CONFLICT DO NOTHING;

-- Knowledge Base
INSERT INTO ai_knowledge_base (title, content, category, views) VALUES
  ('SafePass Universe History', 'SafePass Universe was founded in 2024 as the first AI-powered civilization platform in Vietnam...', 'history', 45231),
  ('Economy Guide 2026', 'Complete guide to trading, escrow, and earning in the SafePass ecosystem...', 'economy', 32014),
  ('Community Standards', 'Guidelines for respectful interaction and community building across all worlds...', 'governance', 28934),
  ('Creator Handbook', 'Everything creators need to know about growing their audience and monetizing content...', 'creator', 19234),
  ('World Building Manual', 'Step-by-step guide to creating and managing your own world...', 'world', 15823)
ON CONFLICT DO NOTHING;

-- AI Agents
INSERT INTO ai_agents (name, avatar, role, description, price_coins, rating, deployments, is_marketplace) VALUES
  ('ShopBot Pro', '🛒', 'Shop Assistant', 'AI-powered shopping assistant that helps customers find products and close sales', 500, 4.8, 2341, TRUE),
  ('CommunityMind', '🌐', 'Community Manager', 'Monitors discussions, engages members, and grows community health', 800, 4.9, 1823, TRUE),
  ('EventHost AI', '🎉', 'Event Host', 'Creates and manages community events automatically', 600, 4.7, 1234, TRUE),
  ('LearnBot', '📚', 'Learning Assistant', 'Personalizes learning paths and tracks progress for users', 400, 4.6, 3421, TRUE),
  ('TrustGuard', '🛡️', 'Moderation Agent', 'Detects spam, abuse, and suspicious behavior in real-time', 1000, 4.9, 892, TRUE)
ON CONFLICT DO NOTHING;
