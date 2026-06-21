---
name: SafePass Performance Optimization Pass
description: TTL cache system, N+1 fixes, compression, lazy loading, DB indexes — what was done and how to extend.
---

# SafePass Performance Optimization Pass

## What was built

### TTL Cache (server.js)
`TtlCache` class added near top of server.js (after imports/middleware). Single global instance `ttlCache`.
- `.get(key)` — returns null if expired
- `.set(key, val, ttlMs)` — stores with expiry
- `.del(key)` — removes one key
- `.delPrefix(prefix)` — removes all keys starting with prefix
- Auto-purge setInterval runs every 2 minutes

### Cache keys in use
| Key pattern | TTL | Invalidated by |
|-------------|-----|---------------|
| `prefs:{userId}` | 60s | updatePreferenceProfile() |
| `ai_feed:{userId}` | 30s | updatePreferenceProfile() |
| `ai_reels:{userId}:{feed_type}` | 30s | updatePreferenceProfile() (delPrefix) |
| `ai_rec_products:{userId}` | 60s | — (natural expiry) |
| `notifs:{userId}` | 15s | /notifications/read-all, /notifications/:id/read |
| `dm_convs:{userId}` | 10s | POST /dm/messages → all participants |
| `worlds:stats` | 5 min | — |
| `worlds:leaderboard` | 2 min | — |
| `social_reels:{hashtag}:{page}:{lim}` | 30s | — |
| `avatar_items:{cat}:{featured}:{page}:{lim}` | 2 min | — |

### N+1 fixes
- `/api/social/reels` — was 4 queries per reel (user/profile/products/followers); now 4 batch queries total
- `/api/dm/conversations` — was 3 queries per conversation; now 5 batch queries total

### Compression
`compression` package added to imports and middleware (`app.use(compression({ level: 6, threshold: 1024 }))`).

### Static file caching
`express.static` now has `maxAge: '1d'`, ETag, lastModified. HTML files get `no-cache`.

### Frontend
- index.html: `media="print" onload` font loading trick, DNS prefetch hints
- index.html: Intersection Observer for `img[data-src]` lazy loading + MutationObserver for dynamic DOM
- index.html: `window.attachInfiniteScroll(el, fnName)` utility for infinite scroll
- index.html: `requestIdleCallback` idle prefetch for page 2 tickets
- reels.html: Intersection Observer for `img[data-src]` and `video[data-src]`

### Database indexes
File: `performance_indexes.sql` — 30+ CONCURRENTLY indexes.
**Must be run in Supabase SQL Editor.**
Key indexes: tickets(status, created_at), sn_posts(status, created_at), social_videos(status, likes_count, created_at), order_messages(order_id, created_at), notifications(user_id) partial WHERE is_read=NULL.

**Why:** Feed was fetching limit(100) then scoring in-memory with no cache; reels had N+1 per item; DM conversations had N+1 per conversation. All these caused 2-5s load times.

**How to apply:** When adding new expensive list endpoints, check if they're called frequently. If so, add a `ttlCache.get/set` wrapper with a sensible TTL (15s for user-specific mutable data, 2-5 min for public/catalog data). Always add a cache invalidation call in the corresponding write endpoint.
