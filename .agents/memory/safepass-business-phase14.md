---
name: SafePass Business Phase 14
description: Phase 14 Business & Merchant Center — tables, routes, frontend, and migration notes
---

# Phase 14: Business & Merchant Center

**Why:** Extends the existing `business_accounts` / developer-portal into a full Merchant Center with shop profiles, inventory, consignment, staff, franchises, verification, wallet, analytics, rankings, and public store pages.

## New tables (must run business_phase14_migration.sql in Supabase)
- `merchant_staff` — role: admin/manager/staff
- `merchant_inventory` — products with sku, price, stock, category, status
- `merchant_consignments` — consignment items, commission_rate, commission_earned
- `merchant_verifications` — license_number, tax_id, id_card_url; admin approves/rejects
- `merchant_wallet_txns` — type: revenue/fee/withdrawal/deposit/refund
- `merchant_franchises` — branch_name, address, manager_name/phone
- `merchant_reviews` — reviewer_name, rating, comment

## New columns on business_accounts
`account_type`, `logo_url`, `banner_url`, `bio`, `address`, `hotline`, `fanpage`, `store_slug` (unique), `badge` (none/verified/trusted/premium/gold/diamond), `is_verified_business`, `verification_status`, `wallet_balance`, `total_revenue`, `total_orders`, `completion_rate`, `avg_rating`, `review_count`, `rank_score`, `total_fees`

## Key routes added (all in server.js after line ~5500)
- `GET/PUT /api/merchant/profile` — businessAuth
- `GET /api/merchant/dashboard` — stats, low stock, recent consignments
- `GET/POST/PUT/DELETE /api/merchant/inventory/:id`
- `GET/POST /api/merchant/consignments`, `PATCH /api/merchant/consignments/:id`
- `GET/POST /api/merchant/staff`, `PATCH/DELETE /api/merchant/staff/:id`
- `GET/POST /api/merchant/franchises`, `PATCH/DELETE /api/merchant/franchises/:id`
- `GET /api/merchant/wallet`, `GET /api/merchant/analytics`
- `GET/POST /api/merchant/verification`
- `GET /api/merchant/rankings`
- `GET /store/:slug` — public store page (no auth)
- `GET/PATCH /api/admin/merchant/verifications/:id`
- `PATCH /api/admin/merchant/:id/badge`, `PATCH /api/admin/merchant/:id/status`

## Frontend
- `frontend/business.html` — complete Merchant Center (replaces old developer portal)
- Auth: login/register with account_type selector (individual/store/business/consignment)
- Sidebar nav: Dashboard, Profile, Inventory, Consignment, Staff, Franchise, Wallet, Analytics, Verification, Store Page, Rankings, API Center
- Chart.js for analytics (revenue/orders by month, consignment pie)
- `/store/:slug` — server-rendered public shop page

**How to apply:** Run `business_phase14_migration.sql` in Supabase SQL Editor before using merchant features.
