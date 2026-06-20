-- ══════════════════════════════════════════════════════════
-- SAFEPASS FREELANCE — Migration SQL
-- Chạy file này trong Supabase SQL Editor
-- ══════════════════════════════════════════════════════════

-- 1. Freelancer Profiles (extended user profile)
CREATE TABLE IF NOT EXISTS fl_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  display_name TEXT,
  tagline TEXT,
  bio TEXT,
  skills TEXT[] DEFAULT '{}',
  category TEXT DEFAULT 'code',
  experience_years INT DEFAULT 0,
  country TEXT DEFAULT 'Vietnam',
  language TEXT DEFAULT 'Vietnamese',
  hourly_rate BIGINT DEFAULT 0,
  avatar_url TEXT,
  portfolio_url TEXT,
  is_available BOOLEAN DEFAULT TRUE,
  total_projects INT DEFAULT 0,
  completion_rate NUMERIC(5,2) DEFAULT 100,
  avg_rating NUMERIC(3,2) DEFAULT 0,
  review_count INT DEFAULT 0,
  total_earned BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE fl_profiles DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fl_profiles_user ON fl_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_fl_profiles_category ON fl_profiles(category);
CREATE INDEX IF NOT EXISTS idx_fl_profiles_rating ON fl_profiles(avg_rating DESC);

-- 2. Gigs (Freelancer service listings)
CREATE TABLE IF NOT EXISTS fl_gigs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  seller_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  subcategory TEXT,
  price BIGINT NOT NULL,
  delivery_days INT DEFAULT 3,
  revisions INT DEFAULT 1,
  image_url TEXT,
  images TEXT[] DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'active', -- active | paused | deleted
  order_count INT DEFAULT 0,
  view_count INT DEFAULT 0,
  avg_rating NUMERIC(3,2) DEFAULT 0,
  review_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE fl_gigs DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fl_gigs_seller ON fl_gigs(seller_id);
CREATE INDEX IF NOT EXISTS idx_fl_gigs_category ON fl_gigs(category, status);
CREATE INDEX IF NOT EXISTS idx_fl_gigs_rating ON fl_gigs(avg_rating DESC);

-- 3. Job Postings (Client posts jobs)
CREATE TABLE IF NOT EXISTS fl_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  skills_required TEXT[] DEFAULT '{}',
  budget_min BIGINT DEFAULT 0,
  budget_max BIGINT DEFAULT 0,
  budget_type TEXT DEFAULT 'fixed', -- fixed | hourly
  deadline DATE,
  status TEXT DEFAULT 'open', -- open | in_progress | completed | cancelled
  proposal_count INT DEFAULT 0,
  view_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE fl_jobs DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fl_jobs_client ON fl_jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_fl_jobs_category ON fl_jobs(category, status);
CREATE INDEX IF NOT EXISTS idx_fl_jobs_created ON fl_jobs(created_at DESC);

-- 4. Proposals (Freelancer proposes to a job)
CREATE TABLE IF NOT EXISTS fl_proposals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES fl_jobs(id) ON DELETE CASCADE,
  freelancer_id UUID REFERENCES users(id) ON DELETE CASCADE,
  price BIGINT NOT NULL,
  delivery_days INT NOT NULL,
  cover_letter TEXT,
  status TEXT DEFAULT 'pending', -- pending | accepted | rejected | withdrawn
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE fl_proposals DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fl_proposals_job ON fl_proposals(job_id);
CREATE INDEX IF NOT EXISTS idx_fl_proposals_freelancer ON fl_proposals(freelancer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fl_proposals_unique ON fl_proposals(job_id, freelancer_id);

-- 5. Contracts (Created when proposal accepted OR gig ordered)
CREATE TABLE IF NOT EXISTS fl_contracts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  gig_id UUID REFERENCES fl_gigs(id) ON DELETE SET NULL,
  job_id UUID REFERENCES fl_jobs(id) ON DELETE SET NULL,
  proposal_id UUID REFERENCES fl_proposals(id) ON DELETE SET NULL,
  client_id UUID REFERENCES users(id) ON DELETE CASCADE,
  freelancer_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  total_amount BIGINT NOT NULL,
  escrow_amount BIGINT NOT NULL,
  platform_fee BIGINT DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending | active | submitted | revision | completed | disputed | cancelled
  deadline DATE,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE fl_contracts DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fl_contracts_client ON fl_contracts(client_id);
CREATE INDEX IF NOT EXISTS idx_fl_contracts_freelancer ON fl_contracts(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_fl_contracts_status ON fl_contracts(status);

-- 6. Milestones
CREATE TABLE IF NOT EXISTS fl_milestones (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID REFERENCES fl_contracts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  amount BIGINT NOT NULL,
  due_date DATE,
  order_index INT DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending | in_progress | submitted | approved | rejected
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE fl_milestones DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fl_milestones_contract ON fl_milestones(contract_id, order_index);

-- 7. Contract Files (uploaded in workspace)
CREATE TABLE IF NOT EXISTS fl_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID REFERENCES fl_contracts(id) ON DELETE CASCADE,
  uploader_id UUID REFERENCES users(id) ON DELETE SET NULL,
  uploader_name TEXT,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size BIGINT,
  milestone_id UUID REFERENCES fl_milestones(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE fl_files DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fl_files_contract ON fl_files(contract_id, created_at DESC);

-- 8. Contract Messages (workspace chat)
CREATE TABLE IF NOT EXISTS fl_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID REFERENCES fl_contracts(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sender_name TEXT,
  text TEXT,
  is_system BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE fl_messages DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fl_messages_contract ON fl_messages(contract_id, created_at ASC);

-- 9. Activity Logs (workspace timeline)
CREATE TABLE IF NOT EXISTS fl_activities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID REFERENCES fl_contracts(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE fl_activities DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fl_activities_contract ON fl_activities(contract_id, created_at ASC);

-- 10. Freelance Reviews
CREATE TABLE IF NOT EXISTS fl_reviews (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID REFERENCES fl_contracts(id) ON DELETE CASCADE UNIQUE,
  gig_id UUID REFERENCES fl_gigs(id) ON DELETE SET NULL,
  reviewer_id UUID REFERENCES users(id) ON DELETE CASCADE,
  reviewee_id UUID REFERENCES users(id) ON DELETE CASCADE,
  rating INT CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE fl_reviews DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_fl_reviews_reviewee ON fl_reviews(reviewee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fl_reviews_gig ON fl_reviews(gig_id);
