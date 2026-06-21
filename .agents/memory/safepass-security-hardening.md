---
name: SafePass Security Hardening
description: JWT blacklist, brute force protection, rate limiting, content filter, escrow fraud detection, session tracking, admin security dashboard
---

## Key architecture

**In-memory data structures (server.js top)**
- `jwtBlacklistSet` — Set of token SHA-256 hashes; checked in `auth` middleware BEFORE jwt.verify
- `loginFailures` — Map `phone|ip → {count, lockedUntil}`; max 5 failures → 15min lock
- `_rlKey(req)` — rate limit key helper: `req.user?.id || x-forwarded-for || 'anon'` (NOT req.ip — causes IPv6 validation error in express-rate-limit)

**DB tables (security_hardening.sql)**
- `security_sessions` — per-login record with token_hash, device_fp, IP, expires_at
- `security_events` — audit trail (failed_login, spam_blocked, escrow_fraud_flag, etc.)
- `jwt_blacklist` — token hashes for revoked tokens; DB-backed for restart persistence
- `login_attempts` — persistent log of all login tries
- `content_flags` — auto-flagged content with preview, type, status
- `escrow_fraud_flags` — escrow fraud indicators with risk_level
- `user_devices` — known devices per user (upserted on login)
- `wallet_daily_guards` — not yet used programmatically, tracking is via withdrawal_requests count

**Business rules**
- New account (< 24h) cannot buy > 5M VND via escrow
- New account (< 72h) cannot withdraw > 5M VND
- Max 3 withdrawals per day (counts via withdrawal_requests table)
- Max 30 messages/min, 10 listings/hr, 20 pay transfers/hr, 5 registrations/hr

**Content filter (contentFilter() function)**
- Blocks: external URLs (http://, bit.ly, t.me, zalo.me), multiple phone numbers, 10+ repeat chars, forbidden words
- Applied to: order messages, DM messages, sn/posts
- On block: calls autoFlagContent() → content_flags table

**Admin security dashboard**
- URL: /admin/security (requires admin JWT login)
- Tabs: Security Events, Content Flags, Sessions, Escrow Fraud, Login Attempts
- Key actions: revoke session (adds to jwt_blacklist), force-logout-user, mark escrow reviewed, resolve content flags

**Why validate: false on rate limiters**
- express-rate-limit throws ERR_ERL_KEY_GEN_IPV6 ValidationError if keyGenerator uses req.ip
- Fix: use `x-forwarded-for` header + `validate: false` on all custom-keyGenerator limiters

**Startup**
- `loadJwtBlacklist()` called in httpServer listen callback — loads active blacklist from DB
- Blacklist purged every 6h (deletes expired rows, reloads from DB)
