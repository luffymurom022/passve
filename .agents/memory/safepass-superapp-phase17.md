---
name: SafePass Super App Phase 17
description: Phase 17 — mobile-first Super App aggregating all modules, no new SQL, standalone page at /superapp
---

# Phase 17: SafePass Super App

**Why:** Transforms SafePass into a unified Super App with Shopee/Grab/Chợ Tốt-style mobile UX connecting all 16 prior phases.

## Architecture
- **No new SQL tables** — aggregates existing data from all phases
- **Standalone page**: `frontend/superapp.html` served at `GET /superapp`
- **Auth**: uses `sp_token` from localStorage (same as main app); no auth required to browse public content
- **Max-width 480px** centered — mobile-first responsive

## 5 Bottom-Tab Navigation
1. **🏠 Trang chủ** — banner carousel (4s auto), 8 service icons, featured listings from `/api/tickets`, smart recommendations, franchise partners hscroll
2. **🛒 Chợ** — category filter chips, sort (new/price asc/desc), infinite load, search from top bar (debounced)
3. **⚡ Dịch vụ** — 6 service cards (links to existing pages) + Leaflet ecosystem map (filter by type: warehouse/franchise/receiving/inspection)
4. **👤 Tôi** — wallet card (no real balance, placeholder), trust score progress bar, recent orders, Chart.js bar chart (6m activity)
5. **🏢 Doanh nghiệp** — biz header with 3 stats, 6 module cards linking to all business modules

## AI Assistant (rule-based, no external API)
- Floating FAB (🤖) → slide-up panel
- Knowledge base: 8 topics: đăng bán, phí vận chuyển, escrow, kiểm định, kho, đại lý, trust/KYC, greetings
- Smart fallback for price/support/unknown questions
- Quick reply chips for common questions
- Typing animation (3 dot bounce)

## New API routes (before Phase 16 block in server.js)
- `GET /superapp` — serve frontend/superapp.html
- `GET /api/superapp/map` — returns warehouse + delivery_hub + franchise_partner points with lat/lng (uses jitter for missing coords)
- `GET /api/superapp/stats` — public platform stats (users, listings, escrow, franchises, drivers, warehouses)

## Map coordinate handling
Warehouses table may not have lat/lng columns — map route uses `viCoords` lookup by province name + jitter(0.15) fallback. No crash if columns missing.

## Nav entry in index.html
`{id:"superapp",icon:"⚡",label:"Super App"}` → onclick `window.location.href='/superapp'`

**How to apply:** Navigate to /superapp after server restart. No SQL migration needed.
