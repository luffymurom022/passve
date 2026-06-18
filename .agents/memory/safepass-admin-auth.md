---
name: SafePass Admin Auth System
description: How the admin JWT auth system works — tables, middleware, setup flow, and migration requirement.
---

## Rule
Admin Dashboard uses email+password → JWT auth (not just ADMIN_SECRET header).

## How it works
- `admins` table (Supabase): id, email, password_hash, role (super_admin | moderator), created_at
- `admin_logs` table (Supabase): id, admin_id, admin_email, action, target_type, target_id, meta, created_at
- `adminAuth` middleware: accepts `Authorization: Bearer <admin_jwt>` OR legacy `x-admin-secret` header
- Admin JWT payload: `{ adminId, email, role, type: 'admin_jwt' }`, signed with JWT_SECRET, 12h expiry
- `logAdminAction(adminId, email, action, targetType, targetId, meta)` — async helper, fire-and-forget

## Setup flow
1. Run `migration.sql` in Supabase SQL Editor (creates admins + admin_logs tables)
2. POST /api/admin/auth/setup — body: { secret: ADMIN_SECRET, email, password } — creates first super_admin
3. Login at /admin.html — email + password → JWT stored in localStorage

## Key routes
- POST /api/admin/auth/setup — first super_admin (requires ADMIN_SECRET in body)
- POST /api/admin/auth/login — email+password → { token, email, role }
- POST /api/admin/auth/create — super_admin creates more admins (requires adminAuth JWT)
- GET /api/admin/me — current admin info
- GET /api/admin/admins — list admins (super_admin only)
- DELETE /api/admin/admins/:id — remove admin
- GET /api/admin/logs — audit log (filter by action)
- GET /api/admin/disputes — disputed orders queue
- GET/POST /api/admin/orders/:id/messages — admin reads/sends into order chat

**Why:** Legacy ADMIN_SECRET header is kept for backward compatibility with existing routes; new routes use adminAuth middleware which handles both.

**How to apply:** All new admin-only routes should use `adminAuth` middleware, not raw `adminSecret()` check.
