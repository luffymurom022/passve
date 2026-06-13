ĐỌC CONTENT BÊN DƯỚI XONG VÀ TIẾP TỤC MỤC TRẠNG THÁI

# 🎟 SafePass — Context Handoff

## Dự án là gì
SafePass — marketplace mua bán vé secondhand an toàn tại Việt Nam.
Cơ chế chính: escrow giữ tiền người mua cho đến khi vé được xác minh, rồi giải ngân cho người bán.

## Stack kỹ thuật
- Frontend: file HTML đơn lẻ `index.html` — deploy trên Netlify
- Backend: Express.js + Node.js, deploy trên Railway
- Database: Supabase (PostgreSQL)

## URLs
- Frontend: lustrous-fudge-da6e3c.netlify.app (site mới, cập nhật nếu đổi)
- Backend: https://passve.up.railway.app
- Supabase: https://cufumelgmdvzqxzfnknj.supabase.co
- Admin Dashboard: lustrous-fudge-da6e3c.netlify.app/admin

## Tài khoản test
- Buyer: SĐT 099123457 / pass 1
- Seller: SĐT 099123456 / pass 1

## Admin
- ADMIN_SECRET: hiện là `admin123` (đổi trong Railway Variables)
- Login: vào /admin → nhập secret → vào thẳng (không verify qua API)
- Các action (resolve dispute, trigger timeout) gọi API với secret trong body

## Trạng thái
- [x] Đăng ký / đăng nhập
- [x] Nạp tiền vào ví
- [x] Đăng bán vé
- [x] Mua vé → trừ balance → vào Escrow
- [x] Seller upload QR → lưu database
- [x] Buyer xác nhận → tiền giải ngân
- [x] Fix: balance check >= price + phí 3% (frontend + backend)
- [x] Fix: confirmReceived() gọi confirmOrderAPI() thay vì update local
- [x] Escrow timeout 48h — backend tự hoàn tiền, frontend hiện countdown
- [x] Refresh balance sau khi mua / confirm (hàm refreshBalance() dùng chung)
- [x] Wallet history tab load từ API thật (/wallet/transactions)
- [x] Seller polling 30s — thông báo + badge khi có đơn mới
- [x] Dispute flow — buyer/seller mở khiếu nại, escrow giữ nguyên, admin resolve
- [x] Trang quản lý vé seller — tab "Vé của tôi" trong trang Bán, xoá listing
- [x] Seller rating — submitReview() gọi API thật, lưu bảng reviews, tính lại avg_rating + review_count cho seller
- [x] Rate limiting — auth 10/15min, orders 5/min, topup 10/h, general 100/15min
- [x] Tìm kiếm realtime — debounce 350ms gọi API /tickets?search=, merge kết quả vào ALL_LISTINGS
- [x] Admin dashboard — file `admin.html` riêng deploy cùng Netlify, login không verify API, resolve disputes bằng Order ID, trigger escrow timeout, xem tickets

## Vấn đề còn tồn đọng
- [ ] Admin actions (resolve dispute, trigger timeout) vẫn bị 403 — Railway Edge strip body hoặc backend chưa đọc `req.body?.secret` đúng cách. Cần debug thêm hoặc đổi cơ chế auth admin (dùng query param thay vì body/header)

## Ghi chú kỹ thuật quan trọng

### Sell page tabs
- `state.sellTab`: `'listings'` (mặc định) | `'new'`
- Tab "Vé của tôi" load từ `GET /api/my-tickets`, render inline sau khi switch
- Sau đăng bán thành công → `loadMyTicketsFromAPI()` rồi `setState({sellTab:'listings'})`
- Nút xoá 🗑 chỉ hiện khi `status === 'available'`

### refreshBalance()
Hàm async dùng chung, gọi sau mọi thao tác thay đổi balance:
```js
await refreshBalance(); // gọi /auth/me, cập nhật currentUser + header
```

### Escrow timeout (backend)
- Hàm `processExpiredEscrows()` chạy khi boot + mỗi 1 giờ
- Query orders có `status = 'waiting_qr'` và `created_at < now - 48h`
- Hoàn tiền buyer, mở lại vé, đổi status → `refunded`
- Route admin: `POST /api/admin/process-timeouts` — đọc secret từ `req.headers['x-admin-secret'] || req.body?.secret`

### Dispute flow
- `POST /api/orders/:id/dispute` — buyer hoặc seller mở, body: `{reason_index, description}`
- Tiền escrow giữ nguyên, status → `disputed`
- Admin resolve: `POST /api/admin/orders/:id/resolve`
  - body: `{secret, winner: "buyer"|"seller", note: "..."}`

### Admin Dashboard (admin.html)
- Deploy cùng Netlify với index.html
- Login không gọi API verify — nhập secret vào là vào thẳng
- Secret gửi trong request body khi gọi admin endpoints
- Cần thêm vào backend để dùng đầy đủ:
  - `GET /api/admin/orders?status=disputed`
  - `GET /api/admin/orders/:id`
  - `GET /api/admin/users`

### Seller polling (frontend)
- `startPolling()` gọi sau login và boot, `pollSellerOrders()` chạy mỗi 30s

### Status mapping (frontend ↔ backend)
```
waiting_qr       → awaiting_seller
waiting_confirm  → ticket_uploaded
completed        → completed
disputed         → disputed
refunded         → refunded
```

### Transaction types
`topup`, `escrow_lock`, `escrow_release`, `payout`, `refund`, `fee`, `dispute_opened`, `dispute_closed`

### API routes (backend)
```
GET    /api/my-tickets                → danh sách vé của seller
DELETE /api/tickets/:id               → xoá listing (chỉ available)
POST   /api/orders/:id/dispute        → mở khiếu nại
POST   /api/admin/orders/:id/resolve  → admin giải quyết dispute
POST   /api/admin/process-timeouts    → trigger escrow timeout thủ công

-- Cần thêm: --
GET    /api/admin/orders              → list orders (filter by status)
GET    /api/admin/orders/:id          → single order detail
GET    /api/admin/users               → list users
```

## làm tiếp #8
