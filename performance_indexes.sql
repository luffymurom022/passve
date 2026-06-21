-- ═══════════════════════════════════════════════════════
-- SAFEPASS PERFORMANCE INDEXES
-- Run this in Supabase SQL Editor to speed up queries
-- ═══════════════════════════════════════════════════════

-- ── TICKETS / LISTINGS (marketplace browse) ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_status_created
  ON tickets(status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_seller_id
  ON tickets(seller_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_category_status
  ON tickets(category, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_status_created
  ON listings(status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_seller_id
  ON listings(seller_id);

-- ── ORDERS ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_buyer_id
  ON orders(buyer_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_seller_id
  ON orders(seller_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status
  ON orders(status);

-- ── ORDER MESSAGES (messenger) ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_messages_order_id_created
  ON order_messages(order_id, created_at ASC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_messages_unread
  ON order_messages(order_id, sender_id, read_at)
  WHERE read_at IS NULL;

-- ── NOTIFICATIONS ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);

-- ── SOCIAL POSTS ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sn_posts_user_created
  ON sn_posts(user_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sn_posts_status_created
  ON sn_posts(status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sn_posts_likes_count
  ON sn_posts(likes_count DESC, created_at DESC);

-- ── SOCIAL VIDEOS (reels) ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_social_videos_status_likes
  ON social_videos(status, likes_count DESC, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_social_videos_user_id
  ON social_videos(user_id);

-- ── SOCIAL FOLLOWS ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_social_follows_follower
  ON social_follows(follower_id, following_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_social_follows_following
  ON social_follows(following_id);

-- ── USER FOLLOWS (AI graph) ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_follows_follower
  ON user_follows(follower_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_follows_following
  ON user_follows(following_id);

-- ── USER PREFERENCES ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_preference_user_id
  ON user_preference_profiles(user_id);

-- ── USERS ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_phone
  ON users(phone);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_is_verified
  ON users(is_verified) WHERE is_verified = true;

-- ── REVIEWS ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_seller_id
  ON reviews(seller_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_buyer_id
  ON reviews(buyer_id);

-- ── WORLDS / UNIVERSE ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vw_world_members_world_id
  ON vw_world_members(world_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vw_world_posts_world_created
  ON vw_world_posts(world_id, created_at DESC);

-- ── SOCIAL VIDEO PRODUCTS ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_social_video_products_video_id
  ON social_video_products(video_id);

-- ── SN PROFILES ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sn_profiles_user_id
  ON sn_profiles(user_id);

-- ── AVATARS ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_xr_avatars_user_id
  ON xr_avatars(user_id);

-- Done. These indexes will make feed, reels, messenger, and world
-- queries significantly faster. Monitor with pg_stat_user_indexes.
