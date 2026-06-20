---
name: SafePass Ecosystem Phase 16
description: Phase 16 Ecosystem — unified dashboard aggregating all modules, no new SQL migration needed
---

# Phase 16: SafePass Ecosystem

**Why:** Connects all existing modules (Phases 1-15) into a single unified interface — aggregated dashboard, smart workflow tracker, global search, notification center, user/business command centers, analytics, and admin ecosystem view.

## Key design decisions
- **No new SQL tables** — Phase 16 only aggregates existing tables across all modules
- Uses `sp_token` (localStorage) same as main app for auth
- Auth check: `GET /api/users/me` (new endpoint added in Phase 16)
- If not logged in → shows auth screen with link back to SafePass login

## New API routes (server.js before PHASE 15 block)
- `GET /ecosystem` — serve frontend/ecosystem.html
- `GET /api/users/me` — user profile for ecosystem
- `GET /api/ecosystem/dashboard` — parallel queries across all modules for current user
- `GET /api/ecosystem/workflow/orders` — user's orders for workflow tracker
- `GET /api/ecosystem/workflow/:id` — single order workflow step states
- `GET /api/ecosystem/search?q=&type=` — cross-module search (listings/orders/users/logistics)
- `GET /api/ecosystem/user-stats` — trust score, badges, per-module counts
- `GET /api/ecosystem/biz-summary` — business command center aggregate
- `GET /api/ecosystem/analytics?period=6m|12m` — ecosystem analytics with monthly breakdown
- `GET /api/admin/ecosystem/stats` — admin: all module counts + charts data

## Frontend (frontend/ecosystem.html at /ecosystem)
8 pages via sidebar nav:
1. **Unified Dashboard** — quick actions (8 links), stat grid, module cards, activity feed, 2 charts
2. **Smart Workflow** — 6-step visual pipeline, select order to see step states
3. **Global Search** — debounce 500ms, highlight keywords, 4 search categories
4. **Notification Center** — reuses /api/notifications; filter by type; mark all read
5. **User Command Center** — profile, security, trust score, stats, linked services
6. **Business Command Center** — 6 module cards + revenue chart + quick action links
7. **Ecosystem Analytics** — 4 charts (line/doughnut/bar), period toggle 6m/12m
8. **Admin Ecosystem Center** — only shown to is_admin users; 8 mini module cards, 2 charts, recent users + disputes tables

## Smart Workflow step mapping (from orders table status)
- listing: always 'done' (order exists = was listed)
- escrow: 'done' if funded/delivered/completed/released, 'active' if pending
- inspection/warehouse: 'done' if funded_at set
- delivery: 'done' if delivered/completed/released, 'active' if funded_at set
- completed: 'done' if status is completed or released

**How to apply:** No SQL migration needed. Just navigate to /ecosystem after logging in to SafePass.
