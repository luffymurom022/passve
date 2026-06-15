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
- [ ] `PATCH /api/auth/password` — đổi mật khẩu
- [ ] Xác minh email (gửi OTP/link khi đăng ký)
- [ ] Quên mật khẩu (reset qua email)

---

## ✅ Vé (Tickets)

- [x] `POST /api/tickets` — đăng bán vé *(2025-06-15)*
- [x] `GET /api/tickets` — lấy danh sách (search, min/max price filter) *(2025-06-15)*
- [x] `GET /api/tickets/:id` — chi tiết 1 vé *(2025-06-15)*
- [x] `GET /api/my-tickets` — vé của seller *(2025-06-15)*
- [x] `DELETE /api/tickets/:id` — xoá listing (chỉ khi available) *(2025-06-15)*
- [ ] Phân trang (pagination) danh sách vé
- [ ] Upload ảnh vé (hiện chỉ có text description)
- [ ] Filter theo ngày sự kiện, địa điểm
- [ ] Seller chỉnh sửa vé đã đăng (edit listing)

---

## ✅ Đơn Hàng & Escrow

- [x] `POST /api/orders` — tạo đơn mua, giữ tiền escrow (+3% phí) *(2025-06-15)*
- [x] `GET /api/orders` — danh sách đơn (buyer/seller) *(2025-06-15)*
- [x] `POST /api/orders/:id/upload-qr` — seller upload QR code *(2025-06-15)*
- [x] `POST /api/orders/:id/confirm` — buyer xác nhận → giải ngân cho seller *(2025-06-15)*
- [x] Escrow timeout tự động 48h → hoàn tiền buyer nếu seller không upload QR *(2025-06-15)*
- [x] Chạy kiểm tra timeout mỗi 1 giờ *(2025-06-15)*
- [ ] Thông báo email cho seller khi có đơn mua mới
- [ ] Thông báo email cho buyer khi seller upload QR
- [ ] Thông báo email cho seller khi buyer xác nhận (giải ngân)
- [ ] Đếm ngược thời gian còn lại trong 48h trên giao diện buyer

---

## ✅ Khiếu Nại (Dispute)

- [x] `POST /api/orders/:id/dispute` — mở khiếu nại (buyer hoặc seller) *(2025-06-15)*
- [x] 5 lý do khiếu nại có sẵn *(2025-06-15)*
- [x] `POST /api/admin/orders/:id/resolve` — admin giải quyết (chọn buyer/seller thắng) *(2025-06-15)*
- [x] Email thông báo admin khi có khiếu nại mới (Resend) *(2025-06-15)*
- [ ] Email thông báo kết quả giải quyết khiếu nại cho buyer và seller
- [ ] Thời hạn tự động đóng khiếu nại nếu admin không phản hồi sau X ngày

---

## ✅ Ví & Giao Dịch (Wallet)

- [x] `POST /api/wallet/topup` — nạp tiền (giả lập) *(2025-06-15)*
- [x] `GET /api/wallet/transactions` — lịch sử giao dịch (50 gần nhất) *(2025-06-15)*
- [x] Ghi log transaction cho mọi sự kiện: topup, escrow_lock, payout, refund *(2025-06-15)*
- [ ] Rút tiền từ ví về tài khoản ngân hàng (tích hợp cổng thanh toán thật)
- [ ] Lịch sử giao dịch phân trang (hiện giới hạn 50)
- [ ] Export lịch sử giao dịch (CSV)

---

## ✅ Đánh Giá (Reviews)

- [x] `POST /api/orders/:id/review` — buyer gửi đánh giá sau khi hoàn tất *(2025-06-15)*
- [x] `GET /api/users/:id/reviews` — lấy reviews của seller *(2025-06-15)*
- [x] Tự động tính avg_rating và review_count cho seller *(2025-06-15)*
- [ ] Seller phản hồi review
- [ ] Report review vi phạm

---

## ✅ Trang Admin

- [x] `GET /api/admin/orders` — danh sách tất cả đơn (filter by status) *(2025-06-15)*
- [x] `GET /api/admin/orders/:id` — chi tiết 1 đơn *(2025-06-15)*
- [x] `GET /api/admin/users` — danh sách users *(2025-06-15)*
- [x] `POST /api/admin/process-timeouts` — trigger escrow timeout thủ công *(2025-06-15)*
- [x] Trang `admin.html` với dashboard: overview, orders, disputes, users *(2025-06-15)*
- [x] Xác thực bằng ADMIN_SECRET *(2025-06-15)*
- [ ] Thống kê doanh thu, phí thu được
- [ ] Tìm kiếm user theo tên / số điện thoại
- [ ] Ban/unban user
- [ ] Xuất báo cáo (CSV/Excel)

---

## ✅ Email Thông Báo (Notifications)

- [x] Tích hợp Resend API *(2025-06-16)*
- [x] Email admin khi có **khiếu nại mới** *(2025-06-16)*
- [x] Email admin **tổng hợp** khi escrow timeout hàng loạt *(2025-06-16)*
- [x] Email buyer khi **được hoàn tiền tự động** (nếu có email) *(2025-06-16)*
- [ ] Email seller khi có **đơn mua mới**
- [ ] Email buyer khi seller **upload QR**
- [ ] Email buyer/seller khi **khiếu nại được giải quyết**
- [ ] Email seller khi **nhận được đánh giá mới**

---

## ✅ Giao Diện Frontend

- [x] Dark UI premium (SafePass v13) *(2025-06-15)*
- [x] Trang Marketplace (xem vé, tìm kiếm, lọc giá) *(2025-06-15)*
- [x] Trang Ví (wallet overview + lịch sử) *(2025-06-15)*
- [x] Trang My Orders (đơn mua + đơn bán) *(2025-06-15)*
- [x] Modal đăng nhập / đăng ký (có field email) *(2025-06-16)*
- [x] Trang Hồ sơ (👤) — cập nhật tên, email, đăng xuất *(2025-06-16)*
- [x] API URL tự động dùng `window.location.origin` (không hardcode) *(2025-06-15)*
- [ ] Trang đổi mật khẩu trong Hồ sơ
- [ ] Responsive mobile tốt hơn (hiện chỉ ổn ở desktop)
- [ ] Dark/light mode toggle
- [ ] Loading skeleton khi fetch data
- [ ] Empty state đẹp hơn khi chưa có vé / đơn

---

## 🔒 Bảo Mật

- [x] Password hash bcrypt (salt 10) *(2025-06-15)*
- [x] JWT token với expiry 30 ngày *(2025-06-15)*
- [x] Rate limiting chống spam *(2025-06-15)*
- [x] ADMIN_SECRET cho các route admin *(2025-06-15)*
- [ ] Validate & sanitize toàn bộ input (hiện chỉ basic validation)
- [ ] Helmet.js (HTTP security headers)
- [ ] Refresh token (hiện chỉ dùng access token)
- [ ] Log audit trail cho hành động admin

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
| Secrets | `SUPABASE_URL`, `SUPABASE_KEY`, `JWT_SECRET`, `ADMIN_SECRET`, `RESEND_API_KEY`, `ADMIN_EMAIL` |
| Migration cần chạy | `ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;` |

---

*Cập nhật lần cuối: 2025-06-16*
