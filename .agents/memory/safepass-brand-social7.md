---
name: SafePass Brand Social 7
description: Phase Social 7 — Business & Brand Ecosystem; brand_social7_migration.sql tables, /brand page, API routes pattern.
---

# SafePass Brand Social 7

## Migration Required
Run `brand_social7_migration.sql` in Supabase SQL Editor before using.

## New Tables (10)
- `brand_posts` — Facebook-style posts on brand pages (type: post/promo/event/announcement/product)
- `brand_post_likes` — likes (unique per user/post)
- `brand_post_comments` — comments
- `brand_campaigns` — flash_sale/promo/coupon/event campaigns with coupon_code, uses_count/max_uses
- `brand_campaign_uses` — tracks which user used which campaign
- `brand_collaborations` — influencer collab programs (affiliate/sponsored/gifted/ambassador/event)
- `brand_collab_applications` — creator applications to collabs
- `business_inbox` — customer → brand messages with auto-reply support
- `business_auto_replies` — keyword-triggered auto-reply rules
- `brand_follows` — user follows brand (updates followers_count on business_accounts)

## Columns Added to business_accounts
`followers_count`, `posts_count`, `trust_score`, `cover_image_url`, `category`, `tags`

## Pages
- `/brand` → `frontend/brand.html` (requires businessToken in localStorage)
- `/brand/:slug` → same file, shows public brand page if no bizToken

## Auth Pattern
- Uses `businessToken` from localStorage (same as business.html)
- `apiBiz()` helper sends `Authorization: Bearer businessToken`
- `apiAuth()` helper uses regular user `token` for creator-side actions

## Trust Score Computation (`GET /api/brand/:slug/trust`)
- Rating: 0–30 pts (avg_rating / 5 * 30)
- Orders: 0–25 pts (min(25, total_orders/10))
- Verification: 25 pts if is_verified_business
- Badge: diamond=20, platinum=16, gold=12, silver=8, bronze=4, trusted=6, verified=10

## Key API Routes
- `POST /api/brand/posts` — create post (businessAuth)
- `GET /api/brand/:slug/posts` — public posts for a brand
- `GET /api/brand/my-posts` — own posts (businessAuth)
- `POST/GET/DELETE /api/brand/campaigns` — campaign CRUD
- `GET /api/brand/campaigns/public/:slug` — public active campaigns
- `POST /api/brand/campaigns/:id/use` — redeem coupon (auth)
- `POST/GET /api/brand/collaborations` — collab CRUD
- `GET /api/brand/collaborations/open` — public open collabs for creators
- `POST /api/brand/collaborations/:id/apply` — creator applies (auth)
- `GET /api/brand/inbox` — business inbox (businessAuth)
- `POST /api/brand/inbox/:slug` — customer sends message (auth) with auto-reply
- `POST /api/brand/inbox/:id/reply` — business replies
- `POST/GET/PATCH/DELETE /api/brand/auto-replies` — auto-reply rules
- `POST /api/brand/follow/:slug` — toggle follow (auth)
- `GET /api/brand/discover` — brand discovery feed
- `GET /api/brand/:slug/trust` — compute & return trust score
- `GET /api/brand/:slug/page` — full public brand page data
- `GET /api/admin/brand/posts` — admin view posts
- `GET /api/admin/brand/overview` — admin stats

**Why:** Routes inserted in server.js before Freelance section (after line ~5941).
