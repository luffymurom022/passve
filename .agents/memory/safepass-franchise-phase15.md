---
name: SafePass Franchise Phase 15
description: Phase 15 Franchise Network — tables, routes, frontend, migration notes
---

# Phase 15: Franchise Network

**Why:** Builds a nationwide SafePass agent/franchise network system — separate from merchant_franchises (which is internal branch management for a single merchant). This is a standalone partner ecosystem with its own auth, transactions, earnings, and map.

## New tables (must run franchise_network_migration.sql in Supabase)
- `franchise_partners` — main partner table; phone-based auth; 4 tiers: basic/silver/gold/platinum
- `franchise_service_points` — physical service point locations per partner
- `franchise_transactions` — items handled at service points (receiving/consignment/inspection/delivery)
- `franchise_earnings` — wallet ledger: commission/bonus/penalty/withdrawal/deposit
- `franchise_ratings` — customer ratings per transaction
- `franchise_announcements` — admin broadcasts; 3 rows seeded

## Auth
- Separate JWT with `type: 'franchise'` — validated by `franchiseAuth` middleware
- Does NOT use the same token as regular user auth or businessAuth

## Key routes (server.js after line ~7998)
- `POST /api/franchise/auth/register|login`
- `GET/PUT /api/franchise/profile`
- `GET /api/franchise/dashboard` — stats + Chart.js monthly data
- `GET/POST/PATCH /api/franchise/transactions/:id`
- `GET/POST/PATCH/DELETE /api/franchise/service-points/:id`
- `GET /api/franchise/earnings`
- `GET /api/franchise/map` — **public** (no auth), returns active points + partners
- `GET /api/franchise/rankings`
- `GET /api/admin/franchise/partners?status=`
- `PATCH /api/admin/franchise/partners/:id` — approve/reject/suspend
- `PATCH /api/admin/franchise/partners/:id/tier`
- `GET /api/admin/franchise/stats`

## Frontend
- `frontend/franchise.html` — served at `/franchise`
- Leaflet.js + OpenStreetMap (free, no API key) for partner map
- Chart.js for dashboard
- Sidebar nav with 9 pages: Dashboard, Announcements, Transactions, Service Points, Earnings, Profile, Map, Rankings, Admin Center
- Admin section visible only after entering admin Bearer token

## Commission logic
On transaction completion: `commission_earned = service_fee * 0.05` auto-credited to partner wallet and logged in franchise_earnings.

**How to apply:** Run `franchise_network_migration.sql` in Supabase SQL Editor before using any franchise features.
