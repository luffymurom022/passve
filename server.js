import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.JWT_SECRET;

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
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  await processExpiredEscrows();
  res.json({ message: 'Done' });
});
// ── HEALTH CHECK ──
app.get('/', (req, res) => res.json({ status: 'SafePass API đang chạy ✓' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ SafePass API chạy tại http://localhost:${PORT}`));
