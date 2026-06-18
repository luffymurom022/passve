import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ws, { WebSocketServer } from 'ws';
import { Resend } from 'resend';
import multer from 'multer';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
app.use(cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret'],
}));
app.use(helmet({
  contentSecurityPolicy: false, // disabled to allow inline scripts in frontend
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json());

// ── RATE LIMITING ──
const generalLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau.' },
  standardHeaders: true, legacyHeaders: false,
});
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Quá nhiều lần thử đăng nhập, vui lòng thử lại sau 15 phút.' },
  standardHeaders: true, legacyHeaders: false,
});
const orderLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Quá nhiều yêu cầu, vui lòng chờ một chút.' },
  standardHeaders: true, legacyHeaders: false,
});
const topupLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Quá nhiều lần nạp tiền, vui lòng thử lại sau.' },
  standardHeaders: true, legacyHeaders: false,
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

// ── MULTER (memory storage — files go directly to Supabase Storage) ──
const kycUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Chỉ chấp nhận file ảnh (jpg, png, heic…)'));
    }
    cb(null, true);
  },
});

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Chỉ chấp nhận file ảnh'));
    cb(null, true);
  },
});

// ── CREATE KYC STORAGE BUCKET (best-effort on startup) ──
(async () => {
  try {
    await supabase.storage.createBucket('kyc-documents', { public: false });
    console.log('[KYC] Bucket kyc-documents ready.');
  } catch (e) { /* bucket already exists — that's fine */ }
  try {
    await supabase.storage.createBucket('chat-images', { public: true });
    console.log('[Chat] Bucket chat-images ready.');
  } catch (e) { /* bucket already exists — that's fine */ }
})();

// ── IN-MEMORY TOKEN STORES ──
const emailOtpStore = new Map(); // key: email → { otp, userId, expires }
const resetTokenStore = new Map(); // key: token → { userId, expires }
const vnpayPendingStore = new Map(); // key: txnRef → { userId, amount, createdAt, processed }

// ── WEBSOCKET CHAT ──
const chatRooms  = new Map(); // orderId → Set<{ socket, userId, userName }>
const userSockets = new Map(); // userId → socket

function broadcastToRoom(orderId, data, excludeUserId = null) {
  const room = chatRooms.get(orderId);
  if (!room) return;
  const payload = JSON.stringify(data);
  room.forEach(client => {
    if (client.userId !== excludeUserId && client.socket.readyState === 1) {
      try { client.socket.send(payload); } catch(e) {}
    }
  });
}

function sendToUser(userId, data) {
  const socket = userSockets.get(userId);
  if (socket && socket.readyState === 1) {
    try { socket.send(JSON.stringify(data)); } catch(e) {}
  }
}

function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'SP';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── VNPay config ──
const VNPAY_TMN_CODE   = process.env.VNPAY_TMN_CODE;
const VNPAY_HASH_SECRET = process.env.VNPAY_HASH_SECRET;
const VNPAY_URL        = process.env.VNPAY_URL || 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';
const VNPAY_API_URL    = process.env.VNPAY_API_URL || 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction';

function vnpSortObject(obj) {
  return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = obj[k]; return acc; }, {});
}
function vnpCreateHash(params, secret) {
  const sorted = vnpSortObject(params);
  const signStr = Object.entries(sorted).map(([k, v]) => `${k}=${v}`).join('&');
  return crypto.createHmac('sha512', secret).update(Buffer.from(signStr, 'utf-8')).digest('hex');
}
function vnpDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const qrReminderSentSet = new Set(); // key: orderId — tránh gửi nhắc nhở seller trùng lặp
const buyerReminderSentSet = new Set(); // key: orderId — tránh gửi nhắc nhở buyer trùng lặp
function genOtp() { return Math.floor(100000 + Math.random() * 900000).toString(); }
function genToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ── INPUT SANITIZATION ──
function sanitize(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
}

// ════════════════════════════════
//  EMAIL NOTIFICATIONS
// ════════════════════════════════

async function sendNewOrderSellerNotification(order) {
  if (!process.env.RESEND_API_KEY) return;
  const { data: seller } = await supabase.from('users').select('email').eq('id', order.seller_id).single();
  if (!seller?.email) return;
  try {
    await resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: seller.email,
      subject: `🛒 Đơn hàng mới — ${order.event_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#06090f;color:#e8edf8;padding:32px;border-radius:12px;">
          <h2 style="color:#3d8ef8;margin-bottom:4px;">🛒 Bạn có đơn hàng mới!</h2>
          <p style="color:#7b8fad;margin-top:0;">Người mua đã đặt mua vé của bạn và tiền đang được giữ escrow an toàn.</p>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#7b8fad;width:140px;">Sự kiện</td><td style="color:#e8edf8;">${order.event_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Người mua</td><td style="color:#e8edf8;">${order.buyer_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Giá vé</td><td style="color:#3d8ef8;font-weight:600;">${order.price?.toLocaleString('vi-VN')}đ</td></tr>
          </table>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <p style="color:#f5a623;font-size:14px;font-weight:600;">⚠️ Bạn có 48 giờ để upload QR code vé. Nếu không, đơn sẽ tự động bị hủy và tiền hoàn về buyer.</p>
          <p style="color:#7b8fad;font-size:14px;">Đăng nhập <a href="${process.env.APP_URL || ''}" style="color:#3d8ef8;">SafePass</a> để upload QR ngay.</p>
        </div>`,
    });
  } catch (e) { console.error('[Email] Lỗi gửi email đơn mới cho seller:', e.message); }
}

async function sendQRUploadedBuyerNotification(order) {
  if (!process.env.RESEND_API_KEY) return;
  const { data: buyer } = await supabase.from('users').select('email').eq('id', order.buyer_id).single();
  if (!buyer?.email) return;
  try {
    await resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: buyer.email,
      subject: `🎫 Vé đã sẵn sàng — ${order.event_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#06090f;color:#e8edf8;padding:32px;border-radius:12px;">
          <h2 style="color:#22d38e;margin-bottom:4px;">🎫 Người bán đã upload QR vé!</h2>
          <p style="color:#7b8fad;margin-top:0;">Vui lòng xác nhận để giải ngân và hoàn tất giao dịch.</p>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#7b8fad;width:140px;">Sự kiện</td><td style="color:#e8edf8;">${order.event_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Người bán</td><td style="color:#e8edf8;">${order.seller_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Tổng tiền</td><td style="color:#22d38e;font-weight:600;">${order.total?.toLocaleString('vi-VN')}đ</td></tr>
          </table>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <p style="color:#7b8fad;font-size:14px;">Đăng nhập <a href="${process.env.APP_URL || ''}" style="color:#3d8ef8;">SafePass</a> để xem QR và xác nhận nhận vé.</p>
        </div>`,
    });
  } catch (e) { console.error('[Email] Lỗi gửi email QR cho buyer:', e.message); }
}

async function sendPayoutSellerNotification(order) {
  if (!process.env.RESEND_API_KEY) return;
  const { data: seller } = await supabase.from('users').select('email').eq('id', order.seller_id).single();
  if (!seller?.email) return;
  try {
    await resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: seller.email,
      subject: `💸 Đã nhận tiền — ${order.event_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#06090f;color:#e8edf8;padding:32px;border-radius:12px;">
          <h2 style="color:#22d38e;margin-bottom:4px;">💸 Tiền đã vào ví!</h2>
          <p style="color:#7b8fad;margin-top:0;">Người mua đã xác nhận nhận vé thành công.</p>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#7b8fad;width:140px;">Sự kiện</td><td style="color:#e8edf8;">${order.event_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Người mua</td><td style="color:#e8edf8;">${order.buyer_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Số tiền nhận</td><td style="color:#22d38e;font-weight:600;">${order.price?.toLocaleString('vi-VN')}đ</td></tr>
          </table>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <p style="color:#7b8fad;font-size:14px;">Kiểm tra ví tại <a href="${process.env.APP_URL || ''}" style="color:#3d8ef8;">SafePass</a>.</p>
        </div>`,
    });
  } catch (e) { console.error('[Email] Lỗi gửi email giải ngân cho seller:', e.message); }
}

async function sendDisputeResolvedNotification(order, winner) {
  if (!process.env.RESEND_API_KEY) return;
  const [{ data: buyer }, { data: seller }] = await Promise.all([
    supabase.from('users').select('email').eq('id', order.buyer_id).single(),
    supabase.from('users').select('email').eq('id', order.seller_id).single(),
  ]);
  const buyerWon = winner === 'buyer';
  const emails = [];
  if (buyer?.email) emails.push({ to: buyer.email, won: buyerWon, role: 'Người mua', name: order.buyer_name });
  if (seller?.email) emails.push({ to: seller.email, won: !buyerWon, role: 'Người bán', name: order.seller_name });
  for (const e of emails) {
    try {
      await resend.emails.send({
        from: 'SafePass <onboarding@resend.dev>',
        to: e.to,
        subject: `${e.won ? '✅ Khiếu nại thắng' : '❌ Khiếu nại không thành công'} — ${order.event_name}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#06090f;color:#e8edf8;padding:32px;border-radius:12px;">
            <h2 style="color:${e.won ? '#22d38e' : '#f05068'};margin-bottom:4px;">${e.won ? '✅ Khiếu nại được chấp thuận' : '❌ Khiếu nại không thành công'}</h2>
            <p style="color:#7b8fad;margin-top:0;">Admin SafePass đã giải quyết khiếu nại cho đơn hàng <strong>${order.event_name}</strong>.</p>
            <hr style="border-color:#1a2540;margin:20px 0"/>
            <p style="color:#e8edf8;">${e.won ? (winner === 'buyer' ? 'Tiền đã được hoàn về ví của bạn.' : 'Tiền đã được giải ngân vào ví của bạn.') : 'Tiền đã được chuyển cho bên kia.'}</p>
            <hr style="border-color:#1a2540;margin:20px 0"/>
            <p style="color:#7b8fad;font-size:14px;">Kiểm tra tại <a href="${process.env.APP_URL || ''}" style="color:#3d8ef8;">SafePass</a>.</p>
          </div>`,
      });
    } catch (err) { console.error('[Email] Lỗi gửi email kết quả dispute:', err.message); }
  }
}

async function sendNewReviewSellerNotification(review) {
  if (!process.env.RESEND_API_KEY) return;
  const { data: seller } = await supabase.from('users').select('email').eq('id', review.seller_id).single();
  if (!seller?.email) return;
  try {
    await resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: seller.email,
      subject: `⭐ Đánh giá mới — ${review.event_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#06090f;color:#e8edf8;padding:32px;border-radius:12px;">
          <h2 style="color:#f5a623;margin-bottom:4px;">⭐ Bạn nhận được đánh giá mới!</h2>
          <p style="color:#7b8fad;margin-top:0;">Người mua <strong>${review.buyer_name}</strong> đã đánh giá giao dịch.</p>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#7b8fad;width:140px;">Sự kiện</td><td style="color:#e8edf8;">${review.event_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Rating</td><td style="color:#f5a623;font-weight:600;">${'⭐'.repeat(review.rating)} (${review.rating}/5)</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;vertical-align:top;">Nhận xét</td><td style="color:#e8edf8;">${review.text}</td></tr>
          </table>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <p style="color:#7b8fad;font-size:14px;">Xem và phản hồi tại <a href="${process.env.APP_URL || ''}" style="color:#3d8ef8;">SafePass</a>.</p>
        </div>`,
    });
  } catch (e) { console.error('[Email] Lỗi gửi email review mới cho seller:', e.message); }
}

async function sendEscrowTimeoutAdminNotification(expiredOrders) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) return;
  try {
    const rows = expiredOrders.map(o => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #1a2540;font-family:monospace;font-size:12px;color:#7b8fad;">${o.id.slice(0,8)}…</td>
        <td style="padding:8px;border-bottom:1px solid #1a2540;color:#e8edf8;">${o.event_name}</td>
        <td style="padding:8px;border-bottom:1px solid #1a2540;color:#e8edf8;">${o.buyer_name}</td>
        <td style="padding:8px;border-bottom:1px solid #1a2540;color:#e8edf8;">${o.seller_name}</td>
        <td style="padding:8px;border-bottom:1px solid #1a2540;color:#f05068;text-align:right;">${o.total?.toLocaleString('vi-VN')}đ</td>
      </tr>`).join('');
    await resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: process.env.ADMIN_EMAIL,
      subject: `⏰ Escrow Timeout — ${expiredOrders.length} đơn đã tự động hoàn tiền`,
      html: `
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto;background:#06090f;color:#e8edf8;padding:32px;border-radius:12px;">
          <h2 style="color:#f05068;margin-bottom:4px;">⏰ Escrow Timeout tự động</h2>
          <p style="color:#7b8fad;margin-top:0;">${expiredOrders.length} đơn hàng đã quá 48h, seller không upload QR. Tiền đã hoàn về buyer.</p>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#0d1220;">
              <th style="padding:8px;text-align:left;color:#7b8fad;font-weight:500;font-size:12px;">ID</th>
              <th style="padding:8px;text-align:left;color:#7b8fad;font-weight:500;font-size:12px;">Sự kiện</th>
              <th style="padding:8px;text-align:left;color:#7b8fad;font-weight:500;font-size:12px;">Buyer</th>
              <th style="padding:8px;text-align:left;color:#7b8fad;font-weight:500;font-size:12px;">Seller</th>
              <th style="padding:8px;text-align:right;color:#7b8fad;font-weight:500;font-size:12px;">Hoàn tiền</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <p style="color:#7b8fad;font-size:14px;">Xem chi tiết tại <a href="${process.env.APP_URL || ''}/admin.html" style="color:#3d8ef8;">trang Admin</a>.</p>
        </div>`,
    });
    console.log(`[Email] Đã gửi tóm tắt ${expiredOrders.length} escrow timeout cho admin`);
  } catch (e) { console.error('[Email] Lỗi gửi email escrow timeout (admin):', e.message); }
}

async function sendEscrowTimeoutBuyerNotification(order) {
  if (!process.env.RESEND_API_KEY) return;
  const { data: buyer } = await supabase.from('users').select('email').eq('id', order.buyer_id).single();
  if (!buyer?.email) return;
  try {
    await resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: buyer.email,
      subject: `✅ Hoàn tiền tự động — ${order.event_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#06090f;color:#e8edf8;padding:32px;border-radius:12px;">
          <h2 style="color:#22d38e;margin-bottom:4px;">✅ Tiền đã được hoàn về ví của bạn</h2>
          <p style="color:#7b8fad;margin-top:0;">Đơn hàng đã quá 48h mà người bán chưa cung cấp QR code.</p>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#7b8fad;width:120px;">Sự kiện</td><td style="color:#e8edf8;">${order.event_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Người bán</td><td style="color:#e8edf8;">${order.seller_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Số tiền hoàn</td><td style="color:#22d38e;font-weight:600;">${order.total?.toLocaleString('vi-VN')}đ</td></tr>
          </table>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <p style="color:#7b8fad;font-size:14px;">Tiền đã trở về ví SafePass của bạn. Bạn có thể mua vé khác tại <a href="${process.env.APP_URL || ''}" style="color:#3d8ef8;">SafePass</a>.</p>
        </div>`,
    });
  } catch (e) { console.error(`[Email] Lỗi gửi email hoàn tiền cho buyer ${order.buyer_name}:`, e.message); }
}

async function sendQRReminderBuyerNotification(order) {
  if (!process.env.RESEND_API_KEY) return;
  const { data: buyer } = await supabase.from('users').select('email').eq('id', order.buyer_id).single();
  if (!buyer?.email) return;
  const deadline = new Date(new Date(order.created_at).getTime() + 48 * 60 * 60 * 1000);
  const deadlineStr = deadline.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
  try {
    await resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: buyer.email,
      subject: `🕐 Người bán chưa upload QR — ${order.event_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#06090f;color:#e8edf8;padding:32px;border-radius:12px;">
          <h2 style="color:#f5a623;margin-bottom:4px;">🕐 Cập nhật đơn hàng của bạn</h2>
          <p style="color:#7b8fad;margin-top:0;">Đã 24 giờ kể từ khi bạn đặt mua, nhưng người bán chưa upload QR code vé.</p>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#7b8fad;width:140px;">Sự kiện</td><td style="color:#e8edf8;">${order.event_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Người bán</td><td style="color:#e8edf8;">${order.seller_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Số tiền</td><td style="color:#3d8ef8;font-weight:600;">${order.total?.toLocaleString('vi-VN')}đ</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Deadline hoàn tiền</td><td style="color:#22d38e;font-weight:600;">${deadlineStr}</td></tr>
          </table>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <div style="background:#0d1220;border:1px solid #1a2540;border-radius:8px;padding:16px;margin-bottom:20px;">
            <p style="margin:0;color:#e8edf8;font-weight:600;font-size:14px;">Tiền của bạn vẫn an toàn trong escrow 🔒</p>
            <p style="margin:8px 0 0;color:#7b8fad;font-size:14px;">Nếu seller không upload QR trước <strong style="color:#f05068;">${deadlineStr}</strong>, hệ thống sẽ tự động hoàn toàn bộ tiền về ví của bạn.</p>
          </div>
          <p style="color:#7b8fad;font-size:14px;">Nếu bạn nghi ngờ có gian lận, bạn có thể <a href="${process.env.APP_URL || ''}" style="color:#f05068;font-weight:600;">mở khiếu nại ngay</a> thay vì chờ tự động hoàn tiền.</p>
        </div>`,
    });
    console.log(`[Email] Đã gửi nhắc nhở 24h cho buyer ${order.buyer_name} — đơn ${order.id}`);
  } catch (e) { console.error(`[Email] Lỗi gửi nhắc nhở 24h cho buyer ${order.buyer_name}:`, e.message); }
}

async function sendQRReminderSellerNotification(order) {
  if (!process.env.RESEND_API_KEY) return;
  const { data: seller } = await supabase.from('users').select('email').eq('id', order.seller_id).single();
  if (!seller?.email) return;
  const deadline = new Date(new Date(order.created_at).getTime() + 48 * 60 * 60 * 1000);
  const deadlineStr = deadline.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
  try {
    await resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: seller.email,
      subject: `⚠️ Còn 12 giờ để upload QR — ${order.event_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#06090f;color:#e8edf8;padding:32px;border-radius:12px;">
          <h2 style="color:#f5a623;margin-bottom:4px;">⚠️ Nhắc nhở: Còn ~12 giờ để upload QR code!</h2>
          <p style="color:#7b8fad;margin-top:0;">Bạn có một đơn hàng sắp hết hạn. Nếu không upload QR trước deadline, đơn sẽ tự động bị hủy và tiền hoàn về buyer.</p>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#7b8fad;width:140px;">Sự kiện</td><td style="color:#e8edf8;">${order.event_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Người mua</td><td style="color:#e8edf8;">${order.buyer_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Số tiền</td><td style="color:#3d8ef8;font-weight:600;">${order.price?.toLocaleString('vi-VN')}đ</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Deadline</td><td style="color:#f05068;font-weight:600;">${deadlineStr}</td></tr>
          </table>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <div style="background:#1a1a2e;border:1px solid #f5a623;border-radius:8px;padding:16px;margin-bottom:20px;">
            <p style="margin:0;color:#f5a623;font-weight:600;font-size:14px;">🚨 Hành động cần thiết ngay!</p>
            <p style="margin:8px 0 0;color:#7b8fad;font-size:14px;">Đăng nhập SafePass → Đơn hàng của tôi → Upload QR code vé ngay bây giờ.</p>
          </div>
          <a href="${process.env.APP_URL || ''}" style="display:inline-block;background:#f5a623;color:#06090f;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Upload QR Ngay →</a>
          <p style="color:#7b8fad;font-size:12px;margin-top:20px;">Nếu đã upload rồi, vui lòng bỏ qua email này.</p>
        </div>`,
    });
    console.log(`[Email] Đã gửi nhắc nhở 12h QR cho seller ${order.seller_name} — đơn ${order.id}`);
  } catch (e) { console.error(`[Email] Lỗi gửi nhắc nhở 12h QR cho seller ${order.seller_name}:`, e.message); }
}

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
        </div>`,
    });
    console.log(`[Email] Đã gửi thông báo khiếu nại đến ${process.env.ADMIN_EMAIL}`);
  } catch (e) { console.error('[Email] Lỗi gửi email:', e.message); }
}

// ════════════════════════════════
//  NOTIFICATIONS HELPER
// ════════════════════════════════

async function createNotification(userId, type, title, body, link = null) {
  try {
    await supabase.from('notifications').insert({ user_id: userId, type, title, body, link });
  } catch (e) { /* bảng notifications chưa được migration — bỏ qua */ }
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

// ── ADMIN secret helper — accepts legacy x-admin-secret header OR admin JWT Bearer token ──
function adminSecret(req) {
  const raw = req.query?.secret || req.headers['x-admin-secret'] || req.body?.secret;
  if (raw) return raw;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
      if (payload.type === 'admin_jwt') {
        req.admin = { id: payload.adminId, email: payload.email, role: payload.role };
        return process.env.ADMIN_SECRET;
      }
    } catch {}
  }
  return null;
}

// ── MODERATOR middleware — checks JWT + is_moderator in DB ──
async function authMod(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    const { data: u } = await supabase.from('users').select('is_moderator').eq('id', req.user.id).single();
    if (!u?.is_moderator) return res.status(403).json({ error: 'Không có quyền Moderator' });
    next();
  } catch {
    res.status(401).json({ error: 'Token không hợp lệ' });
  }
}

// ── ADMIN JWT middleware ──
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
      if (payload.type === 'admin_jwt') {
        req.admin = { id: payload.adminId, email: payload.email, role: payload.role };
        return next();
      }
    } catch {}
  }
  // Fallback: legacy x-admin-secret
  const sec = req.query?.secret || req.headers['x-admin-secret'] || req.body?.secret;
  if (sec === process.env.ADMIN_SECRET) {
    req.admin = { id: null, email: 'legacy', role: 'super_admin' };
    return next();
  }
  return res.status(401).json({ error: 'Chưa xác thực admin' });
}

// ── ADMIN AUDIT LOG helper ──
async function logAdminAction(adminId, adminEmail, action, targetType, targetId, meta = {}) {
  try {
    await supabase.from('admin_logs').insert({
      admin_id: adminId || null,
      admin_email: adminEmail || 'legacy',
      action,
      target_type: targetType || null,
      target_id: targetId ? String(targetId) : null,
      meta,
    });
  } catch (e) { console.error('[AdminLog]', e.message); }
}

// ════════════════════════════════
//  AUTH
// ════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  const { phone, password, name, email, referral_code } = req.body;
  if (!phone || !password || !name)
    return res.status(400).json({ error: 'Thiếu thông tin' });
  if (typeof phone !== 'string' || phone.length > 20)
    return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
  if (typeof password !== 'string' || password.length < 6)
    return res.status(400).json({ error: 'Mật khẩu phải ít nhất 6 ký tự' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Email không hợp lệ' });

  const { data: existing } = await supabase.from('users').select('id').eq('phone', phone).single();
  if (existing) return res.status(400).json({ error: 'Số điện thoại đã tồn tại' });

  // Generate unique referral code for new user
  let newCode = generateReferralCode();
  for (let i = 0; i < 5; i++) {
    const { data: codeExists } = await supabase.from('users').select('id').eq('referral_code', newCode).maybeSingle();
    if (!codeExists) break;
    newCode = generateReferralCode();
  }

  const hashed = await bcrypt.hash(password, 10);
  const insertData = { phone, password: hashed, name: sanitize(name), balance: 0, escrow: 0, referral_code: newCode };
  if (email) insertData.email = email.toLowerCase().trim();

  let { data, error } = await supabase.from('users').insert(insertData).select().single();
  if (error && error.message?.includes('email') && email) {
    const fallback = { phone, password: hashed, name: sanitize(name), balance: 0, escrow: 0, referral_code: newCode };
    ({ data, error } = await supabase.from('users').insert(fallback).select().single());
  }
  if (error) return res.status(500).json({ error: error.message });

  // Apply referral code from inviter
  let welcomeBonus = 0;
  if (referral_code && String(referral_code).trim()) {
    const code = String(referral_code).trim().toUpperCase();
    const { data: referrer } = await supabase.from('users')
      .select('id,name,referral_count').eq('referral_code', code).maybeSingle();
    if (referrer && referrer.id !== data.id) {
      welcomeBonus = 50000;
      await supabase.from('users').update({ referred_by: referrer.id, balance: welcomeBonus }).eq('id', data.id);
      await supabase.from('users').update({ referral_count: (referrer.referral_count || 0) + 1 }).eq('id', referrer.id);
      await supabase.from('referrals').insert({
        referrer_id: referrer.id, referred_id: data.id,
        referred_name: sanitize(name), referred_phone: phone,
      }).catch(() => {});
      await supabase.from('transactions').insert({
        user_id: data.id, type: 'referral_bonus', amount: welcomeBonus,
        description: `Thưởng chào mừng — được giới thiệu bởi ${referrer.name}`,
      }).catch(() => {});
      createNotification(referrer.id, 'referral', '🎁 Bạn bè tham gia!',
        `${sanitize(name)} đã đăng ký qua mã giới thiệu của bạn!`, '/referral');
    }
  }

  const token = jwt.sign({ id: data.id, phone, name: data.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: data.id, phone, name: data.name, balance: welcomeBonus, escrow: 0 } });
});

app.post('/api/auth/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Thiếu thông tin' });
  const { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
  if (!user) return res.status(400).json({ error: 'Số điện thoại không tồn tại' });
  if (user.is_banned) return res.status(403).json({ error: 'Tài khoản đã bị khóa. Liên hệ hỗ trợ.' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Sai mật khẩu' });

  const token = jwt.sign({ id: user.id, phone: user.phone, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, phone: user.phone, name: user.name, balance: user.balance, escrow: user.escrow } });
});

app.get('/api/auth/me', auth, async (req, res) => {
  const { data } = await supabase
    .from('users').select('id,phone,name,email,balance,escrow,avg_rating,review_count,is_verified,is_vip,vip_expires_at,is_moderator').eq('id', req.user.id).single();
  if (!data) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  res.json({ ...data, is_admin: data.email === process.env.ADMIN_EMAIL });
});

app.patch('/api/auth/profile', auth, async (req, res) => {
  const { email, name } = req.body;
  const updates = {};
  if (name !== undefined) {
    if (!name || name.trim().length < 2)
      return res.status(400).json({ error: 'Tên phải ít nhất 2 ký tự' });
    updates.name = sanitize(name.trim());
  }
  if (email !== undefined) {
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Email không hợp lệ' });
    updates.email = email ? email.toLowerCase().trim() : null;
  }
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'Không có thông tin cần cập nhật' });
  const { data, error } = await supabase
    .from('users').update(updates).eq('id', req.user.id).select('id,phone,name,email,balance,escrow').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Cập nhật thành công', user: data });
});

// Đổi mật khẩu
app.patch('/api/auth/password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'Thiếu thông tin' });
  if (typeof new_password !== 'string' || new_password.length < 6)
    return res.status(400).json({ error: 'Mật khẩu mới phải ít nhất 6 ký tự' });

  const { data: user } = await supabase.from('users').select('password').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });

  const ok = await bcrypt.compare(current_password, user.password);
  if (!ok) return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng' });

  const hashed = await bcrypt.hash(new_password, 10);
  const { error } = await supabase.from('users').update({ password: hashed }).eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Đổi mật khẩu thành công' });
});

// ── Gửi OTP xác minh email ──
app.post('/api/auth/send-verification', auth, async (req, res) => {
  const { data: user } = await supabase.from('users').select('email').eq('id', req.user.id).single();
  if (!user?.email) return res.status(400).json({ error: 'Tài khoản chưa có email. Vui lòng cập nhật email trong hồ sơ trước.' });

  const otp = genOtp();
  emailOtpStore.set(user.email, { otp, userId: req.user.id, expires: Date.now() + 10 * 60 * 1000 });

  try {
    await resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: user.email,
      subject: '✅ Xác minh email SafePass',
      html: `
        <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;background:#06090f;padding:32px;border-radius:16px;color:#e8edf8;">
          <div style="font-size:24px;font-weight:800;color:#3d8ef8;margin-bottom:8px;">🛡️ SafePass</div>
          <h2 style="font-size:20px;margin-bottom:12px;">Xác minh địa chỉ email</h2>
          <p style="color:#7b8fad;margin-bottom:24px;">Nhập mã OTP dưới đây để xác minh email của bạn. Mã có hiệu lực trong <strong style="color:#e8edf8;">10 phút</strong>.</p>
          <div style="background:#0d1220;border:1px solid rgba(61,142,248,.3);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
            <div style="font-size:36px;font-weight:800;letter-spacing:12px;color:#3d8ef8;">${otp}</div>
          </div>
          <p style="color:#3d4f6a;font-size:12px;">Nếu bạn không yêu cầu điều này, hãy bỏ qua email này.</p>
        </div>`,
    });
    res.json({ message: 'Đã gửi mã OTP đến email của bạn' });
  } catch (e) {
    emailOtpStore.delete(user.email);
    res.status(500).json({ error: 'Không gửi được email, vui lòng thử lại' });
  }
});

// ── Xác minh OTP email ──
app.post('/api/auth/verify-email', auth, async (req, res) => {
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ error: 'Vui lòng nhập mã OTP' });

  const { data: user } = await supabase.from('users').select('email').eq('id', req.user.id).single();
  if (!user?.email) return res.status(400).json({ error: 'Tài khoản chưa có email' });

  const record = emailOtpStore.get(user.email);
  if (!record) return res.status(400).json({ error: 'Chưa gửi mã OTP hoặc mã đã hết hạn' });
  if (Date.now() > record.expires) {
    emailOtpStore.delete(user.email);
    return res.status(400).json({ error: 'Mã OTP đã hết hạn, vui lòng gửi lại' });
  }
  if (record.otp !== String(otp).trim()) return res.status(400).json({ error: 'Mã OTP không đúng' });

  emailOtpStore.delete(user.email);
  res.json({ message: 'Email đã được xác minh thành công! ✅' });
});

// ── Quên mật khẩu — gửi link reset ──
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Vui lòng nhập email' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Email không hợp lệ' });

  const { data: user } = await supabase.from('users').select('id,name,email').eq('email', email.toLowerCase().trim()).single();
  const MSG = 'Nếu email tồn tại trong hệ thống, chúng tôi đã gửi hướng dẫn đặt lại mật khẩu.';
  if (!user) return res.json({ message: MSG });

  const token = genToken();
  resetTokenStore.set(token, { userId: user.id, expires: Date.now() + 60 * 60 * 1000 });

  const appUrl = process.env.APP_URL || process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : '';
  const resetUrl = `${appUrl}?reset_token=${token}`;

  try {
    await resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: user.email,
      subject: '🔐 Đặt lại mật khẩu SafePass',
      html: `
        <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;background:#06090f;padding:32px;border-radius:16px;color:#e8edf8;">
          <div style="font-size:24px;font-weight:800;color:#3d8ef8;margin-bottom:8px;">🛡️ SafePass</div>
          <h2 style="font-size:20px;margin-bottom:12px;">Đặt lại mật khẩu</h2>
          <p style="color:#7b8fad;margin-bottom:8px;">Xin chào <strong style="color:#e8edf8;">${user.name}</strong>,</p>
          <p style="color:#7b8fad;margin-bottom:24px;">Bạn vừa yêu cầu đặt lại mật khẩu. Nhấn nút bên dưới để tiếp tục. Link có hiệu lực trong <strong style="color:#e8edf8;">1 giờ</strong>.</p>
          <a href="${resetUrl}" style="display:block;text-align:center;padding:14px 28px;background:linear-gradient(135deg,#3d8ef8,#2563eb);color:#fff;border-radius:12px;font-weight:700;font-size:16px;text-decoration:none;margin-bottom:24px;">🔐 Đặt lại mật khẩu</a>
          <p style="color:#3d4f6a;font-size:12px;">Nếu bạn không yêu cầu điều này, hãy bỏ qua email này. Mật khẩu của bạn sẽ không thay đổi.</p>
          <p style="color:#3d4f6a;font-size:11px;margin-top:8px;word-break:break-all;">Link: ${resetUrl}</p>
        </div>`,
    });
  } catch (e) {}

  res.json({ message: MSG });
});

// ── Đặt lại mật khẩu bằng token ──
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) return res.status(400).json({ error: 'Thiếu thông tin' });
  if (typeof new_password !== 'string' || new_password.length < 6)
    return res.status(400).json({ error: 'Mật khẩu phải ít nhất 6 ký tự' });

  const record = resetTokenStore.get(token);
  if (!record) return res.status(400).json({ error: 'Liên kết không hợp lệ hoặc đã được sử dụng' });
  if (Date.now() > record.expires) {
    resetTokenStore.delete(token);
    return res.status(400).json({ error: 'Liên kết đã hết hạn, vui lòng yêu cầu lại' });
  }

  const hashed = await bcrypt.hash(new_password, 10);
  const { error } = await supabase.from('users').update({ password: hashed }).eq('id', record.userId);
  if (error) return res.status(500).json({ error: error.message });

  resetTokenStore.delete(token);
  res.json({ message: 'Đặt lại mật khẩu thành công! Vui lòng đăng nhập.' });
});

// ── Refresh token (phát JWT mới nếu token còn hạn) ──
app.post('/api/auth/refresh', auth, async (req, res) => {
  const { data: user, error } = await supabase
    .from('users').select('id,name,phone,email,is_banned').eq('id', req.user.id).single();
  if (error || !user) return res.status(404).json({ error: 'Người dùng không tồn tại' });
  if (user.is_banned) return res.status(403).json({ error: 'Tài khoản bị khoá' });
  const token = jwt.sign({ id: user.id, name: user.name, phone: user.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, email: user.email } });
});

// ════════════════════════════════
//  VÉ
// ════════════════════════════════

// ── Khởi tạo Supabase Storage bucket ──
(async () => {
  try {
    await supabase.storage.createBucket('ticket-images', { public: true });
  } catch (e) { /* bucket đã tồn tại */ }
})();

// ── Upload ảnh vé lên Supabase Storage ──
app.post('/api/upload/ticket-image', auth, async (req, res) => {
  const { image_data, content_type } = req.body;
  if (!image_data) return res.status(400).json({ error: 'Thiếu dữ liệu ảnh' });

  const MAX_SIZE = 5 * 1024 * 1024; // 5MB
  const buffer = Buffer.from(image_data, 'base64');
  if (buffer.length > MAX_SIZE) return res.status(400).json({ error: 'Ảnh tối đa 5MB' });

  const ext = (content_type || '').includes('png') ? 'png' : (content_type || '').includes('gif') ? 'gif' : 'jpg';
  const path = `${req.user.id}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from('ticket-images')
    .upload(path, buffer, { contentType: content_type || 'image/jpeg', upsert: false });

  if (error) return res.status(500).json({ error: 'Không tải được ảnh: ' + error.message });

  const { data: { publicUrl } } = supabase.storage.from('ticket-images').getPublicUrl(path);
  res.json({ url: publicUrl });
});

app.post('/api/tickets', auth, async (req, res) => {
  const { event_name, event_date, location, section, price, quantity, description, image_url, category } = req.body;
  if (!event_name || !price || !quantity)
    return res.status(400).json({ error: 'Thiếu thông tin vé' });
  if (isNaN(Number(price)) || Number(price) <= 0)
    return res.status(400).json({ error: 'Giá không hợp lệ' });

  const validCategories = ['concerts', 'kpop', 'sports', 'festivals', 'other'];
  const insertData = {
    seller_id: req.user.id,
    seller_name: req.user.name,
    event_name: sanitize(event_name),
    event_date, location: sanitize(location || ''),
    section: sanitize(section || ''),
    price: Number(price),
    quantity: Number(quantity),
    description: sanitize(description || ''),
    status: 'available'
  };
  if (image_url) insertData.image_url = image_url;
  if (category && validCategories.includes(category)) insertData.category = category;

  let { data, error } = await supabase.from('tickets').insert(insertData).select().single();
  // Nếu cột image_url chưa được migration, thử lại không có image_url
  if (error && image_url) {
    delete insertData.image_url;
    ({ data, error } = await supabase.from('tickets').insert(insertData).select().single());
  }
  // Nếu cột category chưa được migration, thử lại không có category
  if (error && insertData.category) {
    delete insertData.category;
    ({ data, error } = await supabase.from('tickets').insert(insertData).select().single());
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/tickets', async (req, res) => {
  const { search, min_price, max_price, location, date_from, date_to, page, limit, category } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(100, parseInt(limit) || 50);
  const offset = (pageNum - 1) * limitNum;

  let query = supabase.from('tickets').select('*', { count: 'exact' })
    .eq('status', 'available').order('created_at', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (search) query = query.ilike('event_name', `%${search}%`);
  if (min_price) query = query.gte('price', Number(min_price));
  if (max_price) query = query.lte('price', Number(max_price));
  if (location) query = query.ilike('location', `%${location}%`);
  if (date_from) query = query.gte('event_date', date_from);
  if (date_to) query = query.lte('event_date', date_to);
  if (category && category !== 'all') query = query.eq('category', category);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Enrich with seller verification status
  let enriched = data || [];
  if (enriched.length > 0) {
    const sellerIds = [...new Set(enriched.map(t => t.seller_id).filter(Boolean))];
    if (sellerIds.length > 0) {
      const { data: sellers } = await supabase.from('users').select('id,is_verified').in('id', sellerIds);
      const verMap = {};
      (sellers || []).forEach(s => { verMap[s.id] = s.is_verified || false; });
      enriched = enriched.map(t => ({ ...t, seller_verified: verMap[t.seller_id] || false }));
    }
  }

  res.json({ tickets: enriched, total: count, page: pageNum, limit: limitNum });
});

app.get('/api/tickets/:id', async (req, res) => {
  const { data, error } = await supabase.from('tickets').select('*').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'Không tìm thấy vé' });
  res.json(data);
});

app.get('/api/my-tickets', auth, async (req, res) => {
  const { data } = await supabase
    .from('tickets').select('*').eq('seller_id', req.user.id).order('created_at', { ascending: false });
  res.json(data || []);
});

// Chỉnh sửa vé (chỉ khi available)
app.patch('/api/tickets/:id', auth, async (req, res) => {
  const { data: ticket } = await supabase.from('tickets').select('*').eq('id', req.params.id).single();
  if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
  if (ticket.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (ticket.status !== 'available') return res.status(400).json({ error: 'Chỉ chỉnh sửa được vé chưa có đơn đặt' });

  const { event_name, event_date, location, section, price, quantity, description, category } = req.body;
  const validCategories = ['concerts', 'kpop', 'sports', 'festivals', 'other'];
  const updates = {};
  if (event_name) updates.event_name = sanitize(event_name);
  if (event_date !== undefined) updates.event_date = event_date;
  if (location !== undefined) updates.location = sanitize(location);
  if (section !== undefined) updates.section = sanitize(section);
  if (price !== undefined) {
    if (isNaN(Number(price)) || Number(price) <= 0)
      return res.status(400).json({ error: 'Giá không hợp lệ' });
    updates.price = Number(price);
  }
  if (quantity !== undefined) updates.quantity = Number(quantity);
  if (description !== undefined) updates.description = sanitize(description);
  if (category !== undefined && validCategories.includes(category)) updates.category = category;

  const { data, error } = await supabase.from('tickets').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/tickets/:id', auth, async (req, res) => {
  const { data: ticket } = await supabase.from('tickets').select('*').eq('id', req.params.id).single();
  if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
  if (ticket.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (ticket.status !== 'available') return res.status(400).json({ error: 'Chỉ có thể xoá vé chưa có đơn đặt' });
  await supabase.from('tickets').delete().eq('id', req.params.id);
  res.json({ message: 'Đã xoá listing' });
});

// ════════════════════════════════
//  ĐƠN HÀNG / ESCROW
// ════════════════════════════════

app.post('/api/orders', auth, async (req, res) => {
  const { ticket_id } = req.body;
  const { data: ticket } = await supabase.from('tickets').select('*').eq('id', ticket_id).single();
  if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
  if (ticket.status !== 'available') return res.status(400).json({ error: 'Vé không còn available' });
  if (ticket.seller_id === req.user.id) return res.status(400).json({ error: 'Không thể mua vé của chính mình' });

  const { data: buyer } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  if (buyer.is_banned) return res.status(403).json({ error: 'Tài khoản đã bị khóa' });

  const isVip = buyer.is_vip && (!buyer.vip_expires_at || new Date(buyer.vip_expires_at) > new Date());
  const feeRate = isVip ? 0.015 : 0.03;
  const fee = Math.round(ticket.price * feeRate);
  const total = ticket.price + fee;

  if (buyer.balance < total)
    return res.status(400).json({ error: `Số dư không đủ. Cần ${total.toLocaleString()}đ (gồm phí ${isVip ? '1.5% VIP' : '3%'}), hiện có ${buyer.balance.toLocaleString()}đ` });

  await supabase.from('users').update({
    balance: buyer.balance - total,
    escrow: buyer.escrow + total
  }).eq('id', req.user.id);

  await supabase.from('tickets').update({ status: 'pending' }).eq('id', ticket_id);

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

  await supabase.from('transactions').insert({
    user_id: req.user.id,
    type: 'escrow_lock',
    amount: -total,
    description: `Đặt cọc mua vé: ${ticket.event_name}`,
    order_id: order.id
  });

  // Email + in-app notification cho seller
  sendNewOrderSellerNotification(order);
  createNotification(ticket.seller_id, 'order', '🛒 Đơn hàng mới!',
    `${req.user.name} vừa đặt mua vé ${ticket.event_name}`, '/orders');

  res.json(order);
});

app.get('/api/orders', auth, async (req, res) => {
  const { role } = req.query;
  let query = supabase.from('orders').select('*, tickets(section, event_date, location)').order('created_at', { ascending: false });
  if (role === 'seller') query = query.eq('seller_id', req.user.id);
  else query = query.eq('buyer_id', req.user.id);
  const { data } = await query;
  res.json(data || []);
});

app.post('/api/orders/:id/upload-qr', auth, async (req, res) => {
  const { qr_code } = req.body;
  if (!qr_code) return res.status(400).json({ error: 'Thiếu QR code' });
  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (order.status !== 'waiting_qr') return res.status(400).json({ error: 'Đơn không ở trạng thái chờ QR' });

  await supabase.from('orders').update({ qr_code: sanitize(qr_code), status: 'waiting_confirm' }).eq('id', req.params.id);

  // Email + in-app notification cho buyer
  sendQRUploadedBuyerNotification(order);
  createNotification(order.buyer_id, 'qr', '🎫 Vé QR đã sẵn sàng!',
    `${order.seller_name} đã upload QR vé ${order.event_name}. Kiểm tra ngay!`, '/orders');

  res.json({ message: 'Đã upload QR, chờ người mua xác nhận' });
});

app.post('/api/orders/:id/confirm', auth, async (req, res) => {
  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (order.status !== 'waiting_confirm') return res.status(400).json({ error: 'Đơn chưa có QR để xác nhận' });

  const { data: buyer } = await supabase.from('users').select('*').eq('id', order.buyer_id).single();
  const { data: seller } = await supabase.from('users').select('*').eq('id', order.seller_id).single();

  await supabase.from('users').update({ escrow: buyer.escrow - order.total }).eq('id', order.buyer_id);
  await supabase.from('users').update({ balance: seller.balance + order.price }).eq('id', order.seller_id);
  await supabase.from('orders').update({ status: 'completed' }).eq('id', order.id);
  await supabase.from('tickets').update({ status: 'sold' }).eq('id', order.ticket_id);

  await supabase.from('transactions').insert([
    { user_id: order.seller_id, type: 'payout', amount: order.price, description: `Nhận tiền bán vé: ${order.event_name}`, order_id: order.id },
    { user_id: order.buyer_id, type: 'escrow_release', amount: 0, description: `Xác nhận nhận vé: ${order.event_name}`, order_id: order.id }
  ]);

  // Email + in-app notification cho seller
  sendPayoutSellerNotification(order);
  createNotification(order.seller_id, 'payout', '💸 Tiền đã giải ngân!',
    `${order.buyer_name} xác nhận nhận vé ${order.event_name}. ${order.price.toLocaleString('vi-VN')}đ đã vào ví.`, '/wallet');

  // Referral commission: 2% of order total to buyer's referrer
  try {
    const { data: buyerRef } = await supabase.from('users').select('referred_by').eq('id', order.buyer_id).maybeSingle();
    if (buyerRef?.referred_by) {
      const commission = Math.floor(order.total * 0.02);
      if (commission > 0) {
        const { data: ref } = await supabase.from('users').select('balance,referral_earnings').eq('id', buyerRef.referred_by).maybeSingle();
        if (ref) {
          await supabase.from('users').update({
            balance: ref.balance + commission,
            referral_earnings: (ref.referral_earnings || 0) + commission,
          }).eq('id', buyerRef.referred_by);
          await supabase.from('transactions').insert({
            user_id: buyerRef.referred_by, type: 'referral_reward', amount: commission,
            description: `Hoa hồng 2% — ${order.buyer_name}: ${order.event_name}`,
            order_id: order.id,
          });
          const { data: rr } = await supabase.from('referrals').select('id,total_commission').eq('referrer_id', buyerRef.referred_by).eq('referred_id', order.buyer_id).maybeSingle();
          if (rr) await supabase.from('referrals').update({ total_commission: (rr.total_commission || 0) + commission }).eq('id', rr.id);
          createNotification(buyerRef.referred_by, 'referral', '💰 Hoa hồng giới thiệu!',
            `+${commission.toLocaleString('vi-VN')}đ từ giao dịch của ${order.buyer_name}`, '/referral');
        }
      }
    }
  } catch(e) {}

  res.json({ message: 'Xác nhận thành công! Tiền đã được giải ngân cho người bán.' });
});

// ════════════════════════════════
//  VÍ / NẠP TIỀN
// ════════════════════════════════

app.post('/api/wallet/topup', auth, async (req, res) => {
  const { amount } = req.body;
  if (!amount || isNaN(Number(amount)) || Number(amount) < 10000)
    return res.status(400).json({ error: 'Số tiền tối thiểu 10,000đ' });

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

// ── Đăng ký gói VIP (phí 1.5% thay vì 3%) ──
app.post('/api/wallet/subscribe-vip', auth, async (req, res) => {
  const VIP_PRICE = 500000;
  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });
  if (user.balance < VIP_PRICE)
    return res.status(400).json({ error: `Số dư không đủ. Gói VIP cần 500,000đ, hiện có ${user.balance.toLocaleString()}đ` });

  const vipExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('users').update({
    balance: user.balance - VIP_PRICE,
    is_vip: true,
    vip_expires_at: vipExpires
  }).eq('id', req.user.id);

  await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'fee', amount: -VIP_PRICE,
    description: 'Đăng ký gói VIP 30 ngày (phí 1.5% thay vì 3%)'
  });

  createNotification(req.user.id, 'vip', '⭐ Kích hoạt VIP thành công!',
    'Phí giao dịch của bạn giảm còn 1.5% trong 30 ngày tới.', '/wallet');

  res.json({ message: 'Đã kích hoạt gói VIP 30 ngày! Phí giao dịch giảm còn 1.5%', vip_expires_at: vipExpires, balance: user.balance - VIP_PRICE });
});

app.get('/api/wallet/transactions', auth, async (req, res) => {
  const pageNum = Math.max(1, parseInt(req.query.page) || 1);
  const limitNum = Math.min(100, parseInt(req.query.limit) || 20);
  const offset = (pageNum - 1) * limitNum;

  const { data, error, count } = await supabase
    .from('transactions').select('*', { count: 'exact' })
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ transactions: data || [], total: count, page: pageNum, limit: limitNum });
});

// Export CSV lịch sử giao dịch
app.get('/api/wallet/transactions/export', auth, async (req, res) => {
  const { data } = await supabase
    .from('transactions').select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(500);

  const rows = (data || []).map(t => [
    t.id,
    t.type,
    t.amount,
    `"${(t.description || '').replace(/"/g, '""')}"`,
    t.order_id || '',
    t.created_at
  ].join(','));

  const csv = ['ID,Loại,Số tiền,Mô tả,Order ID,Ngày tạo', ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
  res.send('\uFEFF' + csv); // BOM for Excel UTF-8
});

// ════════════════════════════════
//  WITHDRAWAL REQUESTS
// ════════════════════════════════

const BANKS = ['Vietcombank','Techcombank','MB Bank','VPBank','BIDV','Agribank','VietinBank','ACB','TPBank','SHB','OCB','MSB','HDBank','SeABank','LienVietPostBank','VIB','Sacombank','Eximbank','NamA Bank','BacA Bank'];

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  const { amount, bank_name, account_number, account_holder } = req.body;
  if (!amount || !bank_name || !account_number || !account_holder)
    return res.status(400).json({ error: 'Vui lòng điền đầy đủ thông tin' });
  const amt = parseInt(amount);
  if (isNaN(amt) || amt < 50000)
    return res.status(400).json({ error: 'Số tiền rút tối thiểu 50,000đ' });
  if (amt > 50000000)
    return res.status(400).json({ error: 'Số tiền rút tối đa 50,000,000đ mỗi lần' });

  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  if (user.balance < amt)
    return res.status(400).json({ error: `Số dư không đủ. Số dư hiện tại: ${user.balance.toLocaleString('vi-VN')}đ` });

  // Check pending withdrawal
  const { data: pending } = await supabase.from('withdrawal_requests')
    .select('id').eq('user_id', req.user.id).eq('status', 'pending').limit(1);
  if (pending && pending.length > 0)
    return res.status(400).json({ error: 'Bạn đang có yêu cầu rút tiền chờ xử lý. Vui lòng chờ admin duyệt trước khi tạo yêu cầu mới.' });

  // Deduct balance immediately (hold it)
  const { error: balErr } = await supabase.from('users')
    .update({ balance: user.balance - amt }).eq('id', req.user.id);
  if (balErr) return res.status(500).json({ error: balErr.message });

  // Create request
  const { data: wr, error: wrErr } = await supabase.from('withdrawal_requests').insert({
    user_id: req.user.id,
    user_name: sanitize(user.name),
    user_phone: user.phone,
    amount: amt,
    bank_name: sanitize(bank_name),
    account_number: sanitize(account_number),
    account_holder: sanitize(account_holder),
    status: 'pending',
  }).select().single();
  if (wrErr) {
    // Restore balance on failure
    await supabase.from('users').update({ balance: user.balance }).eq('id', req.user.id);
    return res.status(500).json({ error: wrErr.message });
  }

  // Transaction log
  await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'withdraw_pending', amount: -amt,
    description: `Yêu cầu rút tiền về ${sanitize(bank_name)} — ${sanitize(account_number)}`
  });

  // Notify admin by email
  if (process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
    resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: process.env.ADMIN_EMAIL,
      subject: `💸 Yêu cầu rút tiền — ${user.name} — ${amt.toLocaleString('vi-VN')}đ`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#06090f;color:#e8edf8;padding:32px;border-radius:12px;">
        <h2 style="color:#3d8ef8;">💸 Yêu cầu rút tiền mới</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#7b8fad;width:140px;">Người dùng</td><td>${user.name} (${user.phone})</td></tr>
          <tr><td style="padding:8px 0;color:#7b8fad;">Số tiền</td><td style="color:#22d38e;font-weight:700;">${amt.toLocaleString('vi-VN')}đ</td></tr>
          <tr><td style="padding:8px 0;color:#7b8fad;">Ngân hàng</td><td>${sanitize(bank_name)}</td></tr>
          <tr><td style="padding:8px 0;color:#7b8fad;">Số tài khoản</td><td style="font-family:monospace;">${sanitize(account_number)}</td></tr>
          <tr><td style="padding:8px 0;color:#7b8fad;">Chủ tài khoản</td><td>${sanitize(account_holder)}</td></tr>
        </table>
        <hr style="border-color:#1a2540;margin:20px 0"/>
        <p style="color:#7b8fad;font-size:13px;">Đăng nhập Admin Panel để duyệt hoặc từ chối yêu cầu này.</p>
      </div>`
    }).catch(() => {});
  }

  // In-app notification
  createNotification(req.user.id, 'withdraw', '💸 Yêu cầu rút tiền đã gửi',
    `Yêu cầu rút ${amt.toLocaleString('vi-VN')}đ về ${sanitize(bank_name)} đang chờ admin duyệt.`, '/wallet');

  res.json({ message: 'Yêu cầu rút tiền đã được gửi. Admin sẽ xử lý trong 1-2 ngày làm việc.', id: wr.id });
});

app.get('/api/wallet/withdrawals', auth, async (req, res) => {
  const { data, error } = await supabase.from('withdrawal_requests')
    .select('*').eq('user_id', req.user.id)
    .order('created_at', { ascending: false }).limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ════════════════════════════════
//  VNPAY PAYMENT GATEWAY
// ════════════════════════════════

// POST /api/wallet/vnpay/create-payment — tạo URL thanh toán VNPay
app.post('/api/wallet/vnpay/create-payment', auth, async (req, res) => {
  if (!VNPAY_TMN_CODE || !VNPAY_HASH_SECRET)
    return res.status(503).json({ error: 'Cổng thanh toán VNPay chưa được cấu hình.' });

  const { amount } = req.body;
  const amt = parseInt(amount);
  if (!amt || isNaN(amt) || amt < 10000)
    return res.status(400).json({ error: 'Số tiền tối thiểu 10,000đ' });
  if (amt > 500000000)
    return res.status(400).json({ error: 'Số tiền tối đa 500,000,000đ mỗi lần' });

  const txnRef = `SP${Date.now()}${req.user.id.toString().slice(-4)}`;
  const now = new Date();
  const createDate = vnpDate(now);
  const expireDate = vnpDate(new Date(now.getTime() + 15 * 60 * 1000));

  const ipAddr = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '127.0.0.1';
  const appBase = process.env.APP_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;
  const returnUrl = `${appBase}/api/wallet/vnpay/callback`;

  const params = {
    vnp_Version:    '2.1.0',
    vnp_Command:    'pay',
    vnp_TmnCode:    VNPAY_TMN_CODE,
    vnp_Locale:     'vn',
    vnp_CurrCode:   'VND',
    vnp_TxnRef:     txnRef,
    vnp_OrderInfo:  `SafePass nap tien ${txnRef}`,
    vnp_OrderType:  'other',
    vnp_Amount:     amt * 100,
    vnp_ReturnUrl:  returnUrl,
    vnp_IpAddr:     ipAddr,
    vnp_CreateDate: createDate,
    vnp_ExpireDate: expireDate,
  };

  const secureHash = vnpCreateHash(params, VNPAY_HASH_SECRET);
  const query = new URLSearchParams({ ...vnpSortObject(params), vnp_SecureHash: secureHash });
  const paymentUrl = `${VNPAY_URL}?${query.toString()}`;

  // Lưu pending để xác minh khi callback
  vnpayPendingStore.set(txnRef, { userId: req.user.id, amount: amt, createdAt: Date.now(), processed: false });
  setTimeout(() => vnpayPendingStore.delete(txnRef), 20 * 60 * 1000); // tự xoá sau 20 phút

  res.json({ paymentUrl, txnRef });
});

// GET /api/wallet/vnpay/callback — VNPay redirect người dùng về đây sau khi thanh toán
app.get('/api/wallet/vnpay/callback', async (req, res) => {
  const params = { ...req.query };
  const secureHash = params.vnp_SecureHash;
  delete params.vnp_SecureHash;
  delete params.vnp_SecureHashType;

  const appBase = process.env.APP_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;

  if (!secureHash || !VNPAY_HASH_SECRET)
    return res.redirect(`${appBase}/?page=wallet&vnpay=failed&msg=config`);

  const expectedHash = vnpCreateHash(params, VNPAY_HASH_SECRET);
  if (secureHash.toLowerCase() !== expectedHash.toLowerCase())
    return res.redirect(`${appBase}/?page=wallet&vnpay=failed&msg=hash`);

  const txnRef = params.vnp_TxnRef;
  const responseCode = params.vnp_ResponseCode;
  const amount = Math.round(parseInt(params.vnp_Amount) / 100);

  if (responseCode === '00') {
    const pending = vnpayPendingStore.get(txnRef);
    if (pending && !pending.processed) {
      pending.processed = true;
      const { data: user } = await supabase.from('users').select('balance').eq('id', pending.userId).single();
      if (user) {
        await supabase.from('users').update({ balance: user.balance + pending.amount }).eq('id', pending.userId);
        await supabase.from('transactions').insert({
          user_id: pending.userId,
          type: 'topup',
          amount: pending.amount,
          description: `Nạp tiền qua VNPay — Mã GD: ${txnRef}`,
        });
        createNotification(pending.userId, 'topup', '💰 Nạp tiền thành công',
          `Đã nạp ${pending.amount.toLocaleString('vi-VN')}đ vào ví SafePass.`, '/wallet');
      }
    }
    return res.redirect(`${appBase}/?page=wallet&vnpay=success&amount=${amount}`);
  } else {
    // Ghi log thất bại nếu biết user
    const pending = vnpayPendingStore.get(txnRef);
    if (pending && !pending.processed) {
      pending.processed = true;
      await supabase.from('transactions').insert({
        user_id: pending.userId,
        type: 'topup_failed',
        amount: 0,
        description: `Nạp tiền thất bại qua VNPay — Mã GD: ${txnRef} — Mã lỗi: ${responseCode}`,
      });
    }
    return res.redirect(`${appBase}/?page=wallet&vnpay=failed&code=${responseCode}`);
  }
});

// GET /api/wallet/vnpay/ipn — VNPay server-to-server notification (đáng tin cậy hơn callback)
app.get('/api/wallet/vnpay/ipn', async (req, res) => {
  const params = { ...req.query };
  const secureHash = params.vnp_SecureHash;
  delete params.vnp_SecureHash;
  delete params.vnp_SecureHashType;

  if (!secureHash || !VNPAY_HASH_SECRET)
    return res.json({ RspCode: '97', Message: 'Fail checksum' });

  const expectedHash = vnpCreateHash(params, VNPAY_HASH_SECRET);
  if (secureHash.toLowerCase() !== expectedHash.toLowerCase())
    return res.json({ RspCode: '97', Message: 'Fail checksum' });

  const txnRef = params.vnp_TxnRef;
  const responseCode = params.vnp_ResponseCode;
  const amount = Math.round(parseInt(params.vnp_Amount) / 100);

  const pending = vnpayPendingStore.get(txnRef);
  if (!pending) return res.json({ RspCode: '01', Message: 'Order not found' });
  if (pending.amount !== amount) return res.json({ RspCode: '04', Message: 'Invalid amount' });
  if (pending.processed) return res.json({ RspCode: '02', Message: 'Order already confirmed' });

  pending.processed = true;

  if (responseCode === '00') {
    const { data: user } = await supabase.from('users').select('balance').eq('id', pending.userId).single();
    if (user) {
      await supabase.from('users').update({ balance: user.balance + amount }).eq('id', pending.userId);
      await supabase.from('transactions').insert({
        user_id: pending.userId,
        type: 'topup',
        amount,
        description: `Nạp tiền qua VNPay (IPN) — Mã GD: ${txnRef}`,
      });
      createNotification(pending.userId, 'topup', '💰 Nạp tiền thành công',
        `Đã nạp ${amount.toLocaleString('vi-VN')}đ vào ví SafePass.`, '/wallet');
    }
  } else {
    await supabase.from('transactions').insert({
      user_id: pending.userId,
      type: 'topup_failed',
      amount: 0,
      description: `Nạp tiền thất bại qua VNPay (IPN) — Mã GD: ${txnRef} — Mã lỗi: ${responseCode}`,
    });
  }

  res.json({ RspCode: '00', Message: 'Confirm Success' });
});

// POST /api/admin/vnpay/refund — admin hoàn tiền thủ công vào ví người dùng
app.post('/api/admin/vnpay/refund', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { user_id, amount, reason } = req.body;
  if (!user_id || !amount) return res.status(400).json({ error: 'Thiếu user_id hoặc amount' });
  const amt = parseInt(amount);
  if (isNaN(amt) || amt < 1000) return res.status(400).json({ error: 'Số tiền không hợp lệ (tối thiểu 1,000đ)' });

  const { data: user } = await supabase.from('users').select('*').eq('id', user_id).single();
  if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });

  await supabase.from('users').update({ balance: user.balance + amt }).eq('id', user_id);
  await supabase.from('transactions').insert({
    user_id,
    type: 'refund',
    amount: amt,
    description: `Hoàn tiền VNPay — ${sanitize(reason || 'Admin xử lý')}`,
  });
  createNotification(user_id, 'refund', '↩️ Hoàn tiền thành công',
    `Đã hoàn ${amt.toLocaleString('vi-VN')}đ vào ví của bạn.`, '/wallet');

  res.json({ message: `Đã hoàn ${amt.toLocaleString('vi-VN')}đ vào ví người dùng ${user.name}` });
});

app.get('/api/admin/withdrawals', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { status } = req.query;
  let query = supabase.from('withdrawal_requests').select('*').order('created_at', { ascending: false }).limit(200);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/admin/withdrawals/:id/approve', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { note } = req.body;
  const { data: wr } = await supabase.from('withdrawal_requests').select('*').eq('id', req.params.id).single();
  if (!wr) return res.status(404).json({ error: 'Không tìm thấy yêu cầu' });
  if (wr.status !== 'pending') return res.status(400).json({ error: 'Yêu cầu đã được xử lý rồi' });

  await supabase.from('withdrawal_requests').update({
    status: 'approved', admin_note: sanitize(note || ''), processed_at: new Date().toISOString()
  }).eq('id', req.params.id);

  await supabase.from('transactions').insert({
    user_id: wr.user_id, type: 'withdraw', amount: -wr.amount,
    description: `Rút tiền thành công — ${wr.bank_name} ${wr.account_number}${note ? ' — ' + sanitize(note) : ''}`
  });

  createNotification(wr.user_id, 'withdraw_approved', '✅ Rút tiền thành công',
    `${wr.amount.toLocaleString('vi-VN')}đ đã được chuyển đến ${wr.bank_name} ${wr.account_number}.`, '/wallet');

  // Email user
  if (process.env.RESEND_API_KEY) {
    const { data: u } = await supabase.from('users').select('email').eq('id', wr.user_id).single();
    if (u?.email) {
      resend.emails.send({
        from: 'SafePass <onboarding@resend.dev>',
        to: u.email,
        subject: `✅ Rút tiền thành công — ${wr.amount.toLocaleString('vi-VN')}đ`,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#06090f;color:#e8edf8;padding:32px;border-radius:12px;">
          <h2 style="color:#22d38e;">✅ Yêu cầu rút tiền đã được duyệt!</h2>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#7b8fad;width:140px;">Số tiền</td><td style="color:#22d38e;font-weight:700;">${wr.amount.toLocaleString('vi-VN')}đ</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Ngân hàng</td><td>${wr.bank_name}</td></tr>
            <tr><td style="padding:8px 0;color:#7b8fad;">Số tài khoản</td><td style="font-family:monospace;">${wr.account_number}</td></tr>
            ${note ? `<tr><td style="padding:8px 0;color:#7b8fad;">Ghi chú</td><td>${sanitize(note)}</td></tr>` : ''}
          </table>
          <hr style="border-color:#1a2540;margin:20px 0"/>
          <p style="color:#7b8fad;font-size:13px;">Tiền sẽ vào tài khoản trong 1-3 giờ làm việc. Nếu chưa nhận được sau 24h, vui lòng liên hệ hỗ trợ.</p>
        </div>`
      }).catch(() => {});
    }
  }

  const wra = req.admin || { id: null, email: 'legacy' };
  logAdminAction(wra.id, wra.email, 'approve_withdrawal', 'withdrawal', req.params.id, { amount: wr.amount, user_id: wr.user_id });
  res.json({ message: `Đã duyệt rút tiền ${wr.amount.toLocaleString('vi-VN')}đ` });
});

app.post('/api/admin/withdrawals/:id/reject', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { note } = req.body;
  const { data: wr } = await supabase.from('withdrawal_requests').select('*').eq('id', req.params.id).single();
  if (!wr) return res.status(404).json({ error: 'Không tìm thấy yêu cầu' });
  if (wr.status !== 'pending') return res.status(400).json({ error: 'Yêu cầu đã được xử lý rồi' });

  // Restore user balance
  const { data: u } = await supabase.from('users').select('balance').eq('id', wr.user_id).single();
  if (u) await supabase.from('users').update({ balance: u.balance + wr.amount }).eq('id', wr.user_id);

  await supabase.from('withdrawal_requests').update({
    status: 'rejected', admin_note: sanitize(note || ''), processed_at: new Date().toISOString()
  }).eq('id', req.params.id);

  await supabase.from('transactions').insert({
    user_id: wr.user_id, type: 'withdraw_rejected', amount: wr.amount,
    description: `Yêu cầu rút tiền bị từ chối — tiền hoàn về ví${note ? ': ' + sanitize(note) : ''}`
  });

  createNotification(wr.user_id, 'withdraw_rejected', '❌ Yêu cầu rút tiền bị từ chối',
    `Tiền ${wr.amount.toLocaleString('vi-VN')}đ đã hoàn về ví của bạn. Lý do: ${note || 'Không đủ điều kiện.'}`, '/wallet');

  const wrra = req.admin || { id: null, email: 'legacy' };
  logAdminAction(wrra.id, wrra.email, 'reject_withdrawal', 'withdrawal', req.params.id, { user_id: wr.user_id, note: note || '' });
  res.json({ message: 'Đã từ chối yêu cầu rút tiền. Tiền đã hoàn về ví user.' });
});

// ════════════════════════════════
//  REVIEWS
// ════════════════════════════════

app.post('/api/orders/:id/review', auth, async (req, res) => {
  const { rating, text } = req.body;
  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Rating phải từ 1-5' });
  if (!text || text.trim().length < 20)
    return res.status(400).json({ error: 'Đánh giá phải ít nhất 20 ký tự' });

  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (order.status !== 'completed') return res.status(400).json({ error: 'Chỉ đánh giá được đơn đã hoàn tất' });

  const { data: existing } = await supabase.from('reviews').select('id').eq('order_id', req.params.id).single();
  if (existing) return res.status(400).json({ error: 'Bạn đã đánh giá đơn này rồi' });

  const { data: review, error } = await supabase.from('reviews').insert({
    order_id: order.id,
    buyer_id: order.buyer_id,
    buyer_name: req.user.name,
    seller_id: order.seller_id,
    event_name: order.event_name,
    rating: Number(rating),
    text: sanitize(text.trim())
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  const { data: allReviews } = await supabase.from('reviews').select('rating').eq('seller_id', order.seller_id);
  if (allReviews && allReviews.length > 0) {
    const avg = allReviews.reduce((s, r) => s + r.rating, 0) / allReviews.length;
    await supabase.from('users').update({
      avg_rating: Math.round(avg * 10) / 10,
      review_count: allReviews.length
    }).eq('id', order.seller_id);
  }

  // Email + in-app notification cho seller
  sendNewReviewSellerNotification(review);
  createNotification(order.seller_id, 'review', '⭐ Đánh giá mới!',
    `${req.user.name} đánh giá ${'⭐'.repeat(Number(rating))} cho giao dịch ${order.event_name}`, '/orders');

  res.json(review);
});

// ── Public seller profile ──
app.get('/api/users/:id', async (req, res) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('id, name, phone, trust_score, is_verified, created_at, bio, avatar_url')
    .eq('id', req.params.id).single();
  if (error || !user) return res.status(404).json({ error: 'Không tìm thấy người dùng' });

  // Aggregated stats
  const { data: reviewStats } = await supabase
    .from('reviews').select('rating').eq('seller_id', req.params.id);
  const reviews = reviewStats || [];
  const totalReviews = reviews.length;
  const avgRating = totalReviews > 0
    ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / totalReviews) * 10) / 10
    : 0;

  const { count: totalSold } = await supabase
    .from('orders').select('*', { count: 'exact', head: true })
    .eq('seller_id', req.params.id).in('status', ['completed', 'confirmed', 'qr_uploaded']);

  // Mask phone: only show last 3 digits
  const maskedPhone = user.phone ? '****' + user.phone.slice(-3) : '';

  res.json({
    id: user.id,
    name: user.name,
    phone_masked: maskedPhone,
    trust_score: user.trust_score || 0,
    is_verified: user.is_verified || false,
    created_at: user.created_at,
    bio: user.bio || '',
    avatar_url: user.avatar_url || '',
    avg_rating: avgRating,
    total_reviews: totalReviews,
    total_sold: totalSold || 0,
  });
});

// ── Public seller listings ──
app.get('/api/users/:id/listings', async (req, res) => {
  const { data, error } = await supabase
    .from('tickets').select('*')
    .eq('seller_id', req.params.id).eq('status', 'available')
    .order('created_at', { ascending: false }).limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/users/:id/reviews', async (req, res) => {
  const { data } = await supabase
    .from('reviews').select('*').eq('seller_id', req.params.id)
    .order('created_at', { ascending: false }).limit(20);
  res.json(data || []);
});

// Seller phản hồi review
app.post('/api/reviews/:id/reply', auth, async (req, res) => {
  const { reply } = req.body;
  if (!reply || reply.trim().length < 5)
    return res.status(400).json({ error: 'Phản hồi phải ít nhất 5 ký tự' });

  const { data: review } = await supabase.from('reviews').select('*').eq('id', req.params.id).single();
  if (!review) return res.status(404).json({ error: 'Không tìm thấy đánh giá' });
  if (review.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (review.seller_reply) return res.status(400).json({ error: 'Bạn đã phản hồi rồi' });

  const { data, error } = await supabase.from('reviews')
    .update({ seller_reply: sanitize(reply.trim()), seller_reply_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Report review vi phạm ──
const REPORT_REASONS = [
  'Ngôn ngữ xúc phạm / thô tục',
  'Thông tin sai sự thật',
  'Review giả mạo / spam',
  'Nội dung không liên quan',
  'Lý do khác'
];

app.post('/api/reviews/:id/report', auth, async (req, res) => {
  const { reason_index, description } = req.body;
  if (reason_index === undefined || reason_index < 0 || reason_index >= REPORT_REASONS.length)
    return res.status(400).json({ error: 'Lý do không hợp lệ' });

  const { data: review } = await supabase.from('reviews').select('*').eq('id', req.params.id).single();
  if (!review) return res.status(404).json({ error: 'Không tìm thấy đánh giá' });
  if (review.buyer_id === req.user.id) return res.status(400).json({ error: 'Không thể report đánh giá của chính mình' });

  const reason = REPORT_REASONS[reason_index];
  const reportNote = sanitize(description || '');

  // Ghi vào DB (graceful — cột có thể chưa được migration)
  try {
    await supabase.from('reviews').update({
      reported: true,
      report_reason: reason + (reportNote ? ': ' + reportNote : ''),
      reported_by: req.user.id,
      reported_at: new Date().toISOString()
    }).eq('id', req.params.id);
  } catch (e) { /* cột chưa có — bỏ qua DB update, vẫn gửi email */ }

  // Email admin
  if (process.env.RESEND_API_KEY) {
    const { Resend } = await import('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'SafePass <onboarding@resend.dev>',
      to: process.env.ADMIN_EMAIL || 'admin@safepass.vn',
      subject: '🚩 [SafePass] Báo cáo đánh giá vi phạm',
      html: `<h2>🚩 Báo cáo đánh giá vi phạm</h2>
        <p><strong>Review ID:</strong> ${review.id}</p>
        <p><strong>Người bán bị report:</strong> ${review.seller_id}</p>
        <p><strong>Nội dung review:</strong> "${review.text}"</p>
        <p><strong>Lý do báo cáo:</strong> ${reason}</p>
        ${reportNote ? `<p><strong>Mô tả thêm:</strong> ${reportNote}</p>` : ''}
        <p><strong>Người báo cáo:</strong> ${req.user.name} (${req.user.id})</p>
        <p><em>Vui lòng kiểm tra và xử lý trong Admin Panel.</em></p>`
    }).catch(() => {});
  }

  res.json({ success: true, message: 'Đã gửi báo cáo. Chúng tôi sẽ xem xét trong 24h.' });
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

app.post('/api/orders/:id/dispute', auth, async (req, res) => {
  const { reason_index, description } = req.body;
  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
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
    dispute_description: sanitize(description || ''),
    dispute_opened_by: openedBy,
    dispute_opened_at: new Date().toISOString()
  }).eq('id', req.params.id);

  await supabase.from('transactions').insert({
    user_id: req.user.id,
    type: 'dispute_opened',
    amount: 0,
    description: `Mở khiếu nại: ${order.event_name} — ${reasonText}`,
    order_id: order.id
  });

  sendDisputeNotification(order, reasonText, openedBy, description);
  // Notify the other party
  const notifyId = isBuyer ? order.seller_id : order.buyer_id;
  const notifyName = isBuyer ? order.buyer_name : order.seller_name;
  createNotification(notifyId, 'dispute', '⚠️ Khiếu nại mới',
    `${notifyName} vừa mở khiếu nại cho đơn hàng ${order.event_name}: ${reasonText}`, '/orders');

  res.json({ message: 'Khiếu nại đã được gửi. Đội hỗ trợ sẽ phản hồi trong 24h.' });
});

// ════════════════════════════════
//  CHAT NỘI BỘ TRONG ĐƠN HÀNG
// ════════════════════════════════

app.get('/api/orders/:id/messages', auth, async (req, res) => {
  const orderId = req.params.id;
  const { data: order } = await supabase.from('orders').select('buyer_id,seller_id').eq('id', orderId).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id)
    return res.status(403).json({ error: 'Không có quyền' });

  const { data, error } = await supabase.from('order_messages')
    .select('*').eq('order_id', orderId).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/orders/:id/messages', auth, async (req, res) => {
  const orderId = req.params.id;
  const { text } = req.body;
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Tin nhắn không được trống' });

  const { data: order } = await supabase.from('orders').select('buyer_id,seller_id,event_name').eq('id', orderId).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id)
    return res.status(403).json({ error: 'Không có quyền' });

  const { data, error } = await supabase.from('order_messages').insert({
    order_id: orderId,
    sender_id: req.user.id,
    sender_name: req.user.name,
    text: sanitize(String(text).trim()),
    message_type: 'text',
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Broadcast via WebSocket to room (exclude sender — they update via REST response)
  broadcastToRoom(orderId, { type: 'message', message: data }, req.user.id);

  // Push notification to other party (if not in the room)
  const otherId = order.buyer_id === req.user.id ? order.seller_id : order.buyer_id;
  const otherInRoom = chatRooms.get(orderId) && [...(chatRooms.get(orderId) || [])].some(c => c.userId === otherId);
  if (!otherInRoom) {
    sendToUser(otherId, {
      type: 'push_notification',
      orderId,
      senderName: req.user.name,
      text: String(text).trim().slice(0, 80),
    });
    createNotification(otherId, 'chat', '💬 Tin nhắn mới',
      `${req.user.name}: ${String(text).trim().slice(0, 60)}`, '/orders');
  }

  res.json(data);
});

// POST /api/orders/:id/messages/read — đánh dấu đã đọc
app.post('/api/orders/:id/messages/read', auth, async (req, res) => {
  const orderId = req.params.id;
  const { data: order } = await supabase.from('orders').select('buyer_id,seller_id').eq('id', orderId).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id)
    return res.status(403).json({ error: 'Không có quyền' });

  await supabase.from('order_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('order_id', orderId)
    .neq('sender_id', req.user.id)
    .is('read_at', null);

  broadcastToRoom(orderId, { type: 'read', readBy: req.user.id }, req.user.id);
  res.json({ ok: true });
});

// POST /api/orders/:id/messages/image — gửi ảnh trong chat
app.post('/api/orders/:id/messages/image', auth, chatUpload.single('image'), async (req, res) => {
  const orderId = req.params.id;
  if (!req.file) return res.status(400).json({ error: 'Không có file ảnh' });

  const { data: order } = await supabase.from('orders').select('buyer_id,seller_id,event_name').eq('id', orderId).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id)
    return res.status(403).json({ error: 'Không có quyền' });

  const ext = req.file.mimetype.split('/')[1] || 'jpg';
  const filename = `${orderId}/${Date.now()}-${req.user.id.slice(-6)}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from('chat-images').upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (upErr) return res.status(500).json({ error: upErr.message });

  const { data: urlData } = supabase.storage.from('chat-images').getPublicUrl(filename);
  const imageUrl = urlData.publicUrl;

  const { data, error } = await supabase.from('order_messages').insert({
    order_id: orderId,
    sender_id: req.user.id,
    sender_name: req.user.name,
    text: '[Ảnh]',
    message_type: 'image',
    image_url: imageUrl,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  broadcastToRoom(orderId, { type: 'message', message: data });

  const otherId = order.buyer_id === req.user.id ? order.seller_id : order.buyer_id;
  const otherInRoom = chatRooms.get(orderId) && [...(chatRooms.get(orderId) || [])].some(c => c.userId === otherId);
  if (!otherInRoom) {
    sendToUser(otherId, { type: 'push_notification', orderId, senderName: req.user.name, text: '📎 Đã gửi ảnh' });
    createNotification(otherId, 'chat', '💬 Tin nhắn mới', `${req.user.name}: 📎 Đã gửi ảnh`, '/orders');
  }

  res.json(data);
});

app.post('/api/admin/orders/:id/resolve', async (req, res) => {
  const secret = adminSecret(req);
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const { winner, note } = req.body;
  if (!['buyer', 'seller'].includes(winner))
    return res.status(400).json({ error: 'winner phải là buyer hoặc seller' });

  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.status !== 'disputed') return res.status(400).json({ error: 'Đơn không đang ở trạng thái disputed' });

  const { data: buyer } = await supabase.from('users').select('*').eq('id', order.buyer_id).single();
  const { data: seller } = await supabase.from('users').select('*').eq('id', order.seller_id).single();

  if (winner === 'buyer') {
    await supabase.from('users').update({
      balance: buyer.balance + order.total,
      escrow: Math.max(0, buyer.escrow - order.total)
    }).eq('id', order.buyer_id);
    await supabase.from('tickets').update({ status: 'available' }).eq('id', order.ticket_id);
    await supabase.from('transactions').insert({
      user_id: order.buyer_id, type: 'refund', amount: order.total,
      description: `Hoàn tiền sau khiếu nại: ${order.event_name}${note ? ' — ' + note : ''}`,
      order_id: order.id
    });
  } else {
    await supabase.from('users').update({ escrow: Math.max(0, buyer.escrow - order.total) }).eq('id', order.buyer_id);
    await supabase.from('users').update({ balance: seller.balance + order.price }).eq('id', order.seller_id);
    await supabase.from('tickets').update({ status: 'sold' }).eq('id', order.ticket_id);
    await supabase.from('transactions').insert([
      { user_id: order.seller_id, type: 'payout', amount: order.price, description: `Nhận tiền sau khiếu nại: ${order.event_name}${note ? ' — ' + note : ''}`, order_id: order.id },
      { user_id: order.buyer_id, type: 'dispute_closed', amount: 0, description: `Khiếu nại không thành công: ${order.event_name}`, order_id: order.id }
    ]);
  }

  await supabase.from('orders').update({
    status: winner === 'buyer' ? 'refunded' : 'completed',
    dispute_resolved_by: winner,
    dispute_resolved_at: new Date().toISOString(),
    dispute_note: sanitize(note || '')
  }).eq('id', req.params.id);

  // Log admin action
  await supabase.from('transactions').insert({
    user_id: order.buyer_id, type: 'admin_action', amount: 0,
    description: `Admin resolved dispute: ${winner} wins — Order ${req.params.id.slice(0,8)}`,
    order_id: order.id
  });
  const ra = req.admin || { id: null, email: 'legacy' };
  logAdminAction(ra.id, ra.email, 'resolve_dispute', 'order', req.params.id, { winner, note: note || '' });

  // Email + in-app notification cho cả hai
  sendDisputeResolvedNotification(order, winner);
  if (winner === 'buyer') {
    createNotification(order.buyer_id, 'dispute_win', '✅ Khiếu nại thành công',
      `Admin đã xử lý: Bạn thắng khiếu nại đơn hàng ${order.event_name}. Tiền đã hoàn về ví.`, '/wallet');
    createNotification(order.seller_id, 'dispute_lose', '❌ Khiếu nại không thành công',
      `Admin đã xử lý khiếu nại đơn hàng ${order.event_name}. Tiền đã được hoàn cho buyer.`, '/orders');
  } else {
    createNotification(order.seller_id, 'dispute_win', '✅ Khiếu nại thành công',
      `Admin đã xử lý: Bạn thắng khiếu nại đơn hàng ${order.event_name}. Tiền đã giải ngân vào ví.`, '/wallet');
    createNotification(order.buyer_id, 'dispute_lose', '❌ Khiếu nại không thành công',
      `Admin đã xử lý khiếu nại đơn hàng ${order.event_name}. Tiền đã được chuyển cho seller.`, '/orders');
  }

  res.json({ message: `Đã giải quyết: ${winner} thắng. Tiền đã được xử lý.` });
});

// ════════════════════════════════
//  ESCROW TIMEOUT + AUTO-CLOSE DISPUTE
// ════════════════════════════════

async function processExpiredEscrows() {
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const cutoff3d = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  // 0a. Nhắc nhở buyer sau 24h seller chưa upload QR (đơn từ 24-25h trước)
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cutoff25h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const { data: buyerReminderOrders } = await supabase
    .from('orders').select('*').eq('status', 'waiting_qr')
    .lt('created_at', cutoff24h).gt('created_at', cutoff25h);
  if (buyerReminderOrders && buyerReminderOrders.length > 0) {
    for (const order of buyerReminderOrders) {
      if (buyerReminderSentSet.has(order.id)) continue;
      buyerReminderSentSet.add(order.id);
      sendQRReminderBuyerNotification(order);
      createNotification(order.buyer_id, 'warning', '🕐 Seller chưa upload QR sau 24h',
        `Đơn hàng ${order.event_name}: seller chưa upload QR. Tiền bạn vẫn an toàn trong escrow. Nếu không có QR sau 48h, tiền tự hoàn.`, '/orders');
      console.log(`[Buyer Reminder] Đã nhắc buyer ${order.buyer_name} — đơn ${order.id}`);
    }
  }

  // 0b. Nhắc nhở seller còn ~12 giờ (đơn từ 36-37h trước)
  const cutoff36h = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const cutoff37h = new Date(Date.now() - 37 * 60 * 60 * 1000).toISOString();
  const { data: reminderOrders } = await supabase
    .from('orders').select('*').eq('status', 'waiting_qr')
    .lt('created_at', cutoff36h).gt('created_at', cutoff37h);
  if (reminderOrders && reminderOrders.length > 0) {
    for (const order of reminderOrders) {
      if (qrReminderSentSet.has(order.id)) continue;
      qrReminderSentSet.add(order.id);
      sendQRReminderSellerNotification(order);
      createNotification(order.seller_id, 'warning', '⚠️ Còn 12 giờ upload QR!',
        `Đơn hàng ${order.event_name} sắp hết hạn. Upload QR ngay để không bị hủy.`, '/orders');
      console.log(`[QR Reminder] Đã nhắc seller ${order.seller_name} — đơn ${order.id}`);
    }
  }

  // 1. Hoàn tiền waiting_qr quá 48h
  const { data: expiredOrders } = await supabase
    .from('orders').select('*').eq('status', 'waiting_qr').lt('created_at', cutoff48h);

  if (expiredOrders && expiredOrders.length > 0) {
    console.log(`[Escrow Timeout] Xử lý ${expiredOrders.length} đơn hết hạn`);
    for (const order of expiredOrders) {
      try {
        const { data: buyer } = await supabase.from('users').select('*').eq('id', order.buyer_id).single();
        if (!buyer) continue;
        await supabase.from('users').update({
          balance: buyer.balance + order.total,
          escrow: Math.max(0, buyer.escrow - order.total)
        }).eq('id', order.buyer_id);
        await supabase.from('tickets').update({ status: 'available' }).eq('id', order.ticket_id);
        await supabase.from('orders').update({ status: 'refunded' }).eq('id', order.id);
        await supabase.from('transactions').insert({
          user_id: order.buyer_id, type: 'refund', amount: order.total,
          description: `Hoàn tiền tự động: ${order.event_name} (seller không upload QR sau 48h)`,
          order_id: order.id
        });
        console.log(`[Escrow Timeout] Hoàn ${order.total.toLocaleString()}đ cho buyer ${order.buyer_name} — đơn ${order.id}`);
        sendEscrowTimeoutBuyerNotification(order);
        createNotification(order.buyer_id, 'refund', '✅ Hoàn tiền tự động',
          `Đơn hàng ${order.event_name} quá 48h seller chưa upload QR. ${order.total.toLocaleString('vi-VN')}đ đã hoàn về ví.`, '/wallet');
        createNotification(order.seller_id, 'timeout', '⏰ Đơn hàng đã hết hạn',
          `Đơn hàng ${order.event_name} đã bị hủy tự động vì bạn không upload QR sau 48h.`, '/orders');
      } catch (e) { console.error(`[Escrow Timeout] Lỗi đơn ${order.id}:`, e.message); }
    }
    sendEscrowTimeoutAdminNotification(expiredOrders);
  }

  // 2. Auto-close dispute sau 3 ngày (hoàn tiền buyer nếu admin không xử lý)
  const { data: stalledDisputes } = await supabase
    .from('orders').select('*').eq('status', 'disputed').lt('dispute_opened_at', cutoff3d);

  if (stalledDisputes && stalledDisputes.length > 0) {
    console.log(`[Dispute Auto-close] Đóng ${stalledDisputes.length} khiếu nại quá hạn`);
    for (const order of stalledDisputes) {
      try {
        const { data: buyer } = await supabase.from('users').select('*').eq('id', order.buyer_id).single();
        if (!buyer) continue;
        await supabase.from('users').update({
          balance: buyer.balance + order.total,
          escrow: Math.max(0, buyer.escrow - order.total)
        }).eq('id', order.buyer_id);
        await supabase.from('tickets').update({ status: 'available' }).eq('id', order.ticket_id);
        await supabase.from('orders').update({
          status: 'refunded',
          dispute_resolved_by: 'auto',
          dispute_resolved_at: new Date().toISOString(),
          dispute_note: 'Tự động đóng sau 3 ngày không có phản hồi từ admin'
        }).eq('id', order.id);
        await supabase.from('transactions').insert({
          user_id: order.buyer_id, type: 'refund', amount: order.total,
          description: `Hoàn tiền tự động: khiếu nại quá 3 ngày không xử lý`,
          order_id: order.id
        });
        console.log(`[Dispute Auto-close] Hoàn tiền đơn ${order.id}`);
      } catch (e) { console.error(`[Dispute Auto-close] Lỗi đơn ${order.id}:`, e.message); }
    }
  }
}

processExpiredEscrows();
setInterval(processExpiredEscrows, 60 * 60 * 1000);

app.post('/api/admin/process-timeouts', async (req, res) => {
  const secret = adminSecret(req);
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  await processExpiredEscrows();
  res.json({ message: 'Done' });
});

// ════════════════════════════════
//  ADMIN ROUTES
// ════════════════════════════════

app.get('/api/admin/orders', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { status } = req.query;
  let query = supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(200);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/admin/orders/:id', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (!data) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json(data);
});

// Users với tìm kiếm
app.get('/api/admin/users', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { search } = req.query;
  let query = supabase.from('users')
    .select('id,phone,name,email,balance,escrow,avg_rating,review_count,is_banned,is_verified,is_moderator,is_vip,created_at')
    .order('created_at', { ascending: false });
  if (search) {
    query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  }
  const { data } = await query;
  res.json(data || []);
});

// Verify seller
app.post('/api/admin/users/:id/verify', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { error } = await supabase.from('users').update({ is_verified: true }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('transactions').insert({
    user_id: req.params.id, type: 'admin_action', amount: 0,
    description: 'Admin verified seller account'
  }).catch(() => {});
  const a = req.admin || { id: null, email: 'legacy' };
  logAdminAction(a.id, a.email, 'verify_seller', 'user', req.params.id);
  res.json({ message: 'Đã xác minh seller' });
});

// Unverify seller
app.post('/api/admin/users/:id/unverify', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { error } = await supabase.from('users').update({ is_verified: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  const a = req.admin || { id: null, email: 'legacy' };
  logAdminAction(a.id, a.email, 'unverify_seller', 'user', req.params.id);
  res.json({ message: 'Đã bỏ xác minh seller' });
});

// Ban user
app.post('/api/admin/users/:id/ban', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { reason } = req.body;
  const { error } = await supabase.from('users').update({ is_banned: true }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('transactions').insert({
    user_id: req.params.id, type: 'admin_action', amount: 0,
    description: `Admin banned user${reason ? ': ' + sanitize(reason) : ''}`
  });
  const a = req.admin || { id: null, email: 'legacy' };
  logAdminAction(a.id, a.email, 'ban_user', 'user', req.params.id, { reason: reason || '' });
  res.json({ message: 'Đã khóa tài khoản' });
});

// Unban user
app.post('/api/admin/users/:id/unban', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { error } = await supabase.from('users').update({ is_banned: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('transactions').insert({
    user_id: req.params.id, type: 'admin_action', amount: 0,
    description: 'Admin unbanned user'
  });
  const a = req.admin || { id: null, email: 'legacy' };
  logAdminAction(a.id, a.email, 'unban_user', 'user', req.params.id);
  res.json({ message: 'Đã mở khóa tài khoản' });
});

app.post('/api/admin/users/:id/set-moderator', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { is_moderator } = req.body;
  const { error } = await supabase.from('users').update({ is_moderator: !!is_moderator }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  const action = is_moderator ? 'Cấp quyền Moderator' : 'Thu hồi quyền Moderator';
  await supabase.from('transactions').insert({
    user_id: req.params.id, type: 'admin_action', amount: 0,
    description: `Admin: ${action}`
  });
  if (is_moderator) {
    createNotification(req.params.id, 'system', '⚖️ Bạn đã được cấp quyền Moderator',
      'Bạn có thể xử lý khiếu nại trong mục Mod Panel.', '/');
  }
  res.json({ message: action + ' thành công' });
});

// ════════════════════════════════
//  MODERATOR ENDPOINTS
// ════════════════════════════════

app.get('/api/moderator/disputes', authMod, async (req, res) => {
  const { data } = await supabase.from('orders').select('*')
    .eq('status', 'disputed').order('dispute_opened_at', { ascending: true });
  res.json(data || []);
});

app.post('/api/moderator/orders/:id/resolve', authMod, async (req, res) => {
  const { winner, note } = req.body;
  if (!['buyer', 'seller'].includes(winner))
    return res.status(400).json({ error: 'winner phải là buyer hoặc seller' });

  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.status !== 'disputed') return res.status(400).json({ error: 'Đơn không đang ở trạng thái disputed' });

  const { data: buyer } = await supabase.from('users').select('*').eq('id', order.buyer_id).single();
  const { data: seller } = await supabase.from('users').select('*').eq('id', order.seller_id).single();

  if (winner === 'buyer') {
    await supabase.from('users').update({ balance: buyer.balance + order.total, escrow: Math.max(0, buyer.escrow - order.total) }).eq('id', order.buyer_id);
    await supabase.from('tickets').update({ status: 'available' }).eq('id', order.ticket_id);
    await supabase.from('transactions').insert({ user_id: order.buyer_id, type: 'refund', amount: order.total, description: `Hoàn tiền sau khiếu nại (Mod): ${order.event_name}${note ? ' — ' + note : ''}`, order_id: order.id });
  } else {
    await supabase.from('users').update({ escrow: Math.max(0, buyer.escrow - order.total) }).eq('id', order.buyer_id);
    await supabase.from('users').update({ balance: seller.balance + order.price }).eq('id', order.seller_id);
    await supabase.from('tickets').update({ status: 'sold' }).eq('id', order.ticket_id);
    await supabase.from('transactions').insert([
      { user_id: order.seller_id, type: 'payout', amount: order.price, description: `Nhận tiền sau khiếu nại (Mod): ${order.event_name}${note ? ' — ' + note : ''}`, order_id: order.id },
      { user_id: order.buyer_id, type: 'dispute_closed', amount: 0, description: `Khiếu nại không thành công: ${order.event_name}`, order_id: order.id }
    ]);
  }

  await supabase.from('orders').update({
    status: winner === 'buyer' ? 'refunded' : 'completed',
    dispute_resolved_by: winner,
    dispute_resolved_at: new Date().toISOString(),
    dispute_note: sanitize(note || '')
  }).eq('id', req.params.id);

  if (winner === 'buyer') {
    createNotification(order.buyer_id, 'dispute_win', '✅ Khiếu nại thành công', `Moderator đã xử lý: Bạn thắng khiếu nại đơn hàng ${order.event_name}.`, '/wallet');
    createNotification(order.seller_id, 'dispute_lose', '❌ Khiếu nại không thành công', `Moderator đã xử lý khiếu nại đơn hàng ${order.event_name}. Tiền đã hoàn cho buyer.`, '/orders');
  } else {
    createNotification(order.seller_id, 'dispute_win', '✅ Khiếu nại thành công', `Moderator đã xử lý: Bạn thắng khiếu nại đơn hàng ${order.event_name}.`, '/wallet');
    createNotification(order.buyer_id, 'dispute_lose', '❌ Khiếu nại không thành công', `Moderator đã xử lý khiếu nại đơn hàng ${order.event_name}.`, '/orders');
  }

  res.json({ message: `Đã giải quyết: ${winner} thắng.` });
});

// ── Seller dashboard stats ──
app.get('/api/seller/stats', auth, async (req, res) => {
  const sellerId = req.user.id;
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [ordersRes, reviewsRes] = await Promise.all([
    supabase.from('orders').select('*').eq('seller_id', sellerId).order('created_at', { ascending: false }),
    supabase.from('reviews').select('rating,created_at').eq('seller_id', sellerId),
  ]);

  const orders = ordersRes.data || [];
  const reviews = reviewsRes.data || [];
  const completed = orders.filter(o => ['completed', 'confirmed', 'qr_uploaded'].includes(o.status));

  const totalRevenue = completed.reduce((s, o) => s + ((o.total || 0) - (o.fee || 0)), 0);
  const totalSold = completed.length;
  const avgRating = reviews.length > 0
    ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10 : 0;

  // Orders by day (last 30 days)
  const byDay = {};
  const revenueByDay = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    byDay[key] = 0; revenueByDay[key] = 0;
  }
  completed.forEach(o => {
    const key = (o.created_at || '').slice(0, 10);
    if (key in byDay) { byDay[key]++; revenueByDay[key] += (o.total || 0) - (o.fee || 0); }
  });

  const ordersByDay = Object.entries(byDay).map(([date, count]) => ({
    date, count, revenue: revenueByDay[date] || 0
  }));

  // Orders by month (last 12 months)
  const byMonth = {};
  for (let i = 11; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7); // YYYY-MM
    byMonth[key] = { revenue: 0, sold: 0, refunded: 0, totalOrders: 0, ratingSum: 0, ratingCount: 0 };
  }
  orders.forEach(o => {
    const key = (o.created_at || '').slice(0, 7);
    if (!(key in byMonth)) return;
    byMonth[key].totalOrders++;
    if (['completed', 'confirmed', 'qr_uploaded'].includes(o.status)) {
      byMonth[key].sold++;
      byMonth[key].revenue += (o.total || 0) - (o.fee || 0);
    }
    if (o.status === 'refunded') byMonth[key].refunded++;
  });
  reviews.forEach(r => {
    const key = (r.created_at || '').slice(0, 7);
    if (!(key in byMonth)) return;
    byMonth[key].ratingSum += r.rating;
    byMonth[key].ratingCount++;
  });
  const ordersByMonth = Object.entries(byMonth).map(([month, d]) => ({
    month,
    label: (() => { const [y, m] = month.split('-'); return `T${parseInt(m)}/${y.slice(2)}`; })(),
    revenue: d.revenue,
    sold: d.sold,
    refunded: d.refunded,
    total_orders: d.totalOrders,
    refund_rate: d.totalOrders > 0 ? Math.round((d.refunded / d.totalOrders) * 100) : 0,
    avg_rating: d.ratingCount > 0 ? Math.round((d.ratingSum / d.ratingCount) * 10) / 10 : null,
  }));

  // Top listings by revenue
  const topListings = {};
  completed.forEach(o => {
    if (!o.event_name) return;
    if (!topListings[o.event_name]) topListings[o.event_name] = { event_name: o.event_name, count: 0, revenue: 0 };
    topListings[o.event_name].count++;
    topListings[o.event_name].revenue += (o.total || 0) - (o.fee || 0);
  });
  const top = Object.values(topListings).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

  // Recent orders
  const recent = orders.slice(0, 5).map(o => ({
    id: o.id, event_name: o.event_name, status: o.status,
    total: o.total, created_at: o.created_at
  }));

  // Refund rate overall
  const refundedCount = orders.filter(o => o.status === 'refunded').length;
  const refundRate = orders.length > 0 ? Math.round((refundedCount / orders.length) * 100) : 0;

  res.json({
    total_revenue: totalRevenue, total_sold: totalSold,
    avg_rating: avgRating, total_reviews: reviews.length,
    total_orders: orders.length,
    pending: orders.filter(o => o.status === 'waiting_qr').length,
    refund_rate: refundRate,
    orders_by_day: ordersByDay,
    orders_by_month: ordersByMonth,
    top_listings: top,
    recent_orders: recent,
  });
});

// Thống kê doanh thu
app.get('/api/admin/stats', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const [{ data: orders }, { data: users }, { data: tickets }] = await Promise.all([
    supabase.from('orders').select('status,fee,total,price,created_at'),
    supabase.from('users').select('id,balance,escrow,is_banned'),
    supabase.from('tickets').select('status'),
  ]);

  const completed = (orders || []).filter(o => o.status === 'completed');
  const totalRevenue = completed.reduce((s, o) => s + (o.fee || 0), 0);
  const totalGMV = completed.reduce((s, o) => s + (o.price || 0), 0);
  const totalOrders = (orders || []).length;
  const completedOrders = completed.length;
  const disputedOrders = (orders || []).filter(o => o.status === 'disputed').length;
  const refundedOrders = (orders || []).filter(o => o.status === 'refunded').length;
  const totalUsers = (users || []).length;
  const bannedUsers = (users || []).filter(u => u.is_banned).length;
  const totalEscrowLocked = (users || []).reduce((s, u) => s + (u.escrow || 0), 0);
  const availableTickets = (tickets || []).filter(t => t.status === 'available').length;

  res.json({
    totalRevenue, totalGMV, totalOrders, completedOrders, disputedOrders, refundedOrders,
    totalUsers, bannedUsers, totalEscrowLocked, availableTickets,
  });
});

// All tickets (admin)
app.get('/api/admin/tickets', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { status, search } = req.query;
  let query = supabase.from('tickets').select('*').order('created_at', { ascending: false }).limit(300);
  if (status) query = query.eq('status', status);
  if (search) query = query.or(`event_name.ilike.%${search}%,seller_name.ilike.%${search}%`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// All transactions (admin)
app.get('/api/admin/transactions', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { user_id, type } = req.query;
  let query = supabase.from('transactions').select('*').order('created_at', { ascending: false }).limit(300);
  if (user_id) query = query.eq('user_id', user_id);
  if (type) query = query.eq('type', type);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Force cancel order (admin) — refund buyer
app.post('/api/admin/orders/:id/force-cancel', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { note } = req.body;
  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  const cancelable = ['waiting_qr', 'waiting_confirm', 'disputed'];
  if (!cancelable.includes(order.status))
    return res.status(400).json({ error: `Không thể hủy đơn ở trạng thái "${order.status}"` });

  const { data: buyer } = await supabase.from('users').select('balance,escrow').eq('id', order.buyer_id).single();
  if (!buyer) return res.status(404).json({ error: 'Không tìm thấy buyer' });

  await supabase.from('users').update({
    balance: buyer.balance + order.total,
    escrow: Math.max(0, buyer.escrow - order.total),
  }).eq('id', order.buyer_id);

  await supabase.from('tickets').update({ status: 'available' }).eq('id', order.ticket_id);
  await supabase.from('orders').update({
    status: 'refunded',
    dispute_note: sanitize(note || 'Admin force cancelled'),
    dispute_resolved_at: new Date().toISOString(),
  }).eq('id', req.params.id);

  await supabase.from('transactions').insert([
    { user_id: order.buyer_id, type: 'refund', amount: order.total, description: `Admin hủy đơn — hoàn tiền: ${order.event_name}${note ? ' — ' + sanitize(note) : ''}`, order_id: order.id },
    { user_id: order.seller_id, type: 'admin_action', amount: 0, description: `Admin hủy đơn: ${order.event_name}`, order_id: order.id },
  ]);

  createNotification(order.buyer_id, 'refund', '↩️ Đơn hàng bị hủy — Tiền hoàn về ví', `Admin đã hủy đơn hàng ${order.event_name}. Tiền đã hoàn về ví của bạn.`, '/orders');
  createNotification(order.seller_id, 'system', '❌ Đơn hàng bị Admin hủy', `Đơn hàng ${order.event_name} đã bị Admin hủy.`, '/orders');
  const fca = req.admin || { id: null, email: 'legacy' };
  logAdminAction(fca.id, fca.email, 'force_cancel_order', 'order', req.params.id, { note: note || '' });
  res.json({ message: 'Đã hủy đơn và hoàn tiền cho buyer thành công.' });
});

// Force release escrow to seller (admin)
app.post('/api/admin/orders/:id/force-release', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { note } = req.body;
  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  const releasable = ['waiting_qr', 'waiting_confirm', 'disputed'];
  if (!releasable.includes(order.status))
    return res.status(400).json({ error: `Không thể giải ngân đơn ở trạng thái "${order.status}"` });

  const { data: buyer } = await supabase.from('users').select('escrow').eq('id', order.buyer_id).single();
  const { data: seller } = await supabase.from('users').select('balance').eq('id', order.seller_id).single();
  if (!buyer || !seller) return res.status(404).json({ error: 'Không tìm thấy buyer/seller' });

  await supabase.from('users').update({ escrow: Math.max(0, buyer.escrow - order.total) }).eq('id', order.buyer_id);
  await supabase.from('users').update({ balance: seller.balance + order.price }).eq('id', order.seller_id);
  await supabase.from('tickets').update({ status: 'sold' }).eq('id', order.ticket_id);
  await supabase.from('orders').update({
    status: 'completed',
    dispute_note: sanitize(note || 'Admin force released'),
    dispute_resolved_at: new Date().toISOString(),
  }).eq('id', req.params.id);

  await supabase.from('transactions').insert([
    { user_id: order.seller_id, type: 'payout', amount: order.price, description: `Admin giải ngân: ${order.event_name}${note ? ' — ' + sanitize(note) : ''}`, order_id: order.id },
    { user_id: order.buyer_id, type: 'admin_action', amount: 0, description: `Admin giải ngân đơn hàng: ${order.event_name}`, order_id: order.id },
  ]);

  createNotification(order.seller_id, 'payout', '💸 Tiền đã vào ví!', `Admin đã giải ngân đơn hàng ${order.event_name}.`, '/wallet');
  createNotification(order.buyer_id, 'system', '✅ Đơn hàng hoàn tất', `Admin đã xác nhận hoàn tất đơn hàng ${order.event_name}.`, '/orders');
  const fra = req.admin || { id: null, email: 'legacy' };
  logAdminAction(fra.id, fra.email, 'force_release_order', 'order', req.params.id, { note: note || '' });
  res.json({ message: 'Đã giải ngân escrow cho seller thành công.' });
});

// Delete ticket (admin)
app.delete('/api/admin/tickets/:id', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { error } = await supabase.from('tickets').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  const dta = req.admin || { id: null, email: 'legacy' };
  logAdminAction(dta.id, dta.email, 'delete_ticket', 'ticket', req.params.id);
  res.json({ message: 'Đã xóa vé thành công.' });
});

// Hide / unhide ticket (admin)
app.patch('/api/admin/tickets/:id/hide', adminAuth, async (req, res) => {
  const { hidden } = req.body;
  const newStatus = hidden ? 'hidden' : 'available';
  const { error } = await supabase.from('tickets').update({ status: newStatus }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  logAdminAction(req.admin.id, req.admin.email, hidden ? 'hide_ticket' : 'unhide_ticket', 'ticket', req.params.id);
  res.json({ message: hidden ? 'Đã ẩn vé' : 'Đã hiển thị lại vé' });
});

// Export orders CSV
app.get('/api/admin/export', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data } = await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(1000);
  const rows = (data || []).map(o => [
    o.id, `"${(o.event_name || '').replace(/"/g, '""')}"`,
    `"${(o.buyer_name || '').replace(/"/g, '""')}"`,
    `"${(o.seller_name || '').replace(/"/g, '""')}"`,
    o.price, o.fee, o.total, o.status, o.created_at
  ].join(','));
  const csv = ['ID,Sự kiện,Buyer,Seller,Giá,Phí,Tổng,Trạng thái,Ngày tạo', ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send('\uFEFF' + csv);
});

// ════════════════════════════════
//  NOTIFICATIONS API
// ════════════════════════════════

app.get('/api/notifications', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) return res.json({ notifications: [], unread: 0 });
    const unread = (data || []).filter(n => !n.is_read).length;
    res.json({ notifications: data || [], unread });
  } catch (e) {
    res.json({ notifications: [], unread: 0 });
  }
});

app.post('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await supabase.from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.user.id)
      .eq('is_read', false);
  } catch (e) {}
  res.json({ ok: true });
});

app.post('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    await supabase.from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
  } catch (e) {}
  res.json({ ok: true });
});

// ════════════════════════════════
//  QR TICKET VERIFICATION
// ════════════════════════════════

// GET /api/orders/:id/verify-qr — generate ownership QR for an order
app.get('/api/orders/:id/verify-qr', auth, async (req, res) => {
  try {
    const { data: order, error } = await supabase
      .from('orders').select('*').eq('id', req.params.id).single();
    if (error || !order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id) {
      return res.status(403).json({ error: 'Không có quyền truy cập' });
    }
    // Signed token — no expiry so it works on event day
    const token = jwt.sign({ oid: order.id, p: 'tv' }, JWT_SECRET);
    const qrDataUrl = await QRCode.toDataURL(token, {
      width: 400, margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'H',
    });
    res.json({
      qr: qrDataUrl,
      token,
      order_id: order.id,
      event_name: order.event_name,
      buyer_name: order.buyer_name,
    });
  } catch (e) {
    console.error('[QR] generate:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scan/auth — verify scanner access code
app.post('/api/scan/auth', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Thiếu mã truy cập' });
  const adminCode = process.env.ADMIN_SECRET;
  const scannerCode = process.env.SCANNER_CODE;
  if (code === adminCode) return res.json({ success: true, type: 'admin' });
  if (scannerCode && code === scannerCode) return res.json({ success: true, type: 'organizer' });
  return res.status(401).json({ error: 'Mã không đúng. Liên hệ SafePass để lấy mã.' });
});

// POST /api/scan/verify — verify QR token, mark as used, record history
app.post('/api/scan/verify', async (req, res) => {
  try {
    const { token, scanner_name, scanner_type } = req.body;
    if (!token) return res.status(400).json({ error: 'Thiếu QR token', status: 'INVALID' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(400).json({ error: 'QR không hợp lệ hoặc đã bị làm giả', status: 'INVALID' });
    }
    if (payload.p !== 'tv') {
      return res.status(400).json({ error: 'Loại QR không đúng', status: 'INVALID' });
    }

    const order_id = payload.oid;
    const { data: order, error: orderErr } = await supabase
      .from('orders').select('*').eq('id', order_id).single();
    if (orderErr || !order) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng', status: 'INVALID' });
    }

    const ticketInfo = {
      order_id: order.id,
      event_name: order.event_name,
      buyer_name: order.buyer_name,
      seller_name: order.seller_name,
      price: order.price,
      total: order.total,
      order_status: order.status,
      created_at: order.created_at,
    };

    // Check scan history
    const { data: scans } = await supabase
      .from('ticket_scans')
      .select('*')
      .eq('order_id', order_id)
      .order('scanned_at', { ascending: true });

    if (scans && scans.length > 0) {
      return res.json({
        status: 'USED',
        ticket: ticketInfo,
        first_scanned_at: scans[0].scanned_at,
        first_scanned_by: scans[0].scanned_by,
        scan_count: scans.length,
      });
    }

    // First time — record scan
    await supabase.from('ticket_scans').insert({
      order_id,
      scanned_by: sanitize(scanner_name || 'Không rõ'),
      scanner_type: scanner_type || 'organizer',
    });

    res.json({
      status: 'VALID',
      ticket: ticketInfo,
      scanned_at: new Date().toISOString(),
      scanner_name: scanner_name || 'Không rõ',
    });
  } catch (e) {
    console.error('[Scan] verify:', e.message);
    res.status(500).json({ error: e.message, status: 'ERROR' });
  }
});

// GET /api/scan/history — scan history (admin only)
app.get('/api/scan/history', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data, error } = await supabase
      .from('ticket_scans')
      .select('*')
      .order('scanned_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════
//  KYC VERIFICATION
// ════════════════════════════════

// POST /api/kyc/submit — user uploads 3 images
app.post('/api/kyc/submit', auth, kycUpload.fields([
  { name: 'front_image', maxCount: 1 },
  { name: 'back_image', maxCount: 1 },
  { name: 'selfie_image', maxCount: 1 },
]), async (req, res) => {
  try {
    const userId = req.user.id;
    const files = req.files || {};
    if (!files.front_image || !files.back_image || !files.selfie_image) {
      return res.status(400).json({ error: 'Vui lòng tải lên đủ 3 ảnh: mặt trước CCCD, mặt sau CCCD và ảnh selfie.' });
    }

    // Check for existing pending/approved request
    const { data: existing } = await supabase
      .from('kyc_requests')
      .select('status')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (existing && existing.length > 0) {
      const st = existing[0].status;
      if (st === 'approved') return res.status(400).json({ error: 'Tài khoản của bạn đã được xác minh KYC.' });
      if (st === 'pending') return res.status(400).json({ error: 'Yêu cầu KYC của bạn đang được xử lý, vui lòng chờ.' });
    }

    const ts = Date.now();
    const uploadOne = async (fieldKey, file) => {
      const ext = (file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const path = `${userId}/${ts}_${fieldKey}.${ext}`;
      const { error } = await supabase.storage
        .from('kyc-documents')
        .upload(path, file.buffer, { contentType: file.mimetype, upsert: true });
      if (error) throw new Error(`Upload ${fieldKey} thất bại: ${error.message}`);
      return path;
    };

    const [frontPath, backPath, selfiePath] = await Promise.all([
      uploadOne('front', files.front_image[0]),
      uploadOne('back', files.back_image[0]),
      uploadOne('selfie', files.selfie_image[0]),
    ]);

    const { error: dbErr } = await supabase.from('kyc_requests').insert({
      user_id: userId,
      front_image: frontPath,
      back_image: backPath,
      selfie_image: selfiePath,
      status: 'pending',
    });
    if (dbErr) throw new Error(dbErr.message);

    res.json({ success: true, message: 'Yêu cầu xác minh KYC đã được gửi!' });
  } catch (e) {
    console.error('[KYC] submit:', e.message);
    res.status(500).json({ error: e.message || 'Lỗi gửi KYC' });
  }
});

// GET /api/kyc/status — user checks their KYC status
app.get('/api/kyc/status', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('kyc_requests')
      .select('id, status, reject_reason, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    res.json(data && data.length > 0 ? data[0] : { status: 'none' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/kyc — admin lists all KYC requests
app.get('/api/admin/kyc', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data, error } = await supabase
      .from('kyc_requests')
      .select('*, users(name, phone, email)')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const withUrls = await Promise.all((data || []).map(async (kyc) => {
      const [fRes, bRes, sRes] = await Promise.all([
        supabase.storage.from('kyc-documents').createSignedUrl(kyc.front_image, 3600),
        supabase.storage.from('kyc-documents').createSignedUrl(kyc.back_image, 3600),
        supabase.storage.from('kyc-documents').createSignedUrl(kyc.selfie_image, 3600),
      ]);
      return {
        ...kyc,
        front_url: fRes.data?.signedUrl || null,
        back_url: bRes.data?.signedUrl || null,
        selfie_url: sRes.data?.signedUrl || null,
      };
    }));

    res.json(withUrls);
  } catch (e) {
    console.error('[KYC] admin list:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/kyc/:id/approve
app.post('/api/admin/kyc/:id/approve', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { id } = req.params;
    const { data: kyc, error: fetchErr } = await supabase
      .from('kyc_requests').select('user_id, status').eq('id', id).single();
    if (fetchErr || !kyc) return res.status(404).json({ error: 'Không tìm thấy yêu cầu KYC' });
    if (kyc.status === 'approved') return res.status(400).json({ error: 'Đã duyệt rồi' });

    await supabase.from('kyc_requests').update({ status: 'approved' }).eq('id', id);
    await supabase.from('users').update({ is_verified: true }).eq('id', kyc.user_id);

    const ka = req.admin || { id: null, email: 'legacy' };
    logAdminAction(ka.id, ka.email, 'approve_kyc', 'kyc_request', id, { user_id: kyc.user_id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/kyc/:id/reject
app.post('/api/admin/kyc/:id/reject', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const { data: kyc, error: fetchErr } = await supabase
      .from('kyc_requests').select('status,user_id').eq('id', id).single();
    if (fetchErr || !kyc) return res.status(404).json({ error: 'Không tìm thấy yêu cầu KYC' });

    await supabase.from('kyc_requests')
      .update({ status: 'rejected', reject_reason: reason || null })
      .eq('id', id);

    const kr = req.admin || { id: null, email: 'legacy' };
    logAdminAction(kr.id, kr.email, 'reject_kyc', 'kyc_request', id, { user_id: kyc.user_id, reason: reason || '' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════
//  AI CHAT PROXY (server-side — keys never exposed to browser)
// ════════════════════════════════

app.post('/api/ai/chat', auth, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI chat chưa được cấu hình.' });
  }
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Thiếu tin nhắn' });
  }
  const sysPrompt = `Bạn là trợ lý AI của SafePass — nền tảng mua bán vé sự kiện uy tín tại Việt Nam. SafePass dùng cơ chế Escrow: tiền được giữ an toàn cho đến khi người mua xác nhận nhận được vé QR hợp lệ. Phí 3% trên mỗi giao dịch thành công. Trả lời ngắn gọn, thân thiện, bằng tiếng Việt. Tập trung vào hỗ trợ người dùng mua/bán vé an toàn.`;
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: sysPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      }),
    });
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.error?.message || 'Lỗi AI' });
    const reply = (data.content || []).map(b => b.text || '').join('') || 'Xin lỗi, mình gặp lỗi. Thử lại nhé!';
    res.json({ reply });
  } catch (e) {
    console.error('[AI] Lỗi:', e.message);
    res.status(500).json({ error: 'Lỗi kết nối AI' });
  }
});

// ════════════════════════════════
//  REFERRAL SYSTEM
// ════════════════════════════════

app.get('/api/referral/me', auth, async (req, res) => {
  const { data: user } = await supabase.from('users')
    .select('referral_code,referral_earnings,referral_count').eq('id', req.user.id).maybeSingle();
  if (!user) return res.status(404).json({ error: 'Không tìm thấy' });

  const { data: referrals } = await supabase.from('referrals')
    .select('id,referred_name,total_commission,created_at')
    .eq('referrer_id', req.user.id).order('created_at', { ascending: false }).limit(50);

  const { data: recentRewards } = await supabase.from('transactions')
    .select('*').eq('user_id', req.user.id).eq('type', 'referral_reward')
    .order('created_at', { ascending: false }).limit(20);

  res.json({
    code: user.referral_code || null,
    earnings: user.referral_earnings || 0,
    count: user.referral_count || 0,
    referrals: referrals || [],
    recent_rewards: recentRewards || [],
  });
});

app.get('/api/referral/check/:code', async (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const { data } = await supabase.from('users').select('id,name').eq('referral_code', code).maybeSingle();
  if (!data) return res.status(404).json({ error: 'Mã không hợp lệ' });
  res.json({ valid: true, name: data.name });
});

// ════════════════════════════════
//  ADMIN AUTH (email + password → JWT)
// ════════════════════════════════

// POST /api/admin/auth/setup — create first super_admin (requires ADMIN_SECRET)
app.post('/api/admin/auth/setup', async (req, res) => {
  const { email, password, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Sai secret key' });
  if (!email || !password || password.length < 8)
    return res.status(400).json({ error: 'Email và mật khẩu (tối thiểu 8 ký tự) là bắt buộc' });
  const { count } = await supabase.from('admins').select('*', { count: 'exact', head: true });
  if (count > 0) return res.status(400).json({ error: 'Admin đã được thiết lập. Dùng endpoint create để thêm admin mới.' });
  const hash = await bcrypt.hash(password, 12);
  const { data, error } = await supabase.from('admins')
    .insert({ email: email.toLowerCase().trim(), password_hash: hash, role: 'super_admin' })
    .select('id,email,role').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Super admin đã được tạo thành công', id: data.id });
});

// POST /api/admin/auth/login
app.post('/api/admin/auth/login', authLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Thiếu email hoặc mật khẩu' });
  const { data: admin } = await supabase.from('admins').select('*').eq('email', email.toLowerCase().trim()).single();
  if (!admin) return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });
  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });
  const token = jwt.sign(
    { adminId: admin.id, email: admin.email, role: admin.role, type: 'admin_jwt' },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
  logAdminAction(admin.id, admin.email, 'login', 'auth', admin.id);
  res.json({ token, email: admin.email, role: admin.role, name: admin.email.split('@')[0] });
});

// POST /api/admin/auth/create — super_admin creates another admin
app.post('/api/admin/auth/create', adminAuth, async (req, res) => {
  if (req.admin.role !== 'super_admin') return res.status(403).json({ error: 'Chỉ super_admin mới có quyền' });
  const { email, password, role = 'moderator' } = req.body;
  if (!email || !password || password.length < 8)
    return res.status(400).json({ error: 'Email và mật khẩu (tối thiểu 8 ký tự) là bắt buộc' });
  if (!['super_admin', 'moderator'].includes(role))
    return res.status(400).json({ error: 'Role không hợp lệ' });
  const hash = await bcrypt.hash(password, 12);
  const { data, error } = await supabase.from('admins')
    .insert({ email: email.toLowerCase().trim(), password_hash: hash, role })
    .select('id,email,role').single();
  if (error) return res.status(500).json({ error: error.message });
  logAdminAction(req.admin.id, req.admin.email, 'create_admin', 'admin', data.id, { role });
  res.json({ message: 'Admin đã được tạo', id: data.id, email: data.email, role: data.role });
});

// GET /api/admin/me
app.get('/api/admin/me', adminAuth, async (req, res) => {
  if (req.admin.id) {
    const { data } = await supabase.from('admins').select('id,email,role,created_at').eq('id', req.admin.id).single();
    return res.json(data || req.admin);
  }
  res.json(req.admin);
});

// GET /api/admin/admins — list all admins (super_admin only)
app.get('/api/admin/admins', adminAuth, async (req, res) => {
  if (req.admin.role !== 'super_admin') return res.status(403).json({ error: 'Chỉ super_admin' });
  const { data, error } = await supabase.from('admins').select('id,email,role,created_at').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// DELETE /api/admin/admins/:id — remove admin account
app.delete('/api/admin/admins/:id', adminAuth, async (req, res) => {
  if (req.admin.role !== 'super_admin') return res.status(403).json({ error: 'Chỉ super_admin' });
  if (req.admin.id === req.params.id) return res.status(400).json({ error: 'Không thể tự xóa chính mình' });
  const { error } = await supabase.from('admins').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  logAdminAction(req.admin.id, req.admin.email, 'delete_admin', 'admin', req.params.id);
  res.json({ message: 'Đã xóa admin' });
});

// GET /api/admin/logs — audit log
app.get('/api/admin/logs', adminAuth, async (req, res) => {
  const { limit = 100, offset = 0, action } = req.query;
  let query = supabase.from('admin_logs').select('*').order('created_at', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);
  if (action) query = query.eq('action', action);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/admin/disputes — active dispute queue
app.get('/api/admin/disputes', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('orders').select('*')
    .eq('status', 'disputed').order('dispute_opened_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/admin/orders/:id/messages — view order chat (admin)
app.get('/api/admin/orders/:id/messages', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('order_messages')
    .select('*').eq('order_id', req.params.id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/admin/orders/:id/messages — send admin message into order chat
app.post('/api/admin/orders/:id/messages', adminAuth, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Thiếu nội dung' });
  const { data: order } = await supabase.from('orders')
    .select('buyer_id,seller_id,event_name').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  const { data, error } = await supabase.from('order_messages').insert({
    order_id: req.params.id,
    sender_id: req.admin.id || '00000000-0000-0000-0000-000000000000',
    sender_name: `🛡️ Admin (${req.admin.email})`,
    text: sanitize(text.trim()),
    message_type: 'text',
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  createNotification(order.buyer_id, 'system', '📨 Admin gửi tin nhắn',
    `Admin đã gửi tin nhắn trong đơn hàng ${order.event_name}`, '/orders');
  createNotification(order.seller_id, 'system', '📨 Admin gửi tin nhắn',
    `Admin đã gửi tin nhắn trong đơn hàng ${order.event_name}`, '/orders');
  logAdminAction(req.admin.id, req.admin.email, 'send_message', 'order', req.params.id);
  res.json(data);
});

// ── SERVE FRONTEND STATIC FILES ──
app.use(express.static(join(__dirname, 'frontend')));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(join(__dirname, 'frontend', 'index.html'));
  }
});

const PORT = process.env.PORT || 5000;
const httpServer = app.listen(PORT, '0.0.0.0', () => console.log(`✓ SafePass chạy tại http://0.0.0.0:${PORT}`));

// ── WEBSOCKET SERVER (noServer — attaches to existing HTTP server) ──
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  if (!url.pathname.startsWith('/ws/chat')) { socket.destroy(); return; }
  const token = url.searchParams.get('token');
  if (!token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  try {
    const user = jwt.verify(token, JWT_SECRET);
    request._wsUser = user;
    wss.handleUpgrade(request, socket, head, (wsClient) => {
      wss.emit('connection', wsClient, request);
    });
  } catch(e) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', async (socket, req) => {
  const user = req._wsUser;
  const url = new URL(req.url, 'http://localhost');
  const orderId = url.searchParams.get('orderId');
  let clientEntry = null;

  if (orderId) {
    const { data: order } = await supabase.from('orders')
      .select('buyer_id,seller_id').eq('id', orderId).single();
    if (!order || (order.buyer_id !== user.id && order.seller_id !== user.id)) {
      socket.close(4003, 'Forbidden');
      return;
    }
    if (!chatRooms.has(orderId)) chatRooms.set(orderId, new Set());
    clientEntry = { socket, userId: user.id, userName: user.name };
    chatRooms.get(orderId).add(clientEntry);
  }

  // Register for cross-room push notifications
  userSockets.set(user.id, socket);

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'typing' && orderId) {
      broadcastToRoom(orderId, { type: 'typing', userId: user.id, isTyping: !!msg.isTyping }, user.id);
    }

    if (msg.type === 'read' && orderId) {
      supabase.from('order_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('order_id', orderId)
        .neq('sender_id', user.id)
        .is('read_at', null)
        .then(() => broadcastToRoom(orderId, { type: 'read', readBy: user.id }, user.id))
        .catch(() => {});
    }

    if (msg.type === 'ping') {
      try { socket.send(JSON.stringify({ type: 'pong' })); } catch(e) {}
    }
  });

  socket.on('close', () => {
    userSockets.delete(user.id);
    if (orderId && clientEntry) {
      const room = chatRooms.get(orderId);
      if (room) {
        room.delete(clientEntry);
        if (room.size === 0) chatRooms.delete(orderId);
      }
    }
  });

  socket.on('error', () => {});
  try { socket.send(JSON.stringify({ type: 'connected', userId: user.id })); } catch(e) {}
});
