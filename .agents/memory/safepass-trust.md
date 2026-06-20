---
name: SafePass Trust Center Phase 9
description: Trust Network system — tables, routes, frontend, and migration requirements.
---

# SafePass Phase 9 — Trust Center

## Migration required
Run `trust_migration.sql` in Supabase SQL Editor before any trust features work.
Tables created: `trust_scores`, `verification_documents`, `reputation_history`.
Trigger `trg_init_trust_score` auto-creates a trust_scores row for every new user.
Existing users are backfilled via INSERT...ON CONFLICT.

## API routes (all at /api/trust/*)
- GET /api/trust/me — own dashboard (recalculates score on each call)
- GET /api/trust/profile/:userId — public profile
- GET /api/trust/leaderboard?type=trust|seller|buyer
- POST /api/trust/verify/document — identity doc upload (fields: front, back; body: doc_type)
- POST /api/trust/verify/address — address doc upload (field: document)
- POST /api/trust/verify/face — face upload (fields: portrait, selfie)
- POST /api/trust/verify/email-status — sync email_verified from users table
- GET /api/admin/trust/verifications?status=pending|approved|rejected|all
- POST /api/admin/trust/verifications/:id/approve
- POST /api/admin/trust/verifications/:id/reject (body: {note})
- GET /api/admin/trust/users?level=&risk=

## Score calculation (recalculateTrustScore helper)
Starts at 100. Adds points for completed orders, completion rate, rating, account age, verifications.
Deducts for dispute rate and dispute count. Capped 0–1000.
Levels: bronze(0-199), silver(200-399), gold(400-599), platinum(600-799), diamond(800-1000).
Risk: low/medium/high based on dispute rate and score.

## Frontend
- Standalone page: frontend/trust.html served at GET /trust
- Nav entry added to index.html pages array as {id:"trust_center", icon:"🛡️", label:"Trust Center"}
- Click redirects to window.location.href='/trust'
- Page is auth-gated (redirects to / if no token)
- Tabs: Dashboard, Xác minh, Lịch sử, Bảng xếp hạng, Admin (admin-only)

**Why:** Trust Center is a standalone page (like dam.html, logistics.html) rather than an SPA page inside index.html — keeps server.js route pattern consistent and avoids making index.html even larger.
