# 📋 Hướng Dẫn Chạy SQL Trong Supabase

> **Chạy đúng thứ tự từ trên xuống dưới.**
> Mỗi file chỉ cần chạy **1 lần**. Tất cả đều an toàn để chạy lại (dùng `IF NOT EXISTS`).

---

## BƯỚC 1 — NỀN TẢNG (Bắt buộc, chạy trước tất cả)

| # | File | Nội dung |
|---|------|---------|
| 1 | `schema.sql` | Bảng cốt lõi: `users`, `tickets`, `orders`, `transactions`, `reviews`, `kyc_requests`, `order_messages`, `referrals` |
| 2 | `migration.sql` | Admin system: `admins`, `admin_logs` + cột mới cho users/orders |
| 3 | `kyc_setup.sql` | KYC verification đầy đủ + storage buckets |
| 4 | `disable_rls.sql` | Tắt RLS cho tất cả bảng (backend Node.js tự xác thực) |

---

## BƯỚC 2 — MARKETPLACE & THANH TOÁN

| # | File | Nội dung |
|---|------|---------|
| 5 | `pay_migration.sql` | **Phase 18 Pay**: `wallets`, `wallet_transactions`, `payment_requests`, `safecoins` — ví điện tử nội bộ |
| 6 | `payment_transactions_setup.sql` | Bảng giao dịch thanh toán nâng cao |
| 7 | `open_escrow_migration.sql` | Hệ thống escrow mở rộng |
| 8 | `marketplace_migration.sql` | Marketplace tổng quát |
| 9 | `listings_migration.sql` | Listings & product catalog |

---

## BƯỚC 3 — DỊCH VỤ & VẬN CHUYỂN

| # | File | Nội dung |
|---|------|---------|
| 10 | `service_migration.sql` | Service marketplace |
| 11 | `freelance_migration.sql` | Hệ thống freelance |
| 12 | `shipping_migration.sql` | Quản lý vận chuyển |
| 13 | `logistics_migration.sql` | Logistics network |

---

## BƯỚC 4 — MẠNG XÃ HỘI

| # | File | Nội dung |
|---|------|---------|
| 14 | `social_migration.sql` | Social commerce cơ bản: `social_videos`, `social_posts` |
| 15 | `social_network_migration.sql` | Mạng xã hội: follows, feeds, interactions |
| 16 | `social_phase3_migration.sql` | **Phase 3**: Groups, Reels, Messenger — `dm_conversations`, `dm_messages`, `groups`, `reels` |
| 17 | `ai_social_phase4_migration.sql` | **Phase 4**: AI Discovery — `user_follows`, `user_interactions`, `ai_feed_cache`, `trending_items` |
| 18 | `stories_migration.sql` | **Phase 21**: Stories system |
| 19 | `live_migration.sql` | **Phase 19**: Live Commerce — `live_streams`, `live_products` |

---

## BƯỚC 5 — CREATOR & BUSINESS

| # | File | Nội dung |
|---|------|---------|
| 20 | `creator_phase5_migration.sql` | **Phase 5**: Creator Hub — `creator_profiles`, `affiliate_links`, `brand_campaigns`, `creator_wallet_txns` |
| 21 | `brand_social7_migration.sql` | **Phase Social 7**: Brand system — `brand_profiles`, `brand_posts`, `brand_products` |
| 22 | `business_migration.sql` | Business accounts cơ bản |
| 23 | `business_full_migration.sql` | Business accounts đầy đủ |
| 24 | `business_phase14_migration.sql` | **Phase 14**: Merchant Center — stores, analytics, loyalty |
| 25 | `franchise_network_migration.sql` | **Phase 15**: Franchise Network — `franchise_offices`, `franchise_members` |

---

## BƯỚC 6 — TRUST & QUẢN LÝ

| # | File | Nội dung |
|---|------|---------|
| 26 | `dam_migration.sql` | **Phase 6 DAM**: Digital Asset Manager — `dam_assets`, `dam_folders` |
| 27 | `trust_migration.sql` | **Phase 9**: Trust Center — `trust_scores`, `verification_documents`, `reputation_history` |
| 28 | `inspection_migration.sql` | **Phase 10**: Inspection Center — `inspection_fees`, `inspection_requests`, `inspection_reports` |
| 29 | `risk_migration.sql` | **Phase 13 Risk**: AI Risk Engine — `risk_profiles`, `risk_alerts`, `risk_rules`, `device_fingerprints` |
| 30 | `digital_accounts_migration.sql` | Tài khoản số & xác thực |

---

## BƯỚC 7 — HẠ TẦNG VẬT LÝ

| # | File | Nội dung |
|---|------|---------|
| 31 | `warehouse_migration.sql` | **Phase 11**: Warehouse Network — `warehouses` (4 seeded), `warehouse_inventory`, `warehouse_billing` |
| 32 | `delivery_migration.sql` | **Phase 12**: Delivery Network — `delivery_hubs` (4 seeded), `drivers`, `delivery_orders`, `driver_earnings` |

---

## BƯỚC 8 — METAVERSE & XR

| # | File | Nội dung |
|---|------|---------|
| 33 | `superapp8_migration.sql` | **Phase Social 8**: Super App — `sp_events`, `sp_mini_apps`, `sp_loyalty`, `sp_digital_products` |
| 34 | `spatial9_migration.sql` | **Phase 9 Spatial**: Không gian 3D |
| 35 | `worlds_migration.sql` | **Phase Social 10**: Virtual Worlds — `vw_worlds`, `vw_world_members`, `vw_world_posts` |
| 36 | `xr_migration.sql` | **Phase Social 11**: XR Network — `xr_spaces`, `xr_avatars`, `xr_events`, `xr_devices` |
| 37 | `avatar_economy_migration.sql` | **Phase Social 12**: Avatar Economy — `avatar_items` (22 seeded), `avatar_inventory`, `avatar_wardrobe` |
| 38 | `metaverse_migration.sql` | **Phase Social 13**: Metaverse Commerce — `mv_districts` (8 seeded), `mv_stores`, `mv_products` (8 seeded), `mv_orders`, `mv_subscriptions`, `mv_services` (4 seeded), `mv_reviews` |

---

## ⚡ Chỉ cần chạy những module bạn dùng

Nếu bạn không dùng tính năng nào đó, **không cần chạy file SQL đó**. Ví dụ:
- Chỉ dùng marketplace cơ bản → chạy Bước 1 + 2
- Dùng mạng xã hội → thêm Bước 4
- Dùng Metaverse → chạy tất cả đến Bước 8

---

## 🔴 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|-----|------------|---------|
| `relation "users" already exists` | Chạy schema.sql khi bảng đã có | File đã được sửa, chạy lại bình thường |
| `relation "X" does not exist` | Chạy file sau trước file trước | Chạy đúng thứ tự theo bảng trên |
| `column "X" already exists` | Migration đã chạy rồi | Bình thường, bỏ qua |
| `duplicate key value` | Seed data đã có | Bình thường, bỏ qua (`ON CONFLICT DO NOTHING`) |

---

## 🗄️ Cách chạy trong Supabase

1. Vào **Supabase Dashboard** → chọn project
2. Click **SQL Editor** (thanh bên trái)
3. Click **New query**
4. Copy toàn bộ nội dung file SQL → Paste vào editor
5. Click **Run** (hoặc `Ctrl+Enter`)
6. Thấy `Success` → chạy file tiếp theo

> 💡 **Tip**: Có thể mở nhiều tab SQL Editor song song để chạy nhanh hơn.
