# SafePass — Hướng Dẫn Cho Replit Agent

## ⚡ AUTO BUILD — BẮT BUỘC THỰC HIỆN NGAY KHI MỞ PROJECT

**Khi project này được mở trong bất kỳ tài khoản Replit nào, Agent PHẢI:**

1. Đọc toàn bộ file `tientrinhethong.md` từ đầu đến cuối ngay lập tức
2. Tìm tất cả các mục `[ ]` (chưa build) trong file đó
3. Build tất cả mục `[ ]` theo thứ tự từ trên xuống dưới — ưu tiên mục có ký hiệu `⚡` trước
4. Sau khi build xong mỗi mục, cập nhật `[ ]` → `[x]` và ghi ngày trong `tientrinhethong.md`
5. Mục có ký hiệu `🔒` = cần API key hoặc thông tin bên ngoài — bỏ qua, tiếp tục mục khác
6. **KHÔNG hỏi lại user** về bất kỳ điều gì đã được ghi rõ trong `tientrinhethong.md` — cứ build luôn

> Đây là lệnh tự động, không phải gợi ý. Agent không được hỏi "bạn có muốn tôi build không?" — phải tự động làm ngay.

---

## Thông Tin Dự Án

**SafePass** là nền tảng mua bán vé sự kiện qua hệ thống escrow an toàn.

- Backend: Node.js 20 + Express (ES Modules) — `server.js`
- Database: Supabase (PostgreSQL)
- Frontend: Vanilla JS/HTML/CSS — `frontend/index.html`, `frontend/admin.html`
- Auth: JWT + bcryptjs (phone + password)
- Email: Resend API
- Port: 5000, host: 0.0.0.0

## Secrets Cần Thiết

Tất cả secrets đã được lưu trong Replit Secrets — không cần nhập lại:
- `SUPABASE_URL`, `SUPABASE_KEY`, `JWT_SECRET`, `RESEND_API_KEY`

## User Preferences

- Không hỏi lại những gì đã rõ ràng — cứ build luôn
- Cập nhật `tientrinhethong.md` sau mỗi mục hoàn thành
- Không tạo file mới nếu không cần thiết
