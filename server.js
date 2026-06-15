import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ws from 'ws';
import { Resend } from 'resend';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
app.use(cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret'],
}));
app.use(express.json());

// ── RATE LIMITING ──
const generalLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 phút
  max: 100,
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // tối đa 10 lần login/register mỗi 15 phút
  message: { error: 'Quá nhiều lần thử đăng nhập, vui lòng thử lại sau 15 phút.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const orderLimit = rateLimit({
  windowMs: 60 * 1000, // 1 phút
  max: 5, // tối đa 5 đơn/phút (chống spam mua)
  message: { error: 'Quá nhiều yêu cầu, vui lòng chờ một chút.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const topupLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 giờ
  max: 10, // tối đa 10 lần nạp/giờ
  message: { error: 'Quá nhiều lần nạp tiền, vui lòng thử lại sau.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth', authLimit);
app.use('/api/orders', orderLimit);
app.use('/api/wallet/topup', topupLimit);
app.use('/api', generalLimit);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  realtime: { transport: ws }
});
const JWT_SECRET = process.env.JWT_SECRET;
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendDisputeNotification(order, reasonText, openedBy, description) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) return;
  try {
    await resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: process.env.ADMIN_EMAIL,
      subject: `⚠️ Khiếu nại mới — ${order.event_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#06090f;color:#e8edf8;padding:32px;border-radius:12px;">
          <h2 style="color:#f5a623;margin-bottom:4px;">⚠️ Khiếu nại mới cần xử lý</h2>
          <p style="color:#7b8fad;margin-top:0;">SafePass Admin Notification</p>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#7b8fad;width:140px;">Đơn hàng ID</td><td style="color:#e8edf8;font-family:monospace;">${order.id}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Sự kiện</td><td style="color:#e8edf8;">${order.event_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Người mua</td><td style="color:#e8edf8;">${order.buyer_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Người bán</td><td style="color:#e8edf8;">${order.seller_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Giá trị</td><td style="color:#e8edf8;">${order.total?.toLocaleString('vi-VN')}đ</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Mở bởi</td><td style="color:#e8edf8;">${openedBy === 'buyer' ? '🧑 Người mua' : '🏪 Người bán'}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Lý do</td><td style="color:#f5a623;">${reasonText}</td></tr>
            ${description ? `<tr><td style="padding:8px 0;color:#7b8fad;vertical-align:top;">Mô tả</td><td style="color:#e8edf8;">${description}</td></tr>` : ''}
          </table>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <p style="color:#7b8fad;font-size:14px;">Đăng nhập vào <a href="${process.env.APP_URL || ''}/admin.html" style="color:#3d8ef8;">trang Admin</a> để xử lý khiếu nại này.</p>
        </div>
      `
    });
    console.log(`[Email] Đã gửi thông báo khiếu nại đến ${process.env.ADMIN_EMAIL}`);
  } catch (e) {
    console.error('[Email] Lỗi gửi email:', e.message);
  }
}

// ── MIDDLEWARE xác thực token ──
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token không hợp lệ' });
  }
}

// ════════════════════════════════
//  AUTH
// ════════════════════════════════

// Đăng ký
app.post('/api/auth/register', async (req, res) => {
  const { phone, password, name } = req.body;
  if (!phone || !password || !name)
    return res.status(400).json({ error: 'Thiếu thông tin' });

  const { data: existing } = await supabase
    .from('users').select('id').eq('phone', phone).single();
  if (existing) return res.status(400).json({ error: 'Số điện thoại đã tồn tại' });

  const hashed = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users').insert({
    phone, password: hashed, name, balance: 0, escrow: 0
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  const token = jwt.sign({ id: data.id, phone, name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: data.id, phone, name, balance: 0, escrow: 0 } });
});

// Đăng nhập
app.post('/api/auth/login', async (req, res) => {
  const { phone, password } = req.body;
  const { data: user } = await supabase
    .from('users').select('*').eq('phone', phone).single();
  if (!user) return res.status(400).json({ error: 'Số điện thoại không tồn tại' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Sai mật khẩu' });

  const token = jwt.sign(
    { id: user.id, phone: user.phone, name: user.name },
    JWT_SECRET, { expiresIn: '30d' }
  );
  res.json({ token, user: { id: user.id, phone: user.phone, name: user.name, balance: user.balance, escrow: user.escrow } });
});

// Lấy thông tin user hiện tại
app.get('/api/auth/me', auth, async (req, res) => {
  const { data } = await supabase
    .from('users').select('id,phone,name,balance,escrow').eq('id', req.user.id).single();
  res.json(data);
});

// ════════════════════════════════
//  VÉ
// ════════════════════════════════

// Đăng bán vé
app.post('/api/tickets', auth, async (req, res) => {
  const { event_name, event_date, location, section, price, quantity, description } = req.body;
  if (!event_name || !price || !quantity)
    return res.status(400).json({ error: 'Thiếu thông tin vé' });

  const { data, error } = await supabase.from('tickets').insert({
    seller_id: req.user.id,
    seller_name: req.user.name,
    event_name, event_date, location, section,
    price: Number(price),
    quantity: Number(quantity),
    description,
    status: 'available'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Lấy danh sách vé
app.get('/api/tickets', async (req, res) => {
  const { search, min_price, max_price } = req.query;
  let query = supabase.from('tickets').select('*').eq('status', 'available').order('created_at', { ascending: false });

  if (search) query = query.ilike('event_name', `%${search}%`);
  if (min_price) query = query.gte('price', Number(min_price));
  if (max_price) query = query.lte('price', Number(max_price));

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Lấy chi tiết 1 vé
app.get('/api/tickets/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('tickets').select('*').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'Không tìm thấy vé' });
  res.json(data);
});

// Vé của tôi (seller)
app.get('/api/my-tickets', auth, async (req, res) => {
  const { data } = await supabase
    .from('tickets').select('*').eq('seller_id', req.user.id).order('created_at', { ascending: false });
  res.json(data || []);
});

// Xoá listing (chỉ khi available)
app.delete('/api/tickets/:id', auth, async (req, res) => {
  const { data: ticket } = await supabase
    .from('tickets').select('*').eq('id', req.params.id).single();

  if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
  if (ticket.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (ticket.status !== 'available') return res.status(400).json({ error: 'Chỉ có thể xoá vé chưa có đơn đặt' });

  await supabase.from('tickets').delete().eq('id', req.params.id);
  res.json({ message: 'Đã xoá listing' });
});

// ════════════════════════════════
//  ĐƠN HÀNG / ESCROW
// ════════════════════════════════

// Tạo đơn mua vé (giữ tiền escrow)
app.post('/api/orders', auth, async (req, res) => {
  const { ticket_id } = req.body;

  // Lấy thông tin vé
  const { data: ticket } = await supabase
    .from('tickets').select('*').eq('id', ticket_id).single();
  if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
  if (ticket.status !== 'available') return res.status(400).json({ error: 'Vé không còn available' });
  if (ticket.seller_id === req.user.id) return res.status(400).json({ error: 'Không thể mua vé của chính mình' });

  // Kiểm tra số dư người mua (phải đủ giá vé + phí 3%)
  const { data: buyer } = await supabase
    .from('users').select('*').eq('id', req.user.id).single();

  const fee = Math.round(ticket.price * 0.03);
  const total = ticket.price + fee;

  if (buyer.balance < total)
    return res.status(400).json({ error: `Số dư không đủ. Cần ${total.toLocaleString()}đ (gồm phí 3%), hiện có ${buyer.balance.toLocaleString()}đ` });

  // Trừ tiền buyer → escrow
  await supabase.from('users').update({
    balance: buyer.balance - total,
    escrow: buyer.escrow + total
  }).eq('id', req.user.id);

  // Khoá vé
  await supabase.from('tickets').update({ status: 'pending' }).eq('id', ticket_id);

  // Tạo đơn
  const { data: order, error } = await supabase.from('orders').insert({
    ticket_id,
    buyer_id: req.user.id,
    buyer_name: req.user.name,
    seller_id: ticket.seller_id,
    seller_name: ticket.seller_name,
    event_name: ticket.event_name,
    price: ticket.price,
    fee,
    total,
    status: 'waiting_qr'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Ghi transaction
  await supabase.from('transactions').insert({
    user_id: req.user.id,
    type: 'escrow_lock',
    amount: -total,
    description: `Đặt cọc mua vé: ${ticket.event_name}`,
    order_id: order.id
  });

  res.json(order);
});

// Lấy danh sách đơn (mua + bán)
app.get('/api/orders', auth, async (req, res) => {
  const { role } = req.query; // 'buyer' hoặc 'seller'
  let query = supabase.from('orders').select('*, tickets(section, event_date, location)').order('created_at', { ascending: false });

  if (role === 'seller') query = query.eq('seller_id', req.user.id);
  else query = query.eq('buyer_id', req.user.id);

  const { data } = await query;
  res.json(data || []);
});

// Seller upload QR
app.post('/api/orders/:id/upload-qr', auth, async (req, res) => {
  const { qr_code } = req.body;
  const { data: order } = await supabase
    .from('orders').select('*').eq('id', req.params.id).single();

  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (order.status !== 'waiting_qr') return res.status(400).json({ error: 'Đơn không ở trạng thái chờ QR' });

  await supabase.from('orders').update({
    qr_code,
    status: 'waiting_confirm'
  }).eq('id', req.params.id);

  res.json({ message: 'Đã upload QR, chờ người mua xác nhận' });
});

// Buyer xác nhận nhận vé → giải ngân
app.post('/api/orders/:id/confirm', auth, async (req, res) => {
  const { data: order } = await supabase
    .from('orders').select('*').eq('id', req.params.id).single();

  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (order.status !== 'waiting_confirm') return res.status(400).json({ error: 'Đơn chưa có QR để xác nhận' });

  // Lấy thông tin
  const { data: buyer } = await supabase.from('users').select('*').eq('id', order.buyer_id).single();
  const { data: seller } = await supabase.from('users').select('*').eq('id', order.seller_id).single();

  // Giải ngân: escrow → seller (trừ phí)
  await supabase.from('users').update({
    escrow: buyer.escrow - order.total,
  }).eq('id', order.buyer_id);

  await supabase.from('users').update({
    balance: seller.balance + order.price  // seller nhận giá vé, phí đã trừ
  }).eq('id', order.seller_id);

  // Cập nhật đơn + vé
  await supabase.from('orders').update({ status: 'completed' }).eq('id', order.id);
  await supabase.from('tickets').update({ status: 'sold' }).eq('id', order.ticket_id);

  // Ghi transactions
  await supabase.from('transactions').insert([
    {
      user_id: order.seller_id,
      type: 'payout',
      amount: order.price,
      description: `Nhận tiền bán vé: ${order.event_name}`,
      order_id: order.id
    },
    {
      user_id: order.buyer_id,
      type: 'escrow_release',
      amount: 0,
      description: `Xác nhận nhận vé: ${order.event_name}`,
      order_id: order.id
    }
  ]);

  res.json({ message: 'Xác nhận thành công! Tiền đã được giải ngân cho người bán.' });
});

// ════════════════════════════════
//  VÍ / NẠP TIỀN (giả lập)
// ════════════════════════════════

app.post('/api/wallet/topup', auth, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 10000) return res.status(400).json({ error: 'Số tiền tối thiểu 10,000đ' });

  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  await supabase.from('users').update({ balance: user.balance + Number(amount) }).eq('id', req.user.id);

  await supabase.from('transactions').insert({
    user_id: req.user.id,
    type: 'topup',
    amount: Number(amount),
    description: 'Nạp tiền vào ví'
  });

  res.json({ message: `Nạp ${Number(amount).toLocaleString()}đ thành công`, balance: user.balance + Number(amount) });
});

app.get('/api/wallet/transactions', auth, async (req, res) => {
  const { data } = await supabase
    .from('transactions').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
  res.json(data || []);
});




// ════════════════════════════════
//  REVIEWS
// ════════════════════════════════

// Buyer gửi đánh giá seller sau khi hoàn tất
app.post('/api/orders/:id/review', auth, async (req, res) => {
  const { rating, text } = req.body;
  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Rating phải từ 1-5' });
  if (!text || text.trim().length < 20)
    return res.status(400).json({ error: 'Đánh giá phải ít nhất 20 ký tự' });

  const { data: order } = await supabase
    .from('orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (order.status !== 'completed') return res.status(400).json({ error: 'Chỉ đánh giá được đơn đã hoàn tất' });

  // Kiểm tra đã review chưa
  const { data: existing } = await supabase
    .from('reviews').select('id').eq('order_id', req.params.id).single();
  if (existing) return res.status(400).json({ error: 'Bạn đã đánh giá đơn này rồi' });

  const { data: review, error } = await supabase.from('reviews').insert({
    order_id: order.id,
    buyer_id: order.buyer_id,
    buyer_name: req.user.name,
    seller_id: order.seller_id,
    event_name: order.event_name,
    rating: Number(rating),
    text: text.trim()
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Cập nhật rating trung bình của seller trong users table
  const { data: allReviews } = await supabase
    .from('reviews').select('rating').eq('seller_id', order.seller_id);
  if (allReviews && allReviews.length > 0) {
    const avg = allReviews.reduce((s, r) => s + r.rating, 0) / allReviews.length;
    await supabase.from('users').update({
      avg_rating: Math.round(avg * 10) / 10,
      review_count: allReviews.length
    }).eq('id', order.seller_id);
  }

  res.json(review);
});

// Lấy reviews của 1 seller
app.get('/api/users/:id/reviews', async (req, res) => {
  const { data } = await supabase
    .from('reviews').select('*').eq('seller_id', req.params.id)
    .order('created_at', { ascending: false }).limit(20);
  res.json(data || []);
});

// ════════════════════════════════
//  DISPUTE
// ════════════════════════════════

const DISPUTE_REASONS = [
  'QR không hợp lệ / không quét được',
  'Sai sự kiện / sai khu vực ghế',
  'Chưa nhận được vé',
  'QR bị sử dụng trước',
  'Lý do khác'
];

// Mở dispute (buyer hoặc seller)
app.post('/api/orders/:id/dispute', auth, async (req, res) => {
  const { reason_index, description } = req.body;
  const { data: order } = await supabase
    .from('orders').select('*').eq('id', req.params.id).single();

  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });

  const isBuyer = order.buyer_id === req.user.id;
  const isSeller = order.seller_id === req.user.id;
  if (!isBuyer && !isSeller) return res.status(403).json({ error: 'Không có quyền' });

  const allowedStatuses = ['waiting_qr', 'waiting_confirm'];
  if (!allowedStatuses.includes(order.status))
    return res.status(400).json({ error: 'Không thể khiếu nại ở trạng thái này' });

  if (order.status === 'disputed')
    return res.status(400).json({ error: 'Đơn đã có khiếu nại đang xử lý' });

  const reasonText = DISPUTE_REASONS[Number(reason_index)] || 'Lý do khác';
  const openedBy = isBuyer ? 'buyer' : 'seller';

  await supabase.from('orders').update({
    status: 'disputed',
    dispute_reason: reasonText,
    dispute_description: description || '',
    dispute_opened_by: openedBy,
    dispute_opened_at: new Date().toISOString()
  }).eq('id', req.params.id);

  // Ghi transaction (escrow vẫn giữ nguyên)
  await supabase.from('transactions').insert({
    user_id: req.user.id,
    type: 'dispute_opened',
    amount: 0,
    description: `Mở khiếu nại: ${order.event_name} — ${reasonText}`,
    order_id: order.id
  });

  // Gửi email thông báo cho admin (không chặn response)
  sendDisputeNotification(order, reasonText, openedBy, description);

  res.json({ message: 'Khiếu nại đã được gửi. Đội hỗ trợ sẽ phản hồi trong 24h.' });
});

// Admin resolve dispute → chọn bên thắng
app.post('/api/admin/orders/:id/resolve', async (req, res) => {
  const secret = req.query?.secret || req.headers['x-admin-secret'] || req.body?.secret;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const { winner, note } = req.body; // winner: 'buyer' | 'seller'
  if (!['buyer', 'seller'].includes(winner))
    return res.status(400).json({ error: 'winner phải là buyer hoặc seller' });

  const { data: order } = await supabase
    .from('orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.status !== 'disputed') return res.status(400).json({ error: 'Đơn không đang ở trạng thái disputed' });

  const { data: buyer } = await supabase.from('users').select('*').eq('id', order.buyer_id).single();
  const { data: seller } = await supabase.from('users').select('*').eq('id', order.seller_id).single();

  if (winner === 'buyer') {
    // Hoàn tiền về buyer
    await supabase.from('users').update({
      balance: buyer.balance + order.total,
      escrow: Math.max(0, buyer.escrow - order.total)
    }).eq('id', order.buyer_id);

    await supabase.from('tickets').update({ status: 'available' }).eq('id', order.ticket_id);
    await supabase.from('transactions').insert({
      user_id: order.buyer_id,
      type: 'refund',
      amount: order.total,
      description: `Hoàn tiền sau khiếu nại: ${order.event_name}${note ? ' — ' + note : ''}`,
      order_id: order.id
    });
  } else {
    // Giải ngân cho seller
    await supabase.from('users').update({
      escrow: Math.max(0, buyer.escrow - order.total)
    }).eq('id', order.buyer_id);

    await supabase.from('users').update({
      balance: seller.balance + order.price
    }).eq('id', order.seller_id);

    await supabase.from('tickets').update({ status: 'sold' }).eq('id', order.ticket_id);
    await supabase.from('transactions').insert([
      {
        user_id: order.seller_id,
        type: 'payout',
        amount: order.price,
        description: `Nhận tiền sau khiếu nại: ${order.event_name}${note ? ' — ' + note : ''}`,
        order_id: order.id
      },
      {
        user_id: order.buyer_id,
        type: 'dispute_closed',
        amount: 0,
        description: `Khiếu nại không thành công: ${order.event_name}`,
        order_id: order.id
      }
    ]);
  }

  await supabase.from('orders').update({
    status: winner === 'buyer' ? 'refunded' : 'completed',
    dispute_resolved_by: winner,
    dispute_resolved_at: new Date().toISOString(),
    dispute_note: note || ''
  }).eq('id', req.params.id);

  res.json({ message: `Đã giải quyết: ${winner} thắng. Tiền đã được xử lý.` });
});

// ════════════════════════════════
//  ESCROW TIMEOUT (48h auto-refund)
// ════════════════════════════════

async function processExpiredEscrows() {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Lấy tất cả đơn waiting_qr đã quá 48h
  const { data: expiredOrders } = await supabase
    .from('orders')
    .select('*')
    .eq('status', 'waiting_qr')
    .lt('created_at', cutoff);

  if (!expiredOrders || expiredOrders.length === 0) return;

  console.log(`[Escrow Timeout] Xử lý ${expiredOrders.length} đơn hết hạn`);

  for (const order of expiredOrders) {
    try {
      // Lấy buyer
      const { data: buyer } = await supabase
        .from('users').select('*').eq('id', order.buyer_id).single();
      if (!buyer) continue;

      // Hoàn tiền: escrow → balance
      await supabase.from('users').update({
        balance: buyer.balance + order.total,
        escrow: Math.max(0, buyer.escrow - order.total)
      }).eq('id', order.buyer_id);

      // Mở lại vé
      await supabase.from('tickets')
        .update({ status: 'available' })
        .eq('id', order.ticket_id);

      // Cập nhật đơn
      await supabase.from('orders')
        .update({ status: 'refunded' })
        .eq('id', order.id);

      // Ghi transaction
      await supabase.from('transactions').insert({
        user_id: order.buyer_id,
        type: 'refund',
        amount: order.total,
        description: `Hoàn tiền tự động: ${order.event_name} (seller không upload QR sau 48h)`,
        order_id: order.id
      });

      console.log(`[Escrow Timeout] Hoàn ${order.total.toLocaleString()}đ cho buyer ${order.buyer_name} — đơn ${order.id}`);
    } catch (e) {
      console.error(`[Escrow Timeout] Lỗi đơn ${order.id}:`, e.message);
    }
  }
}

// Chạy ngay khi khởi động, sau đó mỗi giờ
processExpiredEscrows();
setInterval(processExpiredEscrows, 60 * 60 * 1000);

// Route thủ công cho admin (tuỳ chọn)
app.post('/api/admin/process-timeouts', async (req, res) => {
  const secret = req.query?.secret || req.headers['x-admin-secret'] || req.body?.secret;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  await processExpiredEscrows();
  res.json({ message: 'Done' });
});

// ════════════════════════════════
//  ADMIN ROUTES
// ════════════════════════════════

// Helper đọc secret từ mọi nguồn
function adminSecret(req) {
  return req.query?.secret || req.headers['x-admin-secret'] || req.body?.secret;
}

// Danh sách orders (filter by status)
app.get('/api/admin/orders', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { status } = req.query;
  let query = supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(100);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Chi tiết 1 order
app.get('/api/admin/orders/:id', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (!data) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json(data);
});

// Danh sách users
app.get('/api/admin/users', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data } = await supabase
    .from('users')
    .select('id,phone,name,balance,escrow,avg_rating,review_count,created_at')
    .order('created_at', { ascending: false });
  res.json(data || []);
});
// ── SERVE FRONTEND STATIC FILES ──
app.use(express.static(join(__dirname, 'frontend')));

// Fallback: serve index.html for non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(join(__dirname, 'frontend', 'index.html'));
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`✓ SafePass chạy tại http://0.0.0.0:${PORT}`));
