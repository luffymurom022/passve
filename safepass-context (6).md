# 🎟 SafePass — Context Handoff

## Dự án là gì
SafePass — marketplace mua bán vé secondhand an toàn tại Việt Nam.
Cơ chế chính: escrow giữ tiền người mua cho đến khi vé được xác minh, rồi giải ngân cho người bán.

## Stack kỹ thuật
- Frontend: file HTML đơn lẻ `index.html` + `admin.html` — deploy trên Netlify
- Backend: Express.js + Node.js, deploy trên Railway
- Database: Supabase (PostgreSQL)

## URLs
- Frontend: timely-cocada-d38aff.netlify.app (site mới thay lustrous-fudge-da6e3c)
- Backend: https://passve.up.railway.app
- Supabase: https://cufumelgmdvzqxzfnknj.supabase.co
- Admin Dashboard: timely-cocada-d38aff.netlify.app/admin

## Tài khoản test
- Buyer: SĐT 099123457 / pass 1
- Seller: SĐT 099123456 / pass 1

## Admin
- ADMIN_SECRET: `admin123` (Railway Variables → passve-backend)
- Login: vào /admin → nhập secret → vào thẳng (không verify qua API)
- Secret gửi qua header `x-admin-secret` trong mọi admin request

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
- [x] Admin dashboard — file `admin.html` riêng deploy cùng Netlify
- [x] Admin routes thêm vào backend: GET /admin/orders, GET /admin/orders/:id, GET /admin/users
- [x] adminHeaders() gửi `x-admin-secret` header trong mọi request
- [x] Admin dashboard tự load disputes + orders từ API khi login
- [x] Stat cards hiện số thật (disputes, escrow đang mở, tổng đơn)
- [x] Tab Khiếu nại hiện danh sách disputed orders thật
- [x] Tab Đơn hàng hiện bảng tất cả orders thật

## Vấn đề còn tồn đọng
- [ ] Admin actions (resolve dispute, trigger timeout) vẫn bị 403 khi gọi qua header `x-admin-secret` — đã thêm routes vào server.js, commit "fFix 403 admin actions" đã push lên Railway (deploy 2:42 AM), nhưng vẫn 403. Nghi vấn: Railway proxy hoặc CORS strip custom headers. Chưa tìm ra root cause.

## Ghi chú kỹ thuật quan trọng

### Admin secret flow
- Frontend gửi secret qua: `x-admin-secret` header + `?secret=` query param + body `{secret}`
- Backend đọc: `req.query?.secret || req.headers['x-admin-secret'] || req.body?.secret`
- `adminHeaders()` trong admin.html: `{ 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET }`
- Vẫn 403 dù đúng secret → khả năng Railway strip custom headers

### Admin routes (đã thêm vào server.js)
```
GET  /api/admin/orders              → list orders (filter by ?status=)
GET  /api/admin/orders/:id          → single order detail
GET  /api/admin/users               → list users
POST /api/admin/orders/:id/resolve  → resolve dispute
POST /api/admin/process-timeouts    → trigger escrow timeout thủ công
```

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
- Route admin: `POST /api/admin/process-timeouts`

### Dispute flow
- `POST /api/orders/:id/dispute` — buyer hoặc seller mở, body: `{reason_index, description}`
- Tiền escrow giữ nguyên, status → `disputed`
- Admin resolve: `POST /api/admin/orders/:id/resolve`
  - body: `{secret, winner: "buyer"|"seller", note: "..."}`

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
POST   /api/auth/register
POST   /api/auth/login
GET    /api/auth/me

GET    /api/tickets                   → danh sách vé available
POST   /api/tickets                   → đăng bán vé
GET    /api/tickets/:id
DELETE /api/tickets/:id               → xoá listing (chỉ available)
GET    /api/my-tickets                → danh sách vé của seller

POST   /api/orders                    → tạo đơn mua
GET    /api/orders/:id
POST   /api/orders/:id/upload-qr
POST   /api/orders/:id/confirm
POST   /api/orders/:id/dispute

GET    /api/wallet/transactions
POST   /api/wallet/topup

POST   /api/reviews
GET    /api/users/:id/reviews

GET    /api/admin/orders
GET    /api/admin/orders/:id
GET    /api/admin/users
POST   /api/admin/orders/:id/resolve
POST   /api/admin/process-timeouts
```

## Netlify account
- Site cũ: lustrous-fudge-da6e3c.netlify.app — mất access (quên Gmail ẩn danh)
- Site mới: timely-cocada-d38aff.netlify.app — đang dùng
- Deploy bằng kéo thả folder `frontend/` vào Netlify UI

## Làm tiếp
- Debug 403 admin actions — thử đổi CORS config trên Railway cho phép custom headers, hoặc test bằng Postman để isolate vấn đề
