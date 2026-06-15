# 🛡️ SafePass — Tiến Trình Hệ Thống

> **Hướng dẫn dùng file này:**
> - Đọc file này trước khi build để biết trạng thái hiện tại
> - `[x]` = Đã hoàn thành | `[ ]` = Chưa build | `[~]` = Đang làm / làm một phần
> - Sau khi build xong một tính năng, cập nhật `[ ]` → `[x]` và ghi ngày hoàn thành

---

## ✅ Nền Tảng (Infrastructure)

- [x] Express.js server chạy trên port 5000, host 0.0.0.0 *(2025-06-15)*
- [x] Kết nối Supabase (PostgreSQL) với service role key *(2025-06-15)*
- [x] Serve static frontend từ thư mục `frontend/` *(2025-06-15)*
- [x] WebSocket transport (`ws` package) cho Node.js 20 *(2025-06-15)*
- [x] CORS cho phép mọi origin *(2025-06-15)*
- [x] Rate limiting: auth (10/15ph), orders (5/1ph), topup (10/1h), general (100/15ph) *(2025-06-15)*
- [x] Workflow Replit cấu hình đúng port 5000 webview *(2025-06-15)*
- [x] Deployment config (autoscale) *(2025-06-15)*

---

## ✅ Xác Thực (Authentication)

- [x] Đăng ký tài khoản (phone + password + name + email tùy chọn) *(2025-06-15)*
- [x] Đăng nhập → JWT token (30 ngày) *(2025-06-15)*
- [x] Middleware `auth` xác thực Bearer token *(2025-06-15)*
- [x] `GET /api/auth/me` — lấy thông tin user hiện tại *(2025-06-15)*
- [x] `PATCH /api/auth/profile` — cập nhật tên và email *(2025-06-16)*
- [x] Trang Hồ sơ (Profile page) với avatar, form cập nhật, đăng xuất *(2025-06-16)*
- [x] `PATCH /api/auth/password` — đổi mật khẩu *(2026-06-15)*
- [x] Form đổi mật khẩu trong Hồ sơ (current / new / confirm) *(2026-06-15)*
- [ ] Xác minh email (gửi OTP/link khi đăng ký)
- [ ] Quên mật khẩu (reset qua email)

---

## ✅ Vé (Tickets)

- [x] `POST /api/tickets` — đăng bán vé *(2025-06-15)*
- [x] `GET /api/tickets` — lấy danh sách (search, min/max price, pagination) *(2026-06-15)*
- [x] `GET /api/tickets/:id` — chi tiết 1 vé *(2025-06-15)*
- [x] `GET /api/my-tickets` — vé của seller *(2025-06-15)*
- [x] `DELETE /api/tickets/:id` — xoá listing (chỉ khi available) *(2025-06-15)*
- [x] `PATCH /api/tickets/:id` — seller chỉnh sửa vé đã đăng (chỉ khi available) *(2026-06-15)*
- [x] Phân trang (pagination) danh sách vé với page + limit params *(2026-06-15)*
- [ ] Upload ảnh vé (hiện chỉ có text description)
- [ ] Filter theo ngày sự kiện, địa điểm (đã có partial support)

---

## ✅ Đơn Hàng & Escrow

- [x] `POST /api/orders` — tạo đơn mua, giữ tiền escrow (+3% phí) *(2025-06-15)*
- [x] `GET /api/orders` — danh sách đơn (buyer/seller) *(2025-06-15)*
- [x] `POST /api/orders/:id/upload-qr` — seller upload QR code *(2025-06-15)*
- [x] `POST /api/orders/:id/confirm` — buyer xác nhận → giải ngân cho seller *(2025-06-15)*
- [x] Escrow timeout tự động 48h → hoàn tiền buyer nếu seller không upload QR *(2025-06-15)*
- [x] Chạy kiểm tra timeout mỗi 1 giờ *(2025-06-15)*
- [x] Email seller khi có đơn mua mới *(2026-06-15)*
- [x] Email buyer khi seller upload QR *(2026-06-15)*
- [x] Email seller khi buyer xác nhận (giải ngân) *(2026-06-15)*
- [x] Đếm ngược thời gian còn lại trong 48h trên giao diện buyer *(đã có sẵn)*

---

## ✅ Khiếu Nại (Dispute)

- [x] `POST /api/orders/:id/dispute` — mở khiếu nại (buyer hoặc seller) *(2025-06-15)*
- [x] 5 lý do khiếu nại có sẵn *(2025-06-15)*
- [x] `POST /api/admin/orders/:id/resolve` — admin giải quyết (chọn buyer/seller thắng) *(2025-06-15)*
- [x] Email thông báo admin khi có khiếu nại mới (Resend) *(2025-06-15)*
- [x] Email thông báo kết quả giải quyết khiếu nại cho buyer và seller *(2026-06-15)*
- [x] Thời hạn tự động đóng khiếu nại sau 3 ngày (hoàn tiền buyer) *(2026-06-15)*

---

## ✅ Ví & Giao Dịch (Wallet)

- [x] `POST /api/wallet/topup` — nạp tiền (giả lập) *(2025-06-15)*
- [x] `GET /api/wallet/transactions` — lịch sử giao dịch phân trang (page + limit) *(2026-06-15)*
- [x] `GET /api/wallet/transactions/export` — export CSV lịch sử giao dịch *(2026-06-15)*
- [x] Ghi log transaction cho mọi sự kiện: topup, escrow_lock, payout, refund *(2025-06-15)*
- [x] Nút Export CSV trong tab Lịch sử ví *(2026-06-15)*
- [x] Nút Tải thêm (pagination) trong tab Lịch sử ví *(2026-06-15)*
- [ ] Rút tiền từ ví về tài khoản ngân hàng (tích hợp cổng thanh toán thật)

---

## ✅ Đánh Giá (Reviews)

- [x] `POST /api/orders/:id/review` — buyer gửi đánh giá sau khi hoàn tất *(2025-06-15)*
- [x] `GET /api/users/:id/reviews` — lấy reviews của seller *(2025-06-15)*
- [x] Tự động tính avg_rating và review_count cho seller *(2025-06-15)*
- [x] `POST /api/reviews/:id/reply` — seller phản hồi review *(2026-06-15)*
- [x] Email seller khi nhận được đánh giá mới *(2026-06-15)*
- [ ] Report review vi phạm

---

## ✅ Trang Admin

- [x] `GET /api/admin/orders` — danh sách tất cả đơn (filter by status) *(2025-06-15)*
- [x] `GET /api/admin/orders/:id` — chi tiết 1 đơn *(2025-06-15)*
- [x] `GET /api/admin/users` — danh sách users (có search theo tên/SĐT) *(2026-06-15)*
- [x] `POST /api/admin/users/:id/ban` — khóa tài khoản *(2026-06-15)*
- [x] `POST /api/admin/users/:id/unban` — mở khóa tài khoản *(2026-06-15)*
- [x] `GET /api/admin/stats` — thống kê: Revenue, GMV, Escrow, Users, Orders *(2026-06-15)*
- [x] `GET /api/admin/export` — xuất báo cáo orders CSV *(2026-06-15)*
- [x] `POST /api/admin/process-timeouts` — trigger escrow timeout thủ công *(2025-06-15)*
- [x] Trang `admin.html` — overview (revenue stats), disputes, orders, users *(2026-06-15)*
- [x] Xác thực bằng ADMIN_SECRET *(2025-06-15)*
- [x] Tìm kiếm user theo tên / số điện thoại *(2026-06-15)*
- [x] Ban/unban user từ giao diện admin *(2026-06-15)*
- [x] Xuất báo cáo CSV đơn hàng *(2026-06-15)*
- [x] Thống kê doanh thu (Revenue, GMV, Escrow locked, Users, Disputes) *(2026-06-15)*

---

## ✅ Email Thông Báo (Notifications)

- [x] Tích hợp Resend API *(2025-06-16)*
- [x] Email admin khi có **khiếu nại mới** *(2025-06-16)*
- [x] Email admin **tổng hợp** khi escrow timeout hàng loạt *(2025-06-16)*
- [x] Email buyer khi **được hoàn tiền tự động** (nếu có email) *(2025-06-16)*
- [x] Email seller khi có **đơn mua mới** *(2026-06-15)*
- [x] Email buyer khi seller **upload QR** *(2026-06-15)*
- [x] Email seller khi **giải ngân** (buyer confirm) *(2026-06-15)*
- [x] Email buyer/seller khi **khiếu nại được giải quyết** *(2026-06-15)*
- [x] Email seller khi **nhận được đánh giá mới** *(2026-06-15)*

---

## ✅ Giao Diện Frontend

- [x] Dark UI premium (SafePass v13) *(2025-06-15)*
- [x] Trang Marketplace (xem vé, tìm kiếm, lọc giá) *(2025-06-15)*
- [x] Trang Ví (wallet overview + lịch sử phân trang + export CSV) *(2026-06-15)*
- [x] Trang My Orders (đơn mua + đơn bán) *(2025-06-15)*
- [x] Modal đăng nhập / đăng ký (có field email) *(2025-06-16)*
- [x] Trang Hồ sơ (👤) — cập nhật tên, email, **đổi mật khẩu**, đăng xuất *(2026-06-15)*
- [x] API URL tự động dùng `window.location.origin` (không hardcode) *(2025-06-15)*
- [x] Empty state khi Lịch sử giao dịch trống *(2026-06-15)*
- [x] Loading indicator khi fetch transactions *(2026-06-15)*
- [ ] Responsive mobile tốt hơn (hiện chỉ ổn ở desktop)
- [ ] Dark/light mode toggle

---

## ✅ Bảo Mật

- [x] Password hash bcrypt (salt 10) *(2025-06-15)*
- [x] JWT token với expiry 30 ngày *(2025-06-15)*
- [x] Rate limiting chống spam *(2025-06-15)*
- [x] ADMIN_SECRET cho các route admin *(2025-06-15)*
- [x] Validate & sanitize toàn bộ input (sanitize() helper + validation trên tất cả routes) *(2026-06-15)*
- [x] Helmet.js (HTTP security headers: XSS, HSTS, noSniff, frameguard...) *(2026-06-15)*
- [x] Audit trail cho hành động admin (ghi vào transactions type=admin_action) *(2026-06-15)*
- [x] Check is_banned khi đăng nhập và tạo đơn hàng *(2026-06-15)*
- [ ] Refresh token (hiện chỉ dùng access token)

---

## ⚠️ Cần Chạy Migration trong Supabase SQL Editor

Chạy các câu SQL này trong **Supabase Dashboard → SQL Editor** để bật đầy đủ tính năng:

```sql
-- 1. Cột is_banned cho ban/unban users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned boolean default false;

-- 2. Cột email (nếu chưa có)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;

-- 3. Các cột dispute vào orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_reason text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_description text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_opened_by text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_opened_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_resolved_by text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_resolved_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_note text;

-- 4. Bảng reviews (nếu chưa có)
CREATE TABLE IF NOT EXISTS reviews (
  id uuid default gen_random_uuid() primary key,
  order_id uuid references orders(id),
  buyer_id uuid references users(id),
  buyer_name text,
  seller_id uuid references users(id),
  event_name text,
  rating int check (rating between 1 and 5),
  text text,
  seller_reply text,
  seller_reply_at timestamptz,
  created_at timestamptz default now()
);
ALTER TABLE reviews DISABLE ROW LEVEL SECURITY;

-- 5. Index tối ưu hiệu năng (optional)
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);
```

---

## 📌 Ghi Chú Kỹ Thuật

| Mục | Chi tiết |
|-----|----------|
| Runtime | Node.js 20 + ES Modules |
| Port | 5000 (webview Replit) |
| Database | Supabase (PostgreSQL) |
| Auth | JWT + bcryptjs |
| Email | Resend API (`onboarding@resend.dev`) |
| Frontend | Vanilla JS + HTML + CSS (SPA) |
| Security | Helmet.js, bcrypt, rate-limit, sanitize() |
| Secrets | `SUPABASE_URL`, `SUPABASE_KEY`, `JWT_SECRET`, `ADMIN_SECRET`, `RESEND_API_KEY`, `ADMIN_EMAIL` |

---

*Cập nhật lần cuối: 2026-06-15*
