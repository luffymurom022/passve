# 🛡️ SafePass — Tiến Trình Hệ Thống

---

## ✅ TỔNG KẾT CHỨC NĂNG ĐÃ BUILD XONG
> Cập nhật lần cuối: **2026-06-18 20:00** — Tự động cập nhật sau mỗi lần build xong

### 🛒 Escrow Marketplace Đa Danh Mục *(HOÀN THÀNH)*
| Chức năng | Ngày hoàn thành |
|---|---|
| **NÂNG CẤP**: Bảng `listings` mới — 6 loại: ticket/product/account/course/service/booking | 2026-06-18 |
| `POST /api/listings` — tạo listing đa danh mục | 2026-06-18 |
| `GET /api/listings` — browse listings (filter type, search, pagination) | 2026-06-18 |
| `GET /api/listings/:id` — chi tiết 1 listing | 2026-06-18 |
| `GET /api/my-listings` — seller xem listing của mình | 2026-06-18 |
| `PATCH /api/listings/:id` — seller chỉnh sửa listing | 2026-06-18 |
| `DELETE /api/listings/:id` — xóa listing | 2026-06-18 |
| `PATCH /api/listings/:id/visibility` — toggle ẩn/hiện listing | 2026-06-18 |
| `POST /api/orders` — mua listing bất kỳ (ticket_id hoặc listing_id) | 2026-06-18 |
| Admin: `GET /api/admin/listings` — quản lý tất cả listings | 2026-06-18 |
| Frontend: Sell form 3 bước với type selector 6 loại + adaptive fields | 2026-06-18 |
| Frontend: Marketplace hiển thị cả tickets lẫn listings | 2026-06-18 |
| Frontend: Admin tab "Listings" với filter type/status, hide/delete | 2026-06-18 |

### 🤝 Referral & Hoa Hồng *(HOÀN THÀNH)*
| Chức năng | Ngày hoàn thành |
|---|---|
| Mã giới thiệu duy nhất (referral code) cho mỗi user | 2026-06-18 |
| User mới đăng ký qua mã giới thiệu nhận +50,000đ | 2026-06-18 |
| Referrer nhận 2% hoa hồng mỗi đơn hàng thành công | 2026-06-18 |

### 🏗️ Hạ Tầng & Cấu Hình
| Chức năng | Ngày hoàn thành |
|---|---|
| Express.js server port 5000, host 0.0.0.0 | 2025-06-15 |
| Kết nối Supabase (PostgreSQL) service role key | 2025-06-15 |
| Serve static frontend từ `frontend/` | 2025-06-15 |
| WebSocket transport (`ws` package) Node.js 20 | 2025-06-15 |
| CORS cho phép mọi origin | 2025-06-15 |
| Rate limiting: auth/orders/topup/general | 2025-06-15 |
| Workflow Replit cấu hình đúng port 5000 | 2025-06-15 |
| Deployment config (autoscale) | 2025-06-15 |
| Tất cả secrets lưu trong Replit Secrets | 2026-06-15 |

### 👤 Auth & Người Dùng
| Chức năng | Ngày hoàn thành |
|---|---|
| Đăng ký tài khoản (phone + password + name + email) | 2025-06-15 |
| Đăng nhập → JWT token (30 ngày) | 2025-06-15 |
| Middleware `auth` xác thực Bearer token | 2025-06-15 |
| `GET /api/auth/me` — thông tin user hiện tại | 2025-06-15 |
| `PATCH /api/auth/profile` — cập nhật tên & email | 2025-06-16 |
| Trang Hồ sơ (Profile page) với avatar, form cập nhật | 2025-06-16 |
| `PATCH /api/auth/password` — đổi mật khẩu | 2026-06-15 |
| Form đổi mật khẩu trong Hồ sơ | 2026-06-15 |
| Xác minh email — OTP 6 số gửi qua Resend | 2026-06-15 |
| Quên mật khẩu — link reset gửi qua email | 2026-06-15 |
| Refresh token — `POST /api/auth/refresh` | 2026-06-15 |

### 🎟️ Vé (Tickets)
| Chức năng | Ngày hoàn thành |
|---|---|
| `POST /api/tickets` — đăng bán vé | 2025-06-15 |
| `GET /api/tickets` — danh sách (search, filter giá, pagination) | 2026-06-15 |
| `GET /api/tickets/:id` — chi tiết 1 vé | 2025-06-15 |
| `GET /api/my-tickets` — vé của seller | 2025-06-15 |
| `DELETE /api/tickets/:id` — xoá listing | 2025-06-15 |
| `PATCH /api/tickets/:id` — seller chỉnh sửa vé | 2026-06-15 |
| Phân trang (pagination) danh sách vé | 2026-06-15 |
| Upload ảnh vé — Supabase Storage `ticket-images` | 2026-06-15 |
| Filter theo ngày sự kiện, địa điểm | 2026-06-15 |
| Filter theo danh mục (category) — concerts/kpop/sports/festivals/other | 2026-06-17 |

### 📦 Đơn Hàng & Escrow
| Chức năng | Ngày hoàn thành |
|---|---|
| `POST /api/orders` — tạo đơn, giữ tiền escrow (+3% phí) | 2025-06-15 |
| `GET /api/orders` — danh sách đơn (buyer/seller) | 2025-06-15 |
| `POST /api/orders/:id/upload-qr` — seller upload QR code | 2025-06-15 |
| `POST /api/orders/:id/confirm` — buyer xác nhận → giải ngân | 2025-06-15 |
| Escrow timeout tự động 48h → hoàn tiền buyer | 2025-06-15 |
| Kiểm tra timeout mỗi 1 giờ (cron) | 2025-06-15 |
| Email seller khi có đơn mua mới | 2026-06-15 |
| Email buyer khi seller upload QR | 2026-06-15 |
| Email seller khi buyer xác nhận (giải ngân) | 2026-06-15 |
| Đếm ngược 48h trên giao diện buyer | 2026-06-15 |
| Chat nội bộ buyer↔seller trong đơn hàng | 2026-06-17 |

### ⚠️ Khiếu Nại (Dispute)
| Chức năng | Ngày hoàn thành |
|---|---|
| `POST /api/orders/:id/dispute` — mở khiếu nại | 2025-06-15 |
| 5 lý do khiếu nại có sẵn | 2025-06-15 |
| `POST /api/admin/orders/:id/resolve` — admin giải quyết | 2025-06-15 |
| Email thông báo admin khi có khiếu nại mới | 2025-06-15 |
| Email thông báo kết quả giải quyết cho buyer & seller | 2026-06-15 |
| Thời hạn tự động đóng khiếu nại sau 3 ngày | 2026-06-15 |

### 💰 Ví & Giao Dịch
| Chức năng | Ngày hoàn thành |
|---|---|
| `POST /api/wallet/topup` — nạp tiền (giả lập) | 2025-06-15 |
| `GET /api/wallet/transactions` — lịch sử giao dịch phân trang | 2026-06-15 |
| `GET /api/wallet/transactions/export` — export CSV | 2026-06-15 |
| Ghi log transaction cho mọi sự kiện tài chính | 2025-06-15 |
| Rút tiền về ngân hàng (manual — admin duyệt) | 2026-06-17 |
| Gói VIP/Premium (phí giao dịch 0% thay vì 3%) | 2026-06-17 |

### ⭐ Đánh Giá (Reviews)
| Chức năng | Ngày hoàn thành |
|---|---|
| `POST /api/orders/:id/review` — buyer gửi đánh giá | 2025-06-15 |
| `GET /api/users/:id/reviews` — reviews của seller | 2025-06-15 |
| Tự động tính avg_rating và review_count | 2025-06-15 |
| `POST /api/reviews/:id/reply` — seller phản hồi review | 2026-06-15 |
| Email seller khi nhận đánh giá mới | 2026-06-15 |
| Report review vi phạm | 2026-06-15 |

### 🛡️ Admin Dashboard
| Chức năng | Ngày hoàn thành |
|---|---|
| Admin auth email+password → JWT 12h (bảng `admins` Supabase) | 2026-06-18 |
| `POST /api/admin/auth/setup` — tạo super_admin đầu tiên | 2026-06-18 |
| `POST /api/admin/auth/login` — đăng nhập email+password | 2026-06-18 |
| `POST /api/admin/auth/create` — super_admin tạo thêm admin | 2026-06-18 |
| `adminAuth` middleware (Bearer JWT hoặc legacy secret) | 2026-06-18 |
| Audit Log — bảng `admin_logs`, `logAdminAction()` helper | 2026-06-18 |
| `GET /api/admin/logs` — xem log (filter theo action) | 2026-06-18 |
| `GET /api/admin/disputes` — queue dispute chờ xử lý | 2026-06-18 |
| `PATCH /api/admin/tickets/:id/hide` — ẩn/hiện vé | 2026-06-18 |
| `GET/POST /api/admin/orders/:id/messages` — admin đọc/gửi chat | 2026-06-18 |
| `GET /api/admin/orders` — danh sách tất cả đơn | 2025-06-15 |
| `GET /api/admin/users` — danh sách users | 2026-06-15 |
| `POST /api/admin/users/:id/ban` — khóa tài khoản | 2026-06-15 |
| `POST /api/admin/users/:id/unban` — mở khóa | 2026-06-15 |
| `POST /api/admin/users/:id/verify` — verify seller | 2026-06-16 |
| `GET /api/admin/stats` — thống kê tổng hợp | 2026-06-15 |
| `GET /api/admin/export` — xuất CSV đơn hàng | 2026-06-15 |
| `POST /api/admin/orders/:id/force-cancel` — hủy đơn & hoàn tiền buyer | 2026-06-17 |
| `POST /api/admin/orders/:id/force-release` — giải ngân cho seller | 2026-06-17 |
| `POST /api/admin/process-timeouts` — trigger escrow timeout thủ công | 2025-06-15 |
| Admin Dashboard UI (admin.html) — dark theme, login, 10 tabs | 2026-06-18 |
| Sidebar + mobile nav + topbar (admin info, role badge) | 2026-06-18 |
| Dispute chat — admin xem & gửi tin nhắn vào chat đơn hàng | 2026-06-18 |
| Badge đếm dispute/withdrawal/KYC chờ xử lý | 2026-06-18 |
| Settings — tạo/liệt kê/xóa tài khoản admin | 2026-06-18 |

### 🔔 Thông Báo (Notifications)
| Chức năng | Ngày hoàn thành |
|---|---|
| Tích hợp Resend API (email) | 2025-06-16 |
| Thông báo trong app — bell icon, dropdown 20 thông báo | 2026-06-15 |
| `GET /api/notifications` — lấy danh sách thông báo | 2026-06-15 |
| `POST /api/notifications/:id/read` + `read-all` | 2026-06-15 |
| Polling thông báo mỗi 30 giây | 2026-06-15 |
| Unread badge trên bell icon | 2026-06-15 |

### 🎨 Giao Diện Frontend (index.html)
| Chức năng | Ngày hoàn thành |
|---|---|
| Dark UI premium (SafePass) | 2025-06-15 |
| Marketplace — xem vé, tìm kiếm, lọc giá, lọc danh mục | 2025-06-15 |
| Ví — tổng quan + lịch sử phân trang + export CSV | 2026-06-15 |
| My Orders — đơn mua + đơn bán + chat nội bộ | 2025-06-15 |
| Modal đăng nhập / đăng ký | 2025-06-16 |
| Trang Hồ sơ (Profile) + KYC upload | 2026-06-15 |
| Seller Dashboard analytics (Chart.js) | 2026-06-15 |
| Trang profile công khai seller tại `/seller/:id` | 2026-06-15 |
| Responsive mobile | 2026-06-15 |
| Dark/light mode toggle | 2026-06-15 |

### 🪪 KYC — Xác Minh Danh Tính
| Chức năng | Ngày hoàn thành |
|---|---|
| Bảng `kyc_requests` Supabase | 2026-06-17 |
| Supabase Storage bucket `kyc-documents` (private) | 2026-06-17 |
| `POST /api/kyc/submit` — upload 3 ảnh CCCD + selfie | 2026-06-17 |
| `GET /api/kyc/status` — user kiểm tra trạng thái KYC | 2026-06-17 |
| `GET /api/admin/kyc` — admin xem danh sách KYC pending | 2026-06-17 |
| `POST /api/admin/kyc/:id/approve` — duyệt KYC | 2026-06-17 |
| `POST /api/admin/kyc/:id/reject` — từ chối KYC | 2026-06-17 |
| Section KYC trong trang Profile người dùng | 2026-06-17 |

### 📷 QR Xác Minh Vé
| Chức năng | Ngày hoàn thành |
|---|---|
| `GET /api/orders/:id/verify-qr` — tạo JWT QR token, trả về QR PNG | 2026-06-17 |
| `POST /api/scan/auth` — xác thực scanner (admin hoặc organizer) | 2026-06-17 |
| `POST /api/scan/verify` — quét QR, chống dùng lại | 2026-06-17 |
| `GET /api/scan/history` — lịch sử quét | 2026-06-17 |
| `frontend/scanner.html` — trang quét độc lập cho ban tổ chức | 2026-06-17 |
| Xem & tải QR code trong chi tiết đơn hàng | 2026-06-17 |

### 🤝 Referral & Hoa Hồng
| Chức năng | Ngày hoàn thành |
|---|---|
| Mã giới thiệu duy nhất (referral code) cho mỗi user | 2026-06-18 |
| User mới đăng ký qua mã giới thiệu nhận +50,000đ | 2026-06-18 |
| Referrer nhận 2% hoa hồng mỗi đơn hàng thành công | 2026-06-18 |

### 👥 Moderator & Phân Quyền
| Chức năng | Ngày hoàn thành |
|---|---|
| Moderator role (is_moderator trên users table) | 2026-06-17 |
| Xác minh seller (verified badge) — admin verify/unverify | 2026-06-16 |

---

## 🤖 HƯỚNG DẪN CHO AI AGENT — ĐỌC TRƯỚC KHI LÀM BẤT CỨ ĐIỀU GÌ

> **Khi mở project này, AI Agent phải:**
> 1. Đọc file này đầu tiên, toàn bộ từ đầu đến cuối
> 2. Tìm tất cả các mục `[ ]` (chưa build) — đó là việc cần làm tiếp theo
> 3. Build các mục `[ ]` theo thứ tự từ trên xuống dưới, ưu tiên cao trước
> 4. Sau khi build xong mỗi mục, cập nhật ngay `[ ]` → `[x]` và ghi ngày
> 5. Không hỏi lại những gì đã rõ ràng trong file — cứ build luôn
> 6. Nếu một mục `[ ]` có ký hiệu `⚡` = ưu tiên cao, build trước tiên
> 7. Nếu một mục `[ ]` có ký hiệu `🔒` = cần thông tin từ user (API key, v.v.), bỏ qua và tiếp tục mục khác

> **Quy ước trạng thái:**
> - `[x]` = Đã hoàn thành
> - `[ ]` = Chưa build — build ngay
> - `[~]` = Đang làm / làm một phần
> - `[-]` = Tạm hoãn / không ưu tiên

> **Stack kỹ thuật:**
> - Backend: Node.js 20 + Express (ES Modules) — `server.js`
> - Database: Supabase (PostgreSQL) — không dùng Replit DB
> - Frontend: Vanilla JS/HTML/CSS — `frontend/index.html`, `frontend/admin.html`
> - Auth: JWT + bcryptjs (phone + password), token 30 ngày
> - Email: Resend API (`onboarding@resend.dev`)
> - Port: 5000, host: 0.0.0.0
> - Secrets: SUPABASE_URL, SUPABASE_KEY, JWT_SECRET, RESEND_API_KEY, ADMIN_EMAIL, ADMIN_SECRET

---

## 👤 Các Loại Tài Khoản (Account Types)

### Hiện tại

| Loại | Xác thực | Quyền hạn | Lưu trong DB |
|------|----------|-----------|--------------|
| **User thường** | Phone + Password → JWT | Mua vé, bán vé, ví, đánh giá, đổi mật khẩu | ✅ `users` table |
| **Admin** | `ADMIN_SECRET` (env var) | Xem tất cả đơn, resolve dispute, ban/unban user, xem stats, xuất CSV | ❌ Không có tài khoản riêng |

> Hiện tại một tài khoản User có thể vừa là **Buyer** (người mua), vừa là **Seller** (người bán) — không có phân biệt vai trò cố định.

---

### Quyền hạn chi tiết theo vai trò

#### 🧑 User (Buyer)
- Xem & tìm kiếm vé trên Marketplace
- Mua vé → escrow giữ tiền → nhận QR → xác nhận giao dịch
- Mở khiếu nại nếu có vấn đề
- Đánh giá seller sau khi giao dịch hoàn tất
- Xem lịch sử giao dịch ví, xuất CSV
- Đổi mật khẩu, cập nhật hồ sơ

#### 🏪 User (Seller)
- Đăng bán vé (tên sự kiện, giá, ngày, địa điểm, mô tả)
- Sửa / xoá listing vé chưa có người mua
- Upload QR code sau khi nhận đơn
- Phản hồi đánh giá của buyer
- Nhận tiền vào ví sau khi buyer xác nhận
- Mở khiếu nại nếu cần

#### 🛡️ Admin
- Truy cập tại `/admin.html` bằng `ADMIN_SECRET`
- Xem thống kê: Revenue, GMV, Escrow, Users, Disputes
- Xem & resolve tất cả đơn hàng đang disputed
- Xem danh sách tất cả users, tìm kiếm theo tên/SĐT
- Ban / unban tài khoản user
- Xuất báo cáo CSV tất cả đơn hàng
- Trigger escrow timeout thủ công

#### 🚫 User bị khóa (`is_banned = true`)
- Không thể đăng nhập (bị chặn ở bước xác thực)
- Không thể tạo đơn hàng mới
- Admin có thể mở khóa bất cứ lúc nào

---

## 🗺️ ROADMAP DỰ ÁN

### Phase 1 — MVP (✅ Hoàn thành)
Core marketplace hoạt động: đăng vé, mua vé, escrow, QR, dispute, ví, admin.

### Phase 2 — Trust & Growth (✅ Hoàn thành)
Tăng độ tin cậy, trải nghiệm người dùng tốt hơn, seller được xác minh.

| Tính năng | Ưu tiên | Trạng thái |
|-----------|---------|------------|
| Xác minh seller (verified badge) | Cao | `[x]` ✅ 2026-06-16 |
| Hệ thống thông báo trong app (bell icon) | Cao | `[x]` ✅ 2026-06-15 |
| Trang profile công khai của seller | Trung bình | `[x]` ✅ 2026-06-15 |
| Tìm kiếm nâng cao (lọc theo danh mục sự kiện) | Trung bình | `[x]` ✅ 2026-06-17 |
| Seller dashboard với analytics đơn giản | Trung bình | `[x]` ✅ 2026-06-15 |
| Chat nội bộ giữa buyer và seller trong đơn hàng | Thấp | `[x]` ✅ 2026-06-17 |

### Phase 3 — Monetization & Scale (📋 Kế hoạch)
Tích hợp thanh toán thật, mở rộng tính năng cao cấp.

| Tính năng | Ưu tiên | Trạng thái |
|-----------|---------|------------|
| Rút tiền về ngân hàng (manual escrow — admin duyệt) | Cao | `[x]` ✅ 2026-06-17 |
| Nạp tiền thật qua cổng thanh toán | Cao | `[ ] 🔒` |
| Gói VIP / Premium (phí giao dịch thấp hơn) | Trung bình | `[x]` ✅ 2026-06-17 |
| Moderator role (admin phụ chỉ xử lý dispute) | Thấp | `[x]` ✅ 2026-06-17 |
| Mobile app (React Native / Expo) | Thấp | `[ ]` |

### Phase 4 — Advanced (🔮 Tương lai xa)
| Tính năng | Mô tả |
|-----------|-------|
| AI phát hiện gian lận | Tự động flag đơn hàng có dấu hiệu lừa đảo |
| Hệ thống affiliate / Referral | Giới thiệu bạn bè — mã giới thiệu duy nhất, mới đăng ký +50K, referrer nhận 2% hoa hồng mỗi đơn | `[x]` ✅ 2026-06-18 |
| API công khai | Cho phép bên thứ 3 tích hợp SafePass |
| Multi-currency | Hỗ trợ USD, VND, v.v. |

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
- [x] Tất cả secrets lưu trong Replit Secrets (vĩnh viễn, không nhập lại) *(2026-06-15)*

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
- [x] Xác minh email — OTP 6 số gửi qua Resend *(2026-06-15)*
- [x] Quên mật khẩu — link reset gửi qua email *(2026-06-15)*
- [x] Refresh token — `POST /api/auth/refresh` *(2026-06-15)*

---

## ✅ Vé (Tickets)

- [x] `POST /api/tickets` — đăng bán vé *(2025-06-15)*
- [x] `GET /api/tickets` — lấy danh sách (search, min/max price, pagination) *(2026-06-15)*
- [x] `GET /api/tickets/:id` — chi tiết 1 vé *(2025-06-15)*
- [x] `GET /api/my-tickets` — vé của seller *(2025-06-15)*
- [x] `DELETE /api/tickets/:id` — xoá listing (chỉ khi available) *(2025-06-15)*
- [x] `PATCH /api/tickets/:id` — seller chỉnh sửa vé đã đăng *(2026-06-15)*
- [x] Phân trang (pagination) danh sách vé *(2026-06-15)*
- [x] Upload ảnh vé — Supabase Storage bucket `ticket-images` *(2026-06-15)*
- [x] Filter theo ngày sự kiện, địa điểm *(2026-06-15)*

---

## ✅ Đơn Hàng & Escrow

- [x] `POST /api/orders` — tạo đơn mua, giữ tiền escrow (+3% phí) *(2025-06-15)*
- [x] `GET /api/orders` — danh sách đơn (buyer/seller) *(2025-06-15)*
- [x] `POST /api/orders/:id/upload-qr` — seller upload QR code *(2025-06-15)*
- [x] `POST /api/orders/:id/confirm` — buyer xác nhận → giải ngân cho seller *(2025-06-15)*
- [x] Escrow timeout tự động 48h → hoàn tiền buyer *(2025-06-15)*
- [x] Chạy kiểm tra timeout mỗi 1 giờ *(2025-06-15)*
- [x] Email seller khi có đơn mua mới *(2026-06-15)*
- [x] Email buyer khi seller upload QR *(2026-06-15)*
- [x] Email seller khi buyer xác nhận (giải ngân) *(2026-06-15)*
- [x] Đếm ngược thời gian còn lại trong 48h trên giao diện buyer *(2026-06-15)*

---

## ✅ Khiếu Nại (Dispute)

- [x] `POST /api/orders/:id/dispute` — mở khiếu nại (buyer hoặc seller) *(2025-06-15)*
- [x] 5 lý do khiếu nại có sẵn *(2025-06-15)*
- [x] `POST /api/admin/orders/:id/resolve` — admin giải quyết *(2025-06-15)*
- [x] Email thông báo admin khi có khiếu nại mới *(2025-06-15)*
- [x] Email thông báo kết quả giải quyết cho buyer và seller *(2026-06-15)*
- [x] Thời hạn tự động đóng khiếu nại sau 3 ngày *(2026-06-15)*

---

## ✅ Ví & Giao Dịch (Wallet)

- [x] `POST /api/wallet/topup` — nạp tiền (giả lập) *(2025-06-15)*
- [x] `GET /api/wallet/transactions` — lịch sử giao dịch phân trang *(2026-06-15)*
- [x] `GET /api/wallet/transactions/export` — export CSV *(2026-06-15)*
- [x] Ghi log transaction cho mọi sự kiện *(2025-06-15)*
- [x] Nút Export CSV trong tab Lịch sử ví *(2026-06-15)*
- [x] Nút Tải thêm (pagination) trong tab Lịch sử ví *(2026-06-15)*
- [ ] Rút tiền từ ví về tài khoản ngân hàng (tích hợp cổng thanh toán thật) 🔒

---

## ✅ Đánh Giá (Reviews)

- [x] `POST /api/orders/:id/review` — buyer gửi đánh giá sau khi hoàn tất *(2025-06-15)*
- [x] `GET /api/users/:id/reviews` — lấy reviews của seller *(2025-06-15)*
- [x] Tự động tính avg_rating và review_count cho seller *(2025-06-15)*
- [x] `POST /api/reviews/:id/reply` — seller phản hồi review *(2026-06-15)*
- [x] Email seller khi nhận được đánh giá mới *(2026-06-15)*
- [x] Report review vi phạm *(2026-06-15)*

---

## ✅ Trang Admin

- [x] `GET /api/admin/orders` — danh sách tất cả đơn *(2025-06-15)*
- [x] `GET /api/admin/orders/:id` — chi tiết 1 đơn *(2025-06-15)*
- [x] `GET /api/admin/users` — danh sách users *(2026-06-15)*
- [x] `POST /api/admin/users/:id/ban` — khóa tài khoản *(2026-06-15)*
- [x] `POST /api/admin/users/:id/unban` — mở khóa tài khoản *(2026-06-15)*
- [x] `GET /api/admin/stats` — thống kê tổng hợp *(2026-06-15)*
- [x] `GET /api/admin/export` — xuất báo cáo orders CSV *(2026-06-15)*
- [x] `POST /api/admin/process-timeouts` — trigger escrow timeout thủ công *(2025-06-15)*
- [x] Trang `admin.html` — overview, disputes, orders, users *(2026-06-15)*
- [x] Admin Dashboard trong SPA — tab 🔐 Admin (chỉ hiện với is_admin), 4 tabs: Tổng quan/Khiếu nại/Đơn hàng/Người dùng, resolve dispute, ban/unban, verify/unverify ngay trong app *(2026-06-16)*
- [x] Admin auth email+password — bảng `admins` Supabase, `POST /api/admin/auth/setup` (tạo super_admin đầu tiên với ADMIN_SECRET), `POST /api/admin/auth/login` (email+password → JWT 12h), `POST /api/admin/auth/create` (super_admin tạo thêm admin), `GET /api/admin/me`, `GET /api/admin/admins`, `DELETE /api/admin/admins/:id`, `adminAuth` middleware *(2026-06-18)*
- [x] Audit Log — bảng `admin_logs` Supabase, `logAdminAction()` helper ghi log mọi hành động admin, `GET /api/admin/logs` (filter theo action), tab Audit Log trong admin.html *(2026-06-18)*
- [x] Admin Dashboard hoàn chỉnh — dark UI, login email+password, setup first admin, sidebar + mobile nav, topbar (admin info, role badge), 10 tabs: Dashboard/Users/Tickets/Orders/Disputes/Transactions/Withdrawals/KYC/Audit Log/Settings, dispute chat (xem + gửi tin nhắn admin), badge đếm dispute/withdrawal/KYC chờ xử lý *(2026-06-18)*
- [x] `PATCH /api/admin/tickets/:id/hide` — ẩn/hiện vé (adminAuth middleware) *(2026-06-18)*
- [x] `GET /api/admin/disputes` — danh sách dispute đang chờ (status=disputed) *(2026-06-18)*
- [x] `GET /api/admin/orders/:id/messages` + `POST /api/admin/orders/:id/messages` — admin đọc/gửi tin nhắn vào chat đơn hàng *(2026-06-18)*

---

## ✅ Email Thông Báo (Notifications)

- [x] Tích hợp Resend API *(2025-06-16)*
- [x] Email admin khi có khiếu nại mới *(2025-06-16)*
- [x] Email admin tổng hợp khi escrow timeout hàng loạt *(2025-06-16)*
- [x] Email buyer khi được hoàn tiền tự động *(2025-06-16)*
- [x] Email seller khi có đơn mua mới *(2026-06-15)*
- [x] Email buyer khi seller upload QR *(2026-06-15)*
- [x] Email seller khi giải ngân *(2026-06-15)*
- [x] Email buyer/seller khi khiếu nại được giải quyết *(2026-06-15)*
- [x] Email seller khi nhận được đánh giá mới *(2026-06-15)*
- [x] ⚡ Thông báo trong app (bell icon) — real-time notification feed cho user *(2026-06-15)*

---

## ✅ Giao Diện Frontend

- [x] Dark UI premium (SafePass v13) *(2025-06-15)*
- [x] Trang Marketplace (xem vé, tìm kiếm, lọc giá) *(2025-06-15)*
- [x] Trang Ví (wallet overview + lịch sử phân trang + export CSV) *(2026-06-15)*
- [x] Trang My Orders (đơn mua + đơn bán) *(2025-06-15)*
- [x] Modal đăng nhập / đăng ký *(2025-06-16)*
- [x] Trang Hồ sơ *(2026-06-15)*
- [x] Responsive mobile *(2026-06-15)*
- [x] Dark/light mode toggle *(2026-06-15)*
- [x] ⚡ Trang profile công khai của seller (xem vé đang bán + đánh giá) tại `/seller/:id` ✅ 2026-06-15
- [x] Seller dashboard — tab riêng hiển thị doanh thu, đơn hàng, rating theo thời gian ✅ 2026-06-15

---

## 🚧 Phase 2 — Việc Cần Build Tiếp (theo thứ tự ưu tiên)

> Agent: đây là danh sách `[ ]` cần build. Đọc từ trên xuống, build lần lượt.

- [x] ⚡ Thông báo trong app — bell icon, `GET /api/notifications`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`, bảng `notifications` Supabase, unread badge, dropdown 20 thông báo, đánh dấu đã đọc, polling 30s *(2026-06-15)*
- [x] ⚡ Trang profile công khai seller — `GET /api/users/:id` + `GET /api/users/:id/listings`, trang `seller_profile` với avatar holographic, trust score, stats, vé đang bán, reviews + rating bars *(2026-06-15)*
- [x] Seller dashboard analytics — tab "📊 Thống kê" trong Orders: `GET /api/seller/stats`, 6 stat cards, biểu đồ bar+line Chart.js 30 ngày, top sự kiện doanh thu cao nhất *(2026-06-15)*
- [x] Xác minh seller (verified badge) — admin có thể mark seller là verified, hiển thị ✓ badge xanh trên listing vé và profile _(Hoàn thành 16/06/2026 — backend verify/unverify API, admin page trong SPA với secret input, badge trên grid/list card, is_admin từ /api/auth/me)_
- [x] Tìm kiếm nâng cao — cột `category` trên tickets, filter dropdown danh mục (concerts/kpop/sports/festivals/other), API `GET /api/tickets?category=...`, sell form lưu category, `selectCategory()` reload API khi đổi tab *(2026-06-17)*
- [x] Chat nội bộ trong đơn hàng — `GET /api/orders/:id/messages`, `POST /api/orders/:id/messages`, bảng `order_messages` Supabase, polling 5s, real orders dùng API thật, demo orders dùng local simulation, stop polling khi rời trang *(2026-06-17)*
- [x] ⚡ Multi-category marketplace — nâng cấp từ ticket-only lên 6 loại listing: ticket/product/account/course/service/booking. Bảng `listings` mới (backward compatible với tickets), API CRUD `/api/listings`, sell form 3 bước với type selector 6 loại + type-adaptive fields + checklist riêng cho từng loại, frontend merge cả tickets lẫn listings, admin panel tab Listings mới với filter theo type/status, hide/delete actions *(2026-06-18)*

---

## ⚠️ Cần Chạy Migration trong Supabase SQL Editor

> **Multi-category marketplace (2026-06-18):** Chạy toàn bộ file `listings_migration.sql` trước khi test tạo listing mới.

```sql
-- 0. Cột image_url cho tickets
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS image_url text;

-- 0c. Cột category cho tickets (tìm kiếm nâng cao)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category text default 'concerts';
CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category);

-- 7. Bảng order_messages (chat nội bộ trong đơn hàng)
CREATE TABLE IF NOT EXISTS order_messages (
  id uuid default gen_random_uuid() primary key,
  order_id uuid references orders(id) on delete cascade,
  sender_id uuid references users(id),
  sender_name text,
  text text not null,
  created_at timestamptz default now()
);
ALTER TABLE order_messages DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_order_messages_order ON order_messages(order_id, created_at ASC);

-- 0b. Cột report cho reviews
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reported boolean default false;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS report_reason text;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reported_by uuid;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reported_at timestamptz;

-- 1. Cột is_banned
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned boolean default false;

-- 2. Cột email
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;

-- 3. Cột dispute vào orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_reason text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_description text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_opened_by text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_opened_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_resolved_by text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_resolved_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_note text;

-- 5. Cột VIP cho users (Gói VIP/Premium)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_vip boolean default false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_expires_at timestamptz;

-- 6. Cột Moderator cho users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_moderator boolean default false;

-- 4. Bảng reviews
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

-- 5. Bảng notifications (Phase 2)
CREATE TABLE IF NOT EXISTS notifications (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text,
  is_read boolean default false,
  created_at timestamptz default now()
);
ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

-- 6. Index tối ưu hiệu năng
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);

-- 7. Bảng withdrawal_requests (Phase 3 — Rút tiền)
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references users(id),
  user_name text,
  user_phone text,
  amount bigint not null,
  bank_name text not null,
  account_number text not null,
  account_holder text not null,
  status text default 'pending',
  admin_note text,
  processed_at timestamptz,
  created_at timestamptz default now()
);
ALTER TABLE withdrawal_requests DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawal_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawal_requests(status, created_at DESC);
```

---

## ✅ KYC — Xác Minh Danh Tính (Phase 2)

- [x] Bảng `kyc_requests` Supabase (user_id, status, front/back/selfie URL, reviewed_by, note) *(2026-06-17)*
- [x] Supabase Storage bucket `kyc-documents` (private) *(2026-06-17)*
- [x] `POST /api/kyc/submit` — upload 3 ảnh (CCCD mặt trước/sau + selfie) *(2026-06-17)*
- [x] `GET /api/kyc/status` — user kiểm tra trạng thái KYC của mình *(2026-06-17)*
- [x] `GET /api/admin/kyc` — admin xem danh sách KYC pending *(2026-06-17)*
- [x] `POST /api/admin/kyc/:id/approve` — duyệt KYC, set is_verified=true *(2026-06-17)*
- [x] `POST /api/admin/kyc/:id/reject` — từ chối KYC, ghi note *(2026-06-17)*
- [x] Tab KYC trong admin.html — xem danh sách, modal viewer ảnh signed URL, approve/reject *(2026-06-17)*
- [x] Section KYC trong trang Profile người dùng — upload 3 ảnh, trạng thái pending/approved/rejected *(2026-06-17)*

---

## ✅ QR Xác Minh Vé (Phase 2)

- [x] Bảng `ticket_scans` Supabase (order_id, scanned_by, scanner_type, scanned_at, scan_count) *(2026-06-17)*
- [x] Package `qrcode` (npm) — tạo QR PNG dạng data URL *(2026-06-17)*
- [x] `GET /api/orders/:id/verify-qr` — tạo JWT QR token (payload: oid, p:'tv'), trả về data URL QR + metadata *(2026-06-17)*
- [x] `POST /api/scan/auth` — xác thực scanner (ADMIN_SECRET → admin | SCANNER_CODE env → organizer) *(2026-06-17)*
- [x] `POST /api/scan/verify` — giải mã JWT, check order hợp lệ, chống dùng lại (ticket_scans table), ghi log *(2026-06-17)*
- [x] `GET /api/scan/history` — admin xem lịch sử quét (yêu cầu ADMIN_SECRET) *(2026-06-17)*
- [x] `frontend/scanner.html` — trang quét độc lập: login (mã truy cập + tên), camera QR (html5-qrcode), nhập thủ công, kết quả overlay (VALID/USED/INVALID), lịch sử phiên *(2026-06-17)*
- [x] Admin tab "📷 QR Scanner" — link mở scanner.html, 2 info cards, bảng lịch sử scan từ DB *(2026-06-17)*
- [x] "🔐 SafePass QR Xác minh" section trong chi tiết đơn (index.html) — nút "Xem QR", show/hide QR img, nút "Lưu QR" download PNG *(2026-06-17)*

> ⚠️ Cần chạy migration SQL (xem bên dưới) trước khi dùng KYC và QR Scanner

---

## ⚠️ Migration Mới Cần Chạy (KYC + QR Scanner)

```sql
-- Bảng KYC
CREATE TABLE IF NOT EXISTS kyc_requests (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references users(id) on delete cascade,
  status text default 'pending',
  front_url text,
  back_url text,
  selfie_url text,
  submitted_at timestamptz default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  note text
);
ALTER TABLE kyc_requests DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_kyc_user ON kyc_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_requests(status, submitted_at DESC);

-- Bảng Ticket Scans
CREATE TABLE IF NOT EXISTS ticket_scans (
  id uuid default gen_random_uuid() primary key,
  order_id uuid references orders(id) on delete cascade,
  scanned_by text,
  scanner_type text default 'organizer',
  scanned_at timestamptz default now(),
  scan_count int default 1
);
ALTER TABLE ticket_scans DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_ticket_scans_order ON ticket_scans(order_id);
CREATE INDEX IF NOT EXISTS idx_ticket_scans_time ON ticket_scans(scanned_at DESC);
```

---

## 📌 Ghi Chú Kỹ Thuật

| Mục | Chi tiết |
|-----|----------|
| Runtime | Node.js 20 + ES Modules |
| Port | 5000 (webview Replit) |
| Database | Supabase (PostgreSQL) |
| Auth | JWT + bcryptjs (phone + password) |
| Email | Resend API (`onboarding@resend.dev`) |
| Frontend | Vanilla JS + HTML + CSS (SPA) |
| Security | Helmet.js, bcrypt, rate-limit, sanitize() |
| Secrets | Lưu trong Replit Secrets — vĩnh viễn, không cần nhập lại |

---

*Cập nhật lần cuối: 2026-06-17 — Rút tiền (manual escrow admin duyệt) + Gói VIP/Premium + Moderator role*
