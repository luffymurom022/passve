-- Phase 19: SafePass Live Commerce Migration

-- Live Streams
CREATE TABLE IF NOT EXISTS live_streams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  thumbnail_url TEXT,
  stream_key TEXT UNIQUE DEFAULT gen_random_uuid()::TEXT,
  status TEXT DEFAULT 'live' CHECK (status IN ('scheduled','live','ended','banned')),
  enable_auction BOOLEAN DEFAULT FALSE,
  enable_recording BOOLEAN DEFAULT TRUE,
  enable_gifts BOOLEAN DEFAULT TRUE,
  follow_only BOOLEAN DEFAULT FALSE,
  viewers_count INT DEFAULT 0,
  peak_viewers INT DEFAULT 0,
  total_likes BIGINT DEFAULT 0,
  total_gifts_value BIGINT DEFAULT 0,
  total_sales INT DEFAULT 0,
  total_revenue BIGINT DEFAULT 0,
  recording_url TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live Stream Products
CREATE TABLE IF NOT EXISTS live_stream_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  price BIGINT NOT NULL,
  original_price BIGINT,
  emoji TEXT DEFAULT '📦',
  stock_count INT DEFAULT 1,
  sold_count INT DEFAULT 0,
  is_featured BOOLEAN DEFAULT FALSE,
  is_auction BOOLEAN DEFAULT FALSE,
  display_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live Auctions
CREATE TABLE IF NOT EXISTS live_auctions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  product_id UUID REFERENCES live_stream_products(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  starting_price BIGINT NOT NULL DEFAULT 0,
  current_price BIGINT NOT NULL DEFAULT 0,
  min_increment BIGINT DEFAULT 10000,
  leader_id UUID REFERENCES users(id) ON DELETE SET NULL,
  leader_name TEXT,
  total_bids INT DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('pending','active','ended','cancelled')),
  ends_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  winner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  final_price BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auction Bids
CREATE TABLE IF NOT EXISTS live_auction_bids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES live_auctions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live Chat Messages
CREATE TABLE IF NOT EXISTS live_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'message' CHECK (type IN ('message','gift','system','join','bid','pin')),
  is_pinned BOOLEAN DEFAULT FALSE,
  pinned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live Gifts
CREATE TABLE IF NOT EXISTS live_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gift_type TEXT NOT NULL,
  gift_emoji TEXT,
  gift_name TEXT,
  amount BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live Orders (buy during stream)
CREATE TABLE IF NOT EXISTS live_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  product_id UUID REFERENCES live_stream_products(id) ON DELETE SET NULL,
  buyer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  price BIGINT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','escrow','completed','cancelled','refunded')),
  escrow_order_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live Stream Reports
CREATE TABLE IF NOT EXISTS live_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','reviewed','dismissed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_live_streams_user ON live_streams(user_id);
CREATE INDEX IF NOT EXISTS idx_live_streams_status ON live_streams(status);
CREATE INDEX IF NOT EXISTS idx_live_streams_created ON live_streams(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_streams_viewers ON live_streams(viewers_count DESC);
CREATE INDEX IF NOT EXISTS idx_live_products_stream ON live_stream_products(stream_id);
CREATE INDEX IF NOT EXISTS idx_live_auctions_stream ON live_auctions(stream_id);
CREATE INDEX IF NOT EXISTS idx_live_bids_auction ON live_auction_bids(auction_id);
CREATE INDEX IF NOT EXISTS idx_live_chat_stream ON live_chat_messages(stream_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_gifts_stream ON live_gifts(stream_id);
