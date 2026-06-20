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

// ══════════════════════════════════════════════════════════
// HỆ THỐNG BẢO MẬT + MÃ HOÁ + KIỂM TRA LỖI (AUTO-LOADED)
// ══════════════════════════════════════════════════════════
import security from './BẢOMẬTVÀCHỐNGHACKTOÀNBỘHỆTHỐNG.js';
import errorChecker from './KIỂMTRALỖITOÀNBỘHỆTHỐNG.js';
import encryption, { wrapSupabase } from './MÃHOÁDỮLIỆUTOÀNHỆTHỐNG.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
app.use(cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret']
}));
app.use(helmet({
  contentSecurityPolicy: false, // disabled to allow inline scripts in frontend
  crossOriginEmbedderPolicy: false
}));
app.use(express.json());

// ── RATE LIMITING ──
const generalLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau.' },
  standardHeaders: true, legacyHeaders: false
});
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Quá nhiều lần thử đăng nhập, vui lòng thử lại sau 15 phút.' },
  standardHeaders: true, legacyHeaders: false
});
const orderLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Quá nhiều yêu cầu, vui lòng chờ một chút.' },
  standardHeaders: true, legacyHeaders: false
});
const topupLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Quá nhiều lần nạp tiền, vui lòng thử lại sau.' },
  standardHeaders: true, legacyHeaders: false
});

app.use('/api/auth', authLimit);
app.use('/api/orders', orderLimit);
app.use('/api/wallet/topup', topupLimit);
app.use('/api', generalLimit);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.warn('⚠️  [SafePass] SUPABASE_URL / SUPABASE_KEY chưa được cấu hình — Vui lòng thêm vào Replit Secrets');
}
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_KEY || 'placeholder_key_replace_me',
  { realtime: { transport: ws } }
);
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_replace_me';
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ── ÁP DỤNG BẢO MẬT ĐA LỚP (8 LAYERS) ──
security.applyAll(app);

// ── MULTER (memory storage — files go directly to Supabase Storage) ──
const kycUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Chỉ chấp nhận file ảnh (jpg, png, heic…)'));
    }
    cb(null, true);
  }
});

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Chỉ chấp nhận file ảnh'));
    cb(null, true);
  }
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
const VNPAY_TMN_CODE   = (process.env.VNPAY_TMN_CODE || '').trim();
const VNPAY_HASH_SECRET = (process.env.VNPAY_HASH_SECRET || '').trim();
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
        </div>`
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
        </div>`
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
        </div>`
    });
  } catch (e) { console.error('[Email] Lỗi gửi email giải ngân cho seller:', e.message); }
}

async function sendDisputeResolvedNotification(order, winner) {
  if (!process.env.RESEND_API_KEY) return;
  const [{ data: buyer }, { data: seller }] = await Promise.all([
    supabase.from('users').select('email').eq('id', order.buyer_id).single(),
    supabase.from('users').select('email').eq('id', order.seller_id).single()
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
          </div>`
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
        </div>`
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
        </div>`
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
        </div>`
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
        </div>`
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
        </div>`
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
        </div>`
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
      meta
    });
  } catch (e) { console.error('[AdminLog]', e.message); }
}

// ════════════════════════════════
//  AUTH
// ════════════════════════════════

function normalizePhone(raw) {
  if (!raw) return '';
  let p = String(raw).replace(/[\s\-\.\(\)]/g, ''); // strip spaces, dashes, dots, parens
  if (p.startsWith('+84')) p = '0' + p.slice(3);    // +84xxx → 0xxx
  if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2); // 84xxx (11 digits) → 0xxx
  return p;
}

app.post('/api/auth/register', async (req, res) => {
  const { password, name, email, referral_code } = req.body;
  const phone = normalizePhone(req.body.phone);
  if (!phone || !password || !name)
    return res.status(400).json({ error: 'Thiếu thông tin' });
  if (phone.length < 9 || phone.length > 15)
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
        referred_name: sanitize(name), referred_phone: phone
      }).catch(() => {});
      await supabase.from('transactions').insert({
        user_id: data.id, type: 'referral_bonus', amount: welcomeBonus,
        description: `Thưởng chào mừng — được giới thiệu bởi ${referrer.name}`
      }).catch(() => {});
      createNotification(referrer.id, 'referral', '🎁 Bạn bè tham gia!',
        `${sanitize(name)} đã đăng ký qua mã giới thiệu của bạn!`, '/referral');
    }
  }

  const token = jwt.sign({ id: data.id, phone, name: data.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: data.id, phone, name: data.name, balance: welcomeBonus, escrow: 0 } });
});

app.post('/api/auth/login', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const { password } = req.body;
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
        </div>`
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
        </div>`
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
//  LISTINGS (MULTI-CATEGORY MARKETPLACE)
// ════════════════════════════════

const LISTING_TYPES = ['ticket', 'product', 'account', 'course', 'service', 'booking'];

// POST /api/listings — create listing
app.post('/api/listings', auth, async (req, res) => {
  const { type, title, description, price, quantity, images, event_date, location, section, category } = req.body;
  if (!type || !LISTING_TYPES.includes(type))
    return res.status(400).json({ error: 'Loại listing không hợp lệ' });
  if (!title || !title.trim())
    return res.status(400).json({ error: 'Thiếu tiêu đề' });
  if (!price || isNaN(Number(price)) || Number(price) <= 0)
    return res.status(400).json({ error: 'Giá không hợp lệ' });
  const { data: seller } = await supabase.from('users').select('is_banned').eq('id', req.user.id).single();
  if (seller?.is_banned) return res.status(403).json({ error: 'Tài khoản bị khóa' });
  const insertData = {
    seller_id: req.user.id,
    seller_name: req.user.name,
    type,
    title: sanitize(title.trim()),
    description: sanitize(description || ''),
    price: Number(price),
    quantity: Math.max(1, Number(quantity) || 1),
    images: Array.isArray(images) ? images : [],
    status: 'available',
    location: location ? sanitize(location) : '',
    section: section ? sanitize(section) : '',
    category: category || '',
    event_date: event_date || null
  };
  const { data, error } = await supabase.from('listings').insert(insertData).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/listings — browse listings
app.get('/api/listings', async (req, res) => {
  const { search, type, min_price, max_price, page, limit: limitQ, sort } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(100, parseInt(limitQ) || 50);
  const offset = (pageNum - 1) * limitNum;
  let query = supabase.from('listings').select('*', { count: 'exact' })
    .eq('status', 'available')
    .range(offset, offset + limitNum - 1);
  if (type && type !== 'all') query = query.eq('type', type);
  if (search) query = query.ilike('title', `%${search}%`);
  if (min_price) query = query.gte('price', Number(min_price));
  if (max_price) query = query.lte('price', Number(max_price));
  if (sort === 'price_asc') query = query.order('price', { ascending: true });
  else if (sort === 'price_desc') query = query.order('price', { ascending: false });
  else query = query.order('created_at', { ascending: false });
  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  let enriched = data || [];
  if (enriched.length > 0) {
    const sellerIds = [...new Set(enriched.map(l => l.seller_id).filter(Boolean))];
    if (sellerIds.length > 0) {
      const { data: sellers } = await supabase.from('users').select('id,is_verified,avg_rating').in('id', sellerIds);
      const sm = {};
      (sellers || []).forEach(s => { sm[s.id] = s; });
      enriched = enriched.map(l => ({ ...l, seller_verified: sm[l.seller_id]?.is_verified || false, seller_rating: sm[l.seller_id]?.avg_rating || 0 }));
    }
  }
  res.json({ listings: enriched, total: count, page: pageNum, limit: limitNum });
});

// GET /api/listings/:id — single listing
app.get('/api/listings/:id', async (req, res) => {
  const { data, error } = await supabase.from('listings').select('*').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'Không tìm thấy listing' });
  res.json(data);
});

// GET /api/my-listings — seller's own listings
app.get('/api/my-listings', auth, async (req, res) => {
  const { data } = await supabase.from('listings').select('*').eq('seller_id', req.user.id).order('created_at', { ascending: false });
  res.json(data || []);
});

// PATCH /api/listings/:id — edit listing
app.patch('/api/listings/:id', auth, async (req, res) => {
  const { data: listing } = await supabase.from('listings').select('*').eq('id', req.params.id).single();
  if (!listing) return res.status(404).json({ error: 'Không tìm thấy listing' });
  if (listing.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (!['available', 'hidden'].includes(listing.status))
    return res.status(400).json({ error: 'Không thể chỉnh sửa listing này' });
  const { title, description, price, quantity, images, event_date, location, section, category } = req.body;
  const updates = { updated_at: new Date().toISOString() };
  if (title) updates.title = sanitize(title.trim());
  if (description !== undefined) updates.description = sanitize(description);
  if (price !== undefined) {
    if (isNaN(Number(price)) || Number(price) <= 0) return res.status(400).json({ error: 'Giá không hợp lệ' });
    updates.price = Number(price);
  }
  if (quantity !== undefined) updates.quantity = Number(quantity);
  if (images !== undefined) updates.images = images;
  if (event_date !== undefined) updates.event_date = event_date;
  if (location !== undefined) updates.location = sanitize(location);
  if (section !== undefined) updates.section = sanitize(section);
  if (category !== undefined) updates.category = category;
  const { data, error } = await supabase.from('listings').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/listings/:id — delete listing
app.delete('/api/listings/:id', auth, async (req, res) => {
  const { data: listing } = await supabase.from('listings').select('*').eq('id', req.params.id).single();
  if (!listing) return res.status(404).json({ error: 'Không tìm thấy listing' });
  if (listing.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (!['available', 'hidden'].includes(listing.status))
    return res.status(400).json({ error: 'Chỉ xóa được listing chưa có đơn' });
  await supabase.from('listings').delete().eq('id', req.params.id);
  res.json({ message: 'Đã xóa listing' });
});

// PATCH /api/listings/:id/visibility — seller toggle hide/show
app.patch('/api/listings/:id/visibility', auth, async (req, res) => {
  const { hidden } = req.body;
  const { data: listing } = await supabase.from('listings').select('seller_id,status').eq('id', req.params.id).single();
  if (!listing) return res.status(404).json({ error: 'Không tìm thấy' });
  if (listing.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('listings').update({ status: hidden ? 'hidden' : 'available' }).eq('id', req.params.id);
  res.json({ message: hidden ? 'Đã ẩn listing' : 'Đã hiện listing' });
});

// ════════════════════════════════
//  ĐƠN HÀNG / ESCROW
// ════════════════════════════════

app.post('/api/orders', auth, async (req, res) => {
  const { ticket_id, listing_id } = req.body;
  if (!ticket_id && !listing_id)
    return res.status(400).json({ error: 'Thiếu ticket_id hoặc listing_id' });

  let itemId, itemTitle, itemPrice, itemSellerId, itemSellerName, itemType, itemTable;

  if (listing_id) {
    const { data: listing } = await supabase.from('listings').select('*').eq('id', listing_id).single();
    if (!listing) return res.status(404).json({ error: 'Không tìm thấy listing' });
    if (listing.status !== 'available') return res.status(400).json({ error: 'Listing không còn available' });
    if (listing.seller_id === req.user.id) return res.status(400).json({ error: 'Không thể mua listing của chính mình' });
    itemId = listing_id; itemTitle = listing.title; itemPrice = listing.price;
    itemSellerId = listing.seller_id; itemSellerName = listing.seller_name;
    itemType = listing.type; itemTable = 'listings';
  } else {
    const { data: ticket } = await supabase.from('tickets').select('*').eq('id', ticket_id).single();
    if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
    if (ticket.status !== 'available') return res.status(400).json({ error: 'Vé không còn available' });
    if (ticket.seller_id === req.user.id) return res.status(400).json({ error: 'Không thể mua vé của chính mình' });
    itemId = ticket_id; itemTitle = ticket.event_name; itemPrice = ticket.price;
    itemSellerId = ticket.seller_id; itemSellerName = ticket.seller_name;
    itemType = 'ticket'; itemTable = 'tickets';
  }

  const { data: buyer } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  if (buyer.is_banned) return res.status(403).json({ error: 'Tài khoản đã bị khóa' });

  const isVip = buyer.is_vip && (!buyer.vip_expires_at || new Date(buyer.vip_expires_at) > new Date());
  const feeRate = isVip ? 0.015 : 0.03;
  const fee = Math.round(itemPrice * feeRate);
  const total = itemPrice + fee;

  if (buyer.balance < total)
    return res.status(400).json({ error: `Số dư không đủ. Cần ${total.toLocaleString()}đ (gồm phí ${isVip ? '1.5% VIP' : '3%'}), hiện có ${buyer.balance.toLocaleString()}đ` });

  await supabase.from('users').update({ balance: buyer.balance - total, escrow: buyer.escrow + total }).eq('id', req.user.id);
  await supabase.from(itemTable).update({ status: 'pending' }).eq('id', itemId);

  const orderData = {
    buyer_id: req.user.id, buyer_name: req.user.name,
    seller_id: itemSellerId, seller_name: itemSellerName,
    event_name: itemTitle, price: itemPrice, fee, total, status: 'waiting_qr'
  };
  if (listing_id) { orderData.listing_id = listing_id; orderData.listing_type = itemType; }
  else { orderData.ticket_id = ticket_id; }

  const { data: order, error } = await supabase.from('orders').insert(orderData).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'escrow_lock', amount: -total,
    description: `Đặt cọc mua: ${itemTitle}`, order_id: order.id
  });

  sendNewOrderSellerNotification(order);
  createNotification(itemSellerId, 'order', '🛒 Đơn hàng mới!',
    `${req.user.name} vừa đặt mua: ${itemTitle}`, '/orders');
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
  if (order.listing_id) {
    await supabase.from('listings').update({ status: 'sold' }).eq('id', order.listing_id);
  } else if (order.ticket_id) {
    await supabase.from('tickets').update({ status: 'sold' }).eq('id', order.ticket_id);
  }

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
            referral_earnings: (ref.referral_earnings || 0) + commission
          }).eq('id', buyerRef.referred_by);
          await supabase.from('transactions').insert({
            user_id: buyerRef.referred_by, type: 'referral_reward', amount: commission,
            description: `Hoa hồng 2% — ${order.buyer_name}: ${order.event_name}`,
            order_id: order.id
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
//  PASS ĐỒ — SHIPPING SYSTEM
// ════════════════════════════════

const PHYSICAL_TYPES = ['product', 'account', 'course', 'service', 'booking'];

// POST /api/orders/:id/submit-tracking — seller nhập mã vận đơn
app.post('/api/orders/:id/submit-tracking', auth, async (req, res) => {
  const { carrier, tracking_code } = req.body;
  if (!carrier || !tracking_code)
    return res.status(400).json({ error: 'Vui lòng nhập hãng vận chuyển và mã vận đơn' });

  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (order.status !== 'waiting_qr')
    return res.status(400).json({ error: 'Đơn không ở trạng thái chờ giao hàng' });
  if (!PHYSICAL_TYPES.includes(order.listing_type))
    return res.status(400).json({ error: 'Chỉ dùng cho đơn hàng vật lý (product/course/service/...)' });

  const { data: existing } = await supabase.from('shipping_orders')
    .select('id').eq('order_id', req.params.id).maybeSingle();

  const shippingData = {
    order_id: req.params.id,
    carrier: sanitize(carrier),
    tracking_code: sanitize(tracking_code),
    shipping_status: 'shipping',
    updated_at: new Date().toISOString()
  };
  if (existing) {
    await supabase.from('shipping_orders').update(shippingData).eq('id', existing.id);
  } else {
    await supabase.from('shipping_orders').insert({ ...shippingData, created_at: new Date().toISOString() });
  }

  await supabase.from('orders').update({ status: 'shipping' }).eq('id', req.params.id);

  createNotification(order.buyer_id, 'shipping', '🚚 Đơn hàng đã được giao!',
    `${order.seller_name} đã gửi hàng qua ${sanitize(carrier)}. Mã vận đơn: ${sanitize(tracking_code)}`, '/orders');

  console.log(`[Shipping] Đơn ${req.params.id} → shipping, carrier: ${carrier}, tracking: ${tracking_code}`);
  res.json({ message: 'Đã nhập mã vận đơn thành công!', carrier, tracking_code });
});

// GET /api/orders/:id/shipping — lấy thông tin vận chuyển
app.get('/api/orders/:id/shipping', auth, async (req, res) => {
  const { data: order } = await supabase.from('orders')
    .select('buyer_id,seller_id').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id)
    return res.status(403).json({ error: 'Không có quyền' });

  const { data: shipping } = await supabase.from('shipping_orders')
    .select('*').eq('order_id', req.params.id).maybeSingle();
  res.json(shipping || null);
});

// POST /api/orders/:id/confirm-delivery — buyer xác nhận đã nhận hàng → giải ngân escrow
app.post('/api/orders/:id/confirm-delivery', auth, async (req, res) => {
  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (order.status !== 'shipping')
    return res.status(400).json({ error: 'Đơn không ở trạng thái đang giao hàng' });

  const { data: buyer } = await supabase.from('users').select('*').eq('id', order.buyer_id).single();
  const { data: seller } = await supabase.from('users').select('*').eq('id', order.seller_id).single();

  await supabase.from('users').update({ escrow: Math.max(0, buyer.escrow - order.total) }).eq('id', order.buyer_id);
  await supabase.from('users').update({ balance: seller.balance + order.price }).eq('id', order.seller_id);
  await supabase.from('orders').update({ status: 'completed' }).eq('id', order.id);
  if (order.listing_id) {
    await supabase.from('listings').update({ status: 'sold' }).eq('id', order.listing_id);
  }
  await supabase.from('shipping_orders')
    .update({ shipping_status: 'completed', updated_at: new Date().toISOString() })
    .eq('order_id', order.id);

  await supabase.from('transactions').insert([
    { user_id: order.seller_id, type: 'payout', amount: order.price,
      description: `Nhận tiền bán hàng: ${order.event_name}`, order_id: order.id },
    { user_id: order.buyer_id, type: 'escrow_release', amount: 0,
      description: `Xác nhận nhận hàng: ${order.event_name}`, order_id: order.id }
  ]);

  createNotification(order.seller_id, 'payout', '💸 Tiền đã giải ngân!',
    `${order.buyer_name} xác nhận nhận hàng ${order.event_name}. ${order.price.toLocaleString('vi-VN')}đ đã vào ví.`, '/wallet');

  try {
    const { data: buyerRef } = await supabase.from('users').select('referred_by').eq('id', order.buyer_id).maybeSingle();
    if (buyerRef?.referred_by) {
      const commission = Math.floor(order.total * 0.02);
      if (commission > 0) {
        const { data: ref } = await supabase.from('users').select('balance,referral_earnings')
          .eq('id', buyerRef.referred_by).maybeSingle();
        if (ref) {
          await supabase.from('users').update({
            balance: ref.balance + commission,
            referral_earnings: (ref.referral_earnings || 0) + commission
          }).eq('id', buyerRef.referred_by);
          await supabase.from('transactions').insert({
            user_id: buyerRef.referred_by, type: 'referral_reward', amount: commission,
            description: `Hoa hồng 2% — ${order.buyer_name}: ${order.event_name}`, order_id: order.id
          });
        }
      }
    }
  } catch(e) {}

  res.json({ message: 'Xác nhận nhận hàng thành công! Tiền đã được giải ngân cho người bán.' });
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
    status: 'pending'
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
    vnp_ExpireDate: expireDate
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
          description: `Nạp tiền qua VNPay — Mã GD: ${txnRef}`
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
        description: `Nạp tiền thất bại qua VNPay — Mã GD: ${txnRef} — Mã lỗi: ${responseCode}`
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
        description: `Nạp tiền qua VNPay (IPN) — Mã GD: ${txnRef}`
      });
      createNotification(pending.userId, 'topup', '💰 Nạp tiền thành công',
        `Đã nạp ${amount.toLocaleString('vi-VN')}đ vào ví SafePass.`, '/wallet');
    }
  } else {
    await supabase.from('transactions').insert({
      user_id: pending.userId,
      type: 'topup_failed',
      amount: 0,
      description: `Nạp tiền thất bại qua VNPay (IPN) — Mã GD: ${txnRef} — Mã lỗi: ${responseCode}`
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
    description: `Hoàn tiền VNPay — ${sanitize(reason || 'Admin xử lý')}`
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
    total_sold: totalSold || 0
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
    message_type: 'text'
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
      text: String(text).trim().slice(0, 80)
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
    image_url: imageUrl
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
        if (order.listing_id) {
          await supabase.from('listings').update({ status: 'available' }).eq('id', order.listing_id);
        } else if (order.ticket_id) {
          await supabase.from('tickets').update({ status: 'available' }).eq('id', order.ticket_id);
        }
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
        if (order.listing_id) {
          await supabase.from('listings').update({ status: 'available' }).eq('id', order.listing_id);
        } else if (order.ticket_id) {
          await supabase.from('tickets').update({ status: 'available' }).eq('id', order.ticket_id);
        }
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

  // 3. Auto-release shipping orders sau 7 ngày buyer không phản hồi
  const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: oldShipping } = await supabase
    .from('shipping_orders').select('order_id').eq('shipping_status', 'shipping').lt('created_at', cutoff7d);

  if (oldShipping && oldShipping.length > 0) {
    const orderIds = oldShipping.map(s => s.order_id);
    const { data: shippingOrders } = await supabase
      .from('orders').select('*').in('id', orderIds).eq('status', 'shipping');

    for (const order of (shippingOrders || [])) {
      try {
        const { data: buyer } = await supabase.from('users').select('*').eq('id', order.buyer_id).single();
        const { data: seller } = await supabase.from('users').select('*').eq('id', order.seller_id).single();
        if (!buyer || !seller) continue;

        await supabase.from('users').update({ escrow: Math.max(0, buyer.escrow - order.total) }).eq('id', order.buyer_id);
        await supabase.from('users').update({ balance: seller.balance + order.price }).eq('id', order.seller_id);
        await supabase.from('orders').update({ status: 'completed' }).eq('id', order.id);
        if (order.listing_id) {
          await supabase.from('listings').update({ status: 'sold' }).eq('id', order.listing_id);
        }
        await supabase.from('shipping_orders')
          .update({ shipping_status: 'completed', updated_at: new Date().toISOString() })
          .eq('order_id', order.id);
        await supabase.from('transactions').insert([
          { user_id: order.seller_id, type: 'payout', amount: order.price,
            description: `Tự động giải ngân sau 7 ngày: ${order.event_name}`, order_id: order.id },
          { user_id: order.buyer_id, type: 'escrow_release', amount: 0,
            description: `Tự động hoàn tất sau 7 ngày giao hàng: ${order.event_name}`, order_id: order.id }
        ]);
        createNotification(order.seller_id, 'payout', '💸 Tự động giải ngân sau 7 ngày',
          `Đơn ${order.event_name} đã tự động giải ngân vì buyer không phản hồi sau 7 ngày.`, '/wallet');
        createNotification(order.buyer_id, 'info', 'ℹ️ Đơn hàng tự động hoàn tất',
          `Đơn ${order.event_name} đã tự động hoàn tất sau 7 ngày không phản hồi.`, '/orders');
        console.log(`[Shipping Auto-release] Giải ngân đơn ${order.id}`);
      } catch(e) { console.error(`[Shipping Auto-release] Lỗi ${order.id}:`, e.message); }
    }
  }
}

processExpiredEscrows();
setInterval(processExpiredEscrows, 60 * 60 * 1000);
setInterval(autoConfirmDigitalOrders, 60 * 60 * 1000);
setInterval(autoReleaseServiceOrders, 60 * 60 * 1000);

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
    supabase.from('reviews').select('rating,created_at').eq('seller_id', sellerId)
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
    avg_rating: d.ratingCount > 0 ? Math.round((d.ratingSum / d.ratingCount) * 10) / 10 : null
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
    recent_orders: recent
  });
});

// Thống kê doanh thu
app.get('/api/admin/stats', async (req, res) => {
  if (adminSecret(req) !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const [{ data: orders }, { data: users }, { data: tickets }, { data: listings }] = await Promise.all([
    supabase.from('orders').select('status,fee,total,price,created_at'),
    supabase.from('users').select('id,balance,escrow,is_banned'),
    supabase.from('tickets').select('status'),
    supabase.from('listings').select('status,type')
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
  const availableListings = (listings || []).filter(l => l.status === 'available').length;
  const listingsByType = {};
  (listings || []).forEach(l => { listingsByType[l.type] = (listingsByType[l.type] || 0) + 1; });

  res.json({
    totalRevenue, totalGMV, totalOrders, completedOrders, disputedOrders, refundedOrders,
    totalUsers, bannedUsers, totalEscrowLocked, availableTickets, availableListings, listingsByType
  });
});

// ── SETUP STATUS — kiểm tra toàn bộ cấu hình hệ thống ──
app.get('/api/admin/setup-status', adminAuth, async (req, res) => {
  const checks = {};

  // 1. Secrets
  checks.secrets = {
    SUPABASE_URL:    !!process.env.SUPABASE_URL && !process.env.SUPABASE_URL.includes('placeholder'),
    SUPABASE_KEY:    !!process.env.SUPABASE_KEY && !process.env.SUPABASE_KEY.includes('placeholder'),
    JWT_SECRET:      !!process.env.JWT_SECRET   && process.env.JWT_SECRET !== 'dev_jwt_secret_replace_me',
    RESEND_API_KEY:  !!process.env.RESEND_API_KEY,
    ADMIN_SECRET:    !!process.env.ADMIN_SECRET,
    VNPAY_TMN_CODE:  !!process.env.VNPAY_TMN_CODE,
    VNPAY_HASH_SECRET: !!process.env.VNPAY_HASH_SECRET
  };

  // 2. Database tables
  const TABLES = [
    'users','tickets','orders','transactions','notifications',
    'reviews','kyc_requests','admin_logs','admins',
    'listings','shipping_orders','service_listings',
    'service_orders','digital_listings','referrals'
  ];
  checks.tables = {};
  await Promise.all(TABLES.map(async t => {
    const { error } = await supabase.from(t).select('id').limit(1);
    checks.tables[t] = !error;
  }));

  // 3. Storage buckets
  const BUCKETS = ['kyc-documents','chat-images','ticket-images','deliverables'];
  checks.buckets = {};
  await Promise.all(BUCKETS.map(async b => {
    const { error } = await supabase.storage.from(b).list('', { limit: 1 });
    checks.buckets[b] = !error;
  }));

  // 4. DB connectivity
  const { error: dbErr } = await supabase.from('users').select('id').limit(1);
  checks.dbConnected = !dbErr;

  // 5. Admin count
  const { count: adminCount } = await supabase.from('admins').select('*', { count: 'exact', head: true });
  checks.adminCount = adminCount || 0;

  // 6. Summary score
  const secretsOk  = Object.values(checks.secrets).filter(Boolean).length;
  const tablesOk   = Object.values(checks.tables).filter(Boolean).length;
  const bucketsOk  = Object.values(checks.buckets).filter(Boolean).length;
  checks.score = {
    secrets:  { ok: secretsOk,  total: Object.keys(checks.secrets).length },
    tables:   { ok: tablesOk,   total: TABLES.length },
    buckets:  { ok: bucketsOk,  total: BUCKETS.length }
  };

  res.json(checks);
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
    escrow: Math.max(0, buyer.escrow - order.total)
  }).eq('id', order.buyer_id);

  if (order.listing_id) {
    await supabase.from('listings').update({ status: 'available' }).eq('id', order.listing_id);
  } else if (order.ticket_id) {
    await supabase.from('tickets').update({ status: 'available' }).eq('id', order.ticket_id);
  }
  await supabase.from('orders').update({
    status: 'refunded',
    dispute_note: sanitize(note || 'Admin force cancelled'),
    dispute_resolved_at: new Date().toISOString()
  }).eq('id', req.params.id);

  await supabase.from('transactions').insert([
    { user_id: order.buyer_id, type: 'refund', amount: order.total, description: `Admin hủy đơn — hoàn tiền: ${order.event_name}${note ? ' — ' + sanitize(note) : ''}`, order_id: order.id },
    { user_id: order.seller_id, type: 'admin_action', amount: 0, description: `Admin hủy đơn: ${order.event_name}`, order_id: order.id }
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
  if (order.listing_id) {
    await supabase.from('listings').update({ status: 'sold' }).eq('id', order.listing_id);
  } else if (order.ticket_id) {
    await supabase.from('tickets').update({ status: 'sold' }).eq('id', order.ticket_id);
  }
  await supabase.from('orders').update({
    status: 'completed',
    dispute_note: sanitize(note || 'Admin force released'),
    dispute_resolved_at: new Date().toISOString()
  }).eq('id', req.params.id);

  await supabase.from('transactions').insert([
    { user_id: order.seller_id, type: 'payout', amount: order.price, description: `Admin giải ngân: ${order.event_name}${note ? ' — ' + sanitize(note) : ''}`, order_id: order.id },
    { user_id: order.buyer_id, type: 'admin_action', amount: 0, description: `Admin giải ngân đơn hàng: ${order.event_name}`, order_id: order.id }
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

// ── ADMIN LISTINGS ──

app.get('/api/admin/listings', adminAuth, async (req, res) => {
  const { type, status, search } = req.query;
  let query = supabase.from('listings').select('*').order('created_at', { ascending: false }).limit(300);
  if (type) query = query.eq('type', type);
  if (status) query = query.eq('status', status);
  if (search) query = query.or(`title.ilike.%${search}%,seller_name.ilike.%${search}%`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.delete('/api/admin/listings/:id', adminAuth, async (req, res) => {
  const { error } = await supabase.from('listings').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  logAdminAction(req.admin.id, req.admin.email, 'delete_listing', 'listing', req.params.id);
  res.json({ message: 'Đã xóa listing.' });
});

// GET /api/admin/shipping — admin xem tất cả vận đơn
app.get('/api/admin/shipping', adminAuth, async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('shipping_orders')
    .select('*, orders(id, event_name, buyer_name, seller_name, total, price, status, buyer_id, seller_id, listing_type)')
    .order('created_at', { ascending: false }).limit(200);
  if (status) query = query.eq('shipping_status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.patch('/api/admin/listings/:id/hide', adminAuth, async (req, res) => {
  const { hidden } = req.body;
  const { error } = await supabase.from('listings').update({ status: hidden ? 'hidden' : 'available' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  logAdminAction(req.admin.id, req.admin.email, hidden ? 'hide_listing' : 'unhide_listing', 'listing', req.params.id);
  res.json({ message: hidden ? 'Đã ẩn listing' : 'Đã hiện listing' });
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
      errorCorrectionLevel: 'H'
    });
    res.json({
      qr: qrDataUrl,
      token,
      order_id: order.id,
      event_name: order.event_name,
      buyer_name: order.buyer_name
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
      created_at: order.created_at
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
        scan_count: scans.length
      });
    }

    // First time — record scan
    await supabase.from('ticket_scans').insert({
      order_id,
      scanned_by: sanitize(scanner_name || 'Không rõ'),
      scanner_type: scanner_type || 'organizer'
    });

    res.json({
      status: 'VALID',
      ticket: ticketInfo,
      scanned_at: new Date().toISOString(),
      scanner_name: scanner_name || 'Không rõ'
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
  { name: 'selfie_image', maxCount: 1 }
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
      uploadOne('selfie', files.selfie_image[0])
    ]);

    const { error: dbErr } = await supabase.from('kyc_requests').insert({
      user_id: userId,
      front_image: frontPath,
      back_image: backPath,
      selfie_image: selfiePath,
      status: 'pending',
      full_name: req.body?.full_name || null,
      id_type: req.body?.id_type || null
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
app.get('/api/admin/kyc', adminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase
      .from('kyc_requests')
      .select('*, users(name, phone, email)')
      .order('created_at', { ascending: false });
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      query = query.eq('status', status);
    }
    const { data, error } = await query;
    if (error) throw error;

    const withUrls = await Promise.all((data || []).map(async (kyc) => {
      const [fRes, bRes, sRes] = await Promise.all([
        supabase.storage.from('kyc-documents').createSignedUrl(kyc.front_image, 3600),
        supabase.storage.from('kyc-documents').createSignedUrl(kyc.back_image, 3600),
        supabase.storage.from('kyc-documents').createSignedUrl(kyc.selfie_image, 3600)
      ]);
      return {
        ...kyc,
        front_url: fRes.data?.signedUrl || null,
        back_url: bRes.data?.signedUrl || null,
        selfie_url: sRes.data?.signedUrl || null
      };
    }));

    res.json(withUrls);
  } catch (e) {
    console.error('[KYC] admin list:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/kyc/:id/approve
app.post('/api/admin/kyc/:id/approve', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { review_notes } = req.body;
    const { data: kyc, error: fetchErr } = await supabase
      .from('kyc_requests').select('user_id, status').eq('id', id).single();
    if (fetchErr || !kyc) return res.status(404).json({ error: 'Không tìm thấy yêu cầu KYC' });
    if (kyc.status === 'approved') return res.status(400).json({ error: 'Đã duyệt rồi' });

    const admin = req.admin || { id: null, email: 'legacy' };
    await supabase.from('kyc_requests').update({
      status: 'approved',
      review_notes: review_notes || null,
      reviewed_by: admin.email,
      reviewed_at: new Date().toISOString()
    }).eq('id', id);
    await supabase.from('users').update({ is_verified: true }).eq('id', kyc.user_id);

    logAdminAction(admin.id, admin.email, 'approve_kyc', 'kyc_request', id, { user_id: kyc.user_id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/kyc/:id/reject
app.post('/api/admin/kyc/:id/reject', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, review_notes } = req.body;
    const { data: kyc, error: fetchErr } = await supabase
      .from('kyc_requests').select('status,user_id').eq('id', id).single();
    if (fetchErr || !kyc) return res.status(404).json({ error: 'Không tìm thấy yêu cầu KYC' });

    const admin = req.admin || { id: null, email: 'legacy' };
    const note = review_notes || reason || null;
    await supabase.from('kyc_requests').update({
      status: 'rejected',
      reject_reason: reason || null,
      review_notes: note,
      reviewed_by: admin.email,
      reviewed_at: new Date().toISOString()
    }).eq('id', id);

    logAdminAction(admin.id, admin.email, 'reject_kyc', 'kyc_request', id, { user_id: kyc.user_id, reason: reason || '' });
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
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: sysPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content }))
      })
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
    recent_rewards: recentRewards || []
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
    message_type: 'text'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  createNotification(order.buyer_id, 'system', '📨 Admin gửi tin nhắn',
    `Admin đã gửi tin nhắn trong đơn hàng ${order.event_name}`, '/orders');
  createNotification(order.seller_id, 'system', '📨 Admin gửi tin nhắn',
    `Admin đã gửi tin nhắn trong đơn hàng ${order.event_name}`, '/orders');
  logAdminAction(req.admin.id, req.admin.email, 'send_message', 'order', req.params.id);
  res.json(data);
});

// ════════════════════════════════════════════════════
//  DIGITAL ACCOUNT PASS — Pass Tài Khoản
// ════════════════════════════════════════════════════

// ── Encryption helpers (AES-256-GCM) ──
function getEncKey() {
  return crypto.createHash('sha256').update(JWT_SECRET || 'safepass-fallback').digest();
}
function encryptField(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncKey(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + '.' + tag.toString('hex') + '.' + enc.toString('hex');
}
function decryptField(stored) {
  if (!stored) return null;
  try {
    const [ivHex, tagHex, encHex] = stored.split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
  } catch { return null; }
}

// ── GET /api/digital-listings — browse ──
app.get('/api/digital-listings', async (req, res) => {
  const { asset_type, seller_id, page = 1, limit = 20 } = req.query;
  let q = supabase.from('digital_listings')
    .select('*, users!digital_listings_seller_id_fkey(name,id)', { count: 'exact' })
    .eq('status', 'active')
    .gt('available_qty', 0)
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  if (asset_type && asset_type !== 'all') q = q.eq('asset_type', asset_type);
  if (seller_id) q = q.eq('seller_id', seller_id);
  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ listings: data, total: count, page: +page, limit: +limit });
});

// ── GET /api/digital-listings/:id ──
app.get('/api/digital-listings/:id', async (req, res) => {
  const { data, error } = await supabase.from('digital_listings')
    .select('*, users!digital_listings_seller_id_fkey(name,id)')
    .eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json(data);
});

// ── POST /api/digital-listings — seller tạo listing ──
app.post('/api/digital-listings', auth, async (req, res) => {
  const { title, description, asset_type, price, image_url } = req.body;
  if (!title || !asset_type || !price) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
  if (price < 1000) return res.status(400).json({ error: 'Giá tối thiểu 1,000đ' });
  const { data, error } = await supabase.from('digital_listings').insert({
    seller_id: req.user.id,
    title: sanitize(title),
    description: sanitize(description || ''),
    asset_type,
    price: parseInt(price),
    image_url: image_url || null,
    available_qty: 0, total_qty: 0, sold_qty: 0
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PUT /api/digital-listings/:id — seller cập nhật ──
app.put('/api/digital-listings/:id', auth, async (req, res) => {
  const { data: listing } = await supabase.from('digital_listings').select('seller_id').eq('id', req.params.id).single();
  if (!listing || listing.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  const { title, description, price, status } = req.body;
  const upd = { updated_at: new Date().toISOString() };
  if (title) upd.title = sanitize(title);
  if (description !== undefined) upd.description = sanitize(description);
  if (price) upd.price = parseInt(price);
  if (status) upd.status = status;
  const { data, error } = await supabase.from('digital_listings').update(upd).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/digital-listings/:id/inventory — seller upload kho tài khoản ──
app.post('/api/digital-listings/:id/inventory', auth, async (req, res) => {
  const { data: listing } = await supabase.from('digital_listings').select('seller_id').eq('id', req.params.id).single();
  if (!listing) return res.status(404).json({ error: 'Listing không tồn tại' });
  if (listing.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });

  const { accounts } = req.body; // array of { username, password, backup_email?, notes? }
  if (!Array.isArray(accounts) || accounts.length === 0) return res.status(400).json({ error: 'Cần ít nhất 1 tài khoản' });
  if (accounts.length > 500) return res.status(400).json({ error: 'Tối đa 500 tài khoản mỗi lần upload' });

  const rows = accounts.map(a => ({
    listing_id: req.params.id,
    seller_id: req.user.id,
    username_enc: encryptField(a.username),
    password_enc: encryptField(a.password),
    backup_email_enc: encryptField(a.backup_email || null),
    notes_enc: encryptField(a.notes || null),
    status: 'available'
  }));

  const { data, error } = await supabase.from('asset_inventory').insert(rows).select('id');
  if (error) return res.status(500).json({ error: error.message });

  // Update listing counts
  const { data: inv } = await supabase.from('asset_inventory')
    .select('id', { count: 'exact' }).eq('listing_id', req.params.id).eq('status', 'available');
  const { data: soldInv } = await supabase.from('asset_inventory')
    .select('id', { count: 'exact' }).eq('listing_id', req.params.id).eq('status', 'sold');
  await supabase.from('digital_listings').update({
    available_qty: inv?.length || 0,
    total_qty: (inv?.length || 0) + (soldInv?.length || 0),
    updated_at: new Date().toISOString()
  }).eq('id', req.params.id);

  res.json({ added: data.length });
});

// ── GET /api/digital-listings/:id/stats — seller xem kho ──
app.get('/api/digital-listings/:id/stats', auth, async (req, res) => {
  const { data: listing } = await supabase.from('digital_listings').select('*').eq('id', req.params.id).single();
  if (!listing) return res.status(404).json({ error: 'Không tìm thấy' });
  if (listing.seller_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Không có quyền' });

  const { data: inv } = await supabase.from('asset_inventory')
    .select('id,status,created_at').eq('listing_id', req.params.id);
  const stats = { available: 0, reserved: 0, sold: 0, disabled: 0 };
  (inv || []).forEach(i => { stats[i.status] = (stats[i.status] || 0) + 1; });
  res.json({ listing, stats, total: inv?.length || 0 });
});

// ── POST /api/digital-orders — buyer mua → auto-deliver ──
app.post('/api/digital-orders', auth, async (req, res) => {
  const { listing_id } = req.body;
  if (!listing_id) return res.status(400).json({ error: 'Thiếu listing_id' });

  const { data: listing } = await supabase.from('digital_listings').select('*').eq('id', listing_id).single();
  if (!listing) return res.status(404).json({ error: 'Listing không tồn tại' });
  if (listing.status !== 'active') return res.status(400).json({ error: 'Listing không còn hoạt động' });
  if (listing.seller_id === req.user.id) return res.status(400).json({ error: 'Không thể tự mua listing của mình' });

  // Check buyer balance
  const { data: buyer } = await supabase.from('users').select('balance').eq('id', req.user.id).single();
  if (!buyer || buyer.balance < listing.price) return res.status(400).json({ error: 'Số dư không đủ' });

  // Reserve an available account (atomic-ish — pick first available)
  const { data: accounts } = await supabase.from('asset_inventory')
    .select('id').eq('listing_id', listing_id).eq('status', 'available').limit(1);
  if (!accounts || accounts.length === 0) return res.status(400).json({ error: 'Hết tài khoản. Vui lòng thử lại sau.' });
  const inventoryId = accounts[0].id;

  // Mark as reserved
  await supabase.from('asset_inventory').update({ status: 'reserved', reserved_at: new Date().toISOString() }).eq('id', inventoryId).eq('status', 'available');

  // Deduct buyer balance
  const fee = Math.round(listing.price * (listing.fee_percent / 100));
  const sellerPayout = listing.price - fee;
  await supabase.from('users').update({ balance: buyer.balance - listing.price }).eq('id', req.user.id);

  // Create digital order
  const { data: order, error: orderErr } = await supabase.from('digital_orders').insert({
    listing_id,
    inventory_id: inventoryId,
    buyer_id: req.user.id,
    seller_id: listing.seller_id,
    listing_title: listing.title,
    asset_type: listing.asset_type,
    price: listing.price,
    fee,
    seller_payout: sellerPayout,
    status: 'delivered',
    delivered_at: new Date().toISOString()
  }).select().single();

  if (orderErr) {
    // Rollback
    await supabase.from('users').update({ balance: buyer.balance }).eq('id', req.user.id);
    await supabase.from('asset_inventory').update({ status: 'available', reserved_at: null }).eq('id', inventoryId);
    return res.status(500).json({ error: orderErr.message });
  }

  // Mark inventory as sold + link order
  await supabase.from('asset_inventory').update({
    status: 'sold', sold_at: new Date().toISOString(), digital_order_id: order.id
  }).eq('id', inventoryId);

  // Update listing counts
  await supabase.from('digital_listings').update({
    available_qty: Math.max(0, listing.available_qty - 1),
    sold_qty: listing.sold_qty + 1,
    updated_at: new Date().toISOString()
  }).eq('id', listing_id);

  // Notify seller
  createNotification(listing.seller_id, 'order', '🛒 Đơn tài khoản mới',
    `Buyer đã mua "${listing.title}". Tiền đang escrow.`, '/digital-orders');
  createNotification(req.user.id, 'order', '✅ Mua thành công',
    `Bạn đã mua "${listing.title}". Kiểm tra thông tin tài khoản ngay.`, '/digital-orders');

  res.json({ order_id: order.id, message: 'Mua thành công! Tài khoản đã được giao.' });
});

// ── GET /api/digital-orders — danh sách đơn ──
app.get('/api/digital-orders', auth, async (req, res) => {
  const { role } = req.query; // buyer | seller
  let q = supabase.from('digital_orders').select('*').order('created_at', { ascending: false });
  if (role === 'seller') q = q.eq('seller_id', req.user.id);
  else q = q.eq('buyer_id', req.user.id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── GET /api/digital-orders/:id/asset — buyer xem tài khoản đã mua ──
app.get('/api/digital-orders/:id/asset', auth, async (req, res) => {
  const { data: order } = await supabase.from('digital_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.buyer_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Không có quyền' });
  if (!['delivered', 'confirmed', 'disputed', 'replaced'].includes(order.status)) return res.status(400).json({ error: 'Tài khoản chưa sẵn sàng' });

  const { data: inv } = await supabase.from('asset_inventory').select('*').eq('id', order.inventory_id).single();
  if (!inv) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });

  res.json({
    order_id: order.id,
    listing_title: order.listing_title,
    asset_type: order.asset_type,
    username: decryptField(inv.username_enc),
    password: decryptField(inv.password_enc),
    backup_email: decryptField(inv.backup_email_enc),
    notes: decryptField(inv.notes_enc),
    delivered_at: order.delivered_at,
    status: order.status
  });
});

// ── POST /api/digital-orders/:id/confirm — buyer xác nhận ──
app.post('/api/digital-orders/:id/confirm', auth, async (req, res) => {
  const { data: order } = await supabase.from('digital_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (order.status !== 'delivered') return res.status(400).json({ error: 'Không thể xác nhận ở trạng thái này' });

  // Release escrow → seller
  const { data: seller } = await supabase.from('users').select('balance').eq('id', order.seller_id).single();
  await supabase.from('users').update({ balance: (seller?.balance || 0) + order.seller_payout }).eq('id', order.seller_id);
  await supabase.from('digital_orders').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', order.id);

  createNotification(order.seller_id, 'payout', '💸 Nhận tiền tài khoản',
    `Buyer đã xác nhận "${order.listing_title}". ${order.seller_payout.toLocaleString('vi-VN')}đ vào ví.`, '/wallet');
  res.json({ message: 'Đã xác nhận. Tiền đã giải ngân cho seller.' });
});

// ── POST /api/digital-orders/:id/report — buyer báo lỗi ──
app.post('/api/digital-orders/:id/report', auth, async (req, res) => {
  const { reason } = req.body;
  const { data: order } = await supabase.from('digital_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (!['delivered', 'replaced'].includes(order.status)) return res.status(400).json({ error: 'Không thể báo lỗi ở trạng thái này' });

  await supabase.from('digital_orders').update({
    status: 'disputed', dispute_reason: sanitize(reason || 'Không đăng nhập được'),
    dispute_at: new Date().toISOString()
  }).eq('id', order.id);

  createNotification(order.seller_id, 'dispute', '⚠️ Khiếu nại tài khoản',
    `Buyer báo lỗi "${order.listing_title}": ${reason}. Admin đang xem xét.`, '/digital-orders');
  res.json({ message: 'Đã gửi báo lỗi. Admin sẽ xử lý sớm.' });
});

// ── GET /api/admin/digital-orders — admin xem tất cả ──
app.get('/api/admin/digital-orders', adminAuth, async (req, res) => {
  const { status } = req.query;
  let q = supabase.from('digital_orders').select('*').order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  // Enrich with buyer/seller names
  const userIds = [...new Set([...data.map(o => o.buyer_id), ...data.map(o => o.seller_id)])];
  const { data: users } = await supabase.from('users').select('id,name,phone').in('id', userIds);
  const userMap = Object.fromEntries((users || []).map(u => [u.id, u]));
  const enriched = data.map(o => ({
    ...o,
    buyer_name: userMap[o.buyer_id]?.name || '—',
    seller_name: userMap[o.seller_id]?.name || '—'
  }));
  res.json(enriched);
});

// ── POST /api/admin/digital-orders/:id/replace — admin đổi tài khoản ──
app.post('/api/admin/digital-orders/:id/replace', adminAuth, async (req, res) => {
  const { data: order } = await supabase.from('digital_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });

  // Get a new available account from the same listing
  const { data: accounts } = await supabase.from('asset_inventory')
    .select('id').eq('listing_id', order.listing_id).eq('status', 'available').limit(1);
  if (!accounts || accounts.length === 0) return res.status(400).json({ error: 'Không còn tài khoản thay thế' });

  const newInvId = accounts[0].id;
  // Mark old inventory as disabled
  await supabase.from('asset_inventory').update({ status: 'disabled' }).eq('id', order.inventory_id);
  // Mark new inventory as sold
  await supabase.from('asset_inventory').update({
    status: 'sold', sold_at: new Date().toISOString(), digital_order_id: order.id
  }).eq('id', newInvId);

  // Update order
  const { admin_note } = req.body;
  await supabase.from('digital_orders').update({
    inventory_id: newInvId, status: 'replaced',
    admin_note: sanitize(admin_note || 'Admin đã đổi tài khoản mới'),
    updated_at: new Date().toISOString()
  }).eq('id', order.id);

  // Update listing available count
  const { data: listing } = await supabase.from('digital_listings').select('available_qty').eq('id', order.listing_id).single();
  await supabase.from('digital_listings').update({ available_qty: Math.max(0, (listing?.available_qty || 1) - 1) }).eq('id', order.listing_id);

  logAdminAction(req.admin.id, req.admin.email, 'replace_digital_account', 'digital_order', order.id);
  createNotification(order.buyer_id, 'order', '🔄 Tài khoản đã được thay',
    `Admin đã cung cấp tài khoản mới cho "${order.listing_title}".`, '/digital-orders');
  res.json({ message: 'Đã thay tài khoản mới thành công.' });
});

// ── POST /api/admin/digital-orders/:id/refund — admin hoàn tiền ──
app.post('/api/admin/digital-orders/:id/refund', adminAuth, async (req, res) => {
  const { data: order } = await supabase.from('digital_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.status === 'confirmed') return res.status(400).json({ error: 'Đơn đã xác nhận, không thể hoàn tiền' });

  const { data: buyer } = await supabase.from('users').select('balance').eq('id', order.buyer_id).single();
  await supabase.from('users').update({ balance: (buyer?.balance || 0) + order.price }).eq('id', order.buyer_id);
  await supabase.from('digital_orders').update({
    status: 'refunded', admin_note: sanitize(req.body.admin_note || 'Admin hoàn tiền'),
    updated_at: new Date().toISOString()
  }).eq('id', order.id);

  // Free up inventory if still sellable
  if (order.inventory_id) {
    await supabase.from('asset_inventory').update({ status: 'disabled' }).eq('id', order.inventory_id);
  }

  logAdminAction(req.admin.id, req.admin.email, 'refund_digital_order', 'digital_order', order.id);
  createNotification(order.buyer_id, 'refund', '✅ Hoàn tiền tài khoản số',
    `${order.price.toLocaleString('vi-VN')}đ đã được hoàn về ví.`, '/wallet');
  res.json({ message: 'Hoàn tiền thành công.' });
});

// ── Auto-confirm digital orders after 24h (run with escrow checker) ──
async function autoConfirmDigitalOrders() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: orders } = await supabase.from('digital_orders')
    .select('*').eq('status', 'delivered').lt('delivered_at', cutoff);
  if (!orders || orders.length === 0) return;
  for (const order of orders) {
    const { data: seller } = await supabase.from('users').select('balance').eq('id', order.seller_id).single();
    await supabase.from('users').update({ balance: (seller?.balance || 0) + order.seller_payout }).eq('id', order.seller_id);
    await supabase.from('digital_orders').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', order.id);
    createNotification(order.seller_id, 'payout', '💸 Tự động giải ngân',
      `"${order.listing_title}" đã qua 24h. ${order.seller_payout.toLocaleString('vi-VN')}đ vào ví.`, '/wallet');
    console.log(`[DigitalEscrow] Auto-confirmed order ${order.id}`);
  }
}

// ══════════════════════════════════════════════════════════
//  PASS DỊCH VỤ — FREELANCE MARKETPLACE
// ══════════════════════════════════════════════════════════

const SERVICE_FEE_RATE = 0.05; // 5%
const SERVICE_AUTO_RELEASE_DAYS = 5;
const SERVICE_CATEGORIES = ['Thiết kế Logo','Thiết kế Website','Lập trình','Edit Video','Motion Graphic','Content Marketing','SEO','Facebook Ads','Google Ads','Dịch Thuật','Gia Sư','Tư Vấn','Khác'];

const deliverableUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (['pdf','zip','rar','png','jpg','jpeg','mp4','docx','txt'].includes(ext)) return cb(null, true);
    cb(new Error('Định dạng không được phép. Cho phép: PDF, ZIP, RAR, PNG, JPG, MP4, DOCX'));
  }
});

(async () => {
  try { await supabase.storage.createBucket('deliverables', { public: true }); } catch(e) {}
})();

// ── GET /api/service-listings ─────────────────────────────
app.get('/api/service-listings', async (req, res) => {
  const { category, min_price, max_price, sort, search, limit = 20, offset = 0 } = req.query;
  let q = supabase.from('service_listings').select('*,service_packages(*)').eq('status','active');
  if (category) q = q.eq('category', category);
  if (min_price) q = q.gte('price', Number(min_price));
  if (max_price) q = q.lte('price', Number(max_price));
  if (search) q = q.ilike('title', `%${search}%`);
  if (sort === 'price_asc') q = q.order('price', { ascending: true });
  else if (sort === 'price_desc') q = q.order('price', { ascending: false });
  else if (sort === 'rating') q = q.order('avg_rating', { ascending: false });
  else q = q.order('created_at', { ascending: false });
  q = q.range(Number(offset), Number(offset) + Number(limit) - 1);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const sellerIds = [...new Set((data||[]).map(s => s.seller_id))];
  let sellers = {};
  if (sellerIds.length > 0) {
    const { data: su } = await supabase.from('users').select('id,name,avg_rating,review_count,is_verified').in('id', sellerIds);
    (su||[]).forEach(u => sellers[u.id] = u);
  }
  res.json((data||[]).map(s => ({ ...s, seller: sellers[s.seller_id] || null })));
});

// ── GET /api/service-listings/mine ───────────────────────
app.get('/api/service-listings/mine', auth, async (req, res) => {
  const { data, error } = await supabase.from('service_listings')
    .select('*,service_packages(*)').eq('seller_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── GET /api/service-listings/:id ────────────────────────
app.get('/api/service-listings/:id', async (req, res) => {
  const { data, error } = await supabase.from('service_listings')
    .select('*,service_packages(*)').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'Không tìm thấy dịch vụ' });
  const { data: seller } = await supabase.from('users')
    .select('id,name,avg_rating,review_count,is_verified,created_at').eq('id', data.seller_id).single();
  const { data: reviews } = await supabase.from('service_reviews')
    .select('*').eq('service_id', req.params.id).order('created_at', { ascending: false }).limit(10);
  const reviewerIds = (reviews||[]).map(r => r.buyer_id);
  let reviewers = {};
  if (reviewerIds.length > 0) {
    const { data: ru } = await supabase.from('users').select('id,name').in('id', reviewerIds);
    (ru||[]).forEach(u => reviewers[u.id] = u.name);
  }
  res.json({ ...data, seller, reviews: (reviews||[]).map(r => ({ ...r, buyer_name: reviewers[r.buyer_id] || '?' })) });
});

// ── POST /api/service-listings ───────────────────────────
app.post('/api/service-listings', auth, async (req, res) => {
  const { category, title, description, price, delivery_days, revision_count, image_url, packages } = req.body;
  if (!category || !title || !description || !price) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
  if (!SERVICE_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Danh mục không hợp lệ' });
  if (Number(price) < 10000) return res.status(400).json({ error: 'Giá tối thiểu 10,000đ' });
  const { data, error } = await supabase.from('service_listings').insert({
    seller_id: req.user.id, category, title: sanitize(title),
    description: sanitize(description), price: Number(price),
    delivery_days: Number(delivery_days) || 3,
    revision_count: Number(revision_count) || 1,
    image_url: image_url || null, status: 'active'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (packages && packages.length > 0) {
    await supabase.from('service_packages').insert(packages.map(p => ({
      service_id: data.id, package_name: p.package_name,
      price: Number(p.price), delivery_days: Number(p.delivery_days),
      revision_count: Number(p.revision_count) || 1, features: p.features || []
    })));
  }
  res.json({ id: data.id, message: 'Tạo gig thành công!' });
});

// ── PUT /api/service-listings/:id ────────────────────────
app.put('/api/service-listings/:id', auth, async (req, res) => {
  const { data: svc } = await supabase.from('service_listings').select('seller_id').eq('id', req.params.id).single();
  if (!svc) return res.status(404).json({ error: 'Không tìm thấy' });
  if (svc.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  const { category, title, description, price, delivery_days, revision_count, image_url, status } = req.body;
  const u = {};
  if (category) u.category = category;
  if (title) u.title = sanitize(title);
  if (description) u.description = sanitize(description);
  if (price) u.price = Number(price);
  if (delivery_days) u.delivery_days = Number(delivery_days);
  if (revision_count !== undefined) u.revision_count = Number(revision_count);
  if (image_url !== undefined) u.image_url = image_url;
  if (status && ['active','paused'].includes(status)) u.status = status;
  u.updated_at = new Date().toISOString();
  const { error } = await supabase.from('service_listings').update(u).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Đã cập nhật' });
});

// ── POST /api/service-orders ─────────────────────────────
app.post('/api/service-orders', auth, orderLimit, async (req, res) => {
  const { service_id, package_id, requirements } = req.body;
  if (!service_id) return res.status(400).json({ error: 'Thiếu service_id' });
  const { data: svc } = await supabase.from('service_listings').select('*').eq('id', service_id).single();
  if (!svc) return res.status(404).json({ error: 'Dịch vụ không tồn tại' });
  if (svc.status !== 'active') return res.status(400).json({ error: 'Dịch vụ không nhận đơn' });
  if (svc.seller_id === req.user.id) return res.status(400).json({ error: 'Không thể tự thuê dịch vụ mình' });
  let finalPrice = svc.price, maxRevisions = svc.revision_count, deliveryDays = svc.delivery_days, pkgName = 'Cơ bản';
  if (package_id) {
    const { data: pkg } = await supabase.from('service_packages').select('*').eq('id', package_id).eq('service_id', service_id).single();
    if (!pkg) return res.status(400).json({ error: 'Package không hợp lệ' });
    finalPrice = pkg.price; maxRevisions = pkg.revision_count; deliveryDays = pkg.delivery_days; pkgName = pkg.package_name;
  }
  const { data: buyer } = await supabase.from('users').select('balance,is_vip').eq('id', req.user.id).single();
  if (!buyer || buyer.balance < finalPrice) return res.status(400).json({ error: `Số dư không đủ. Cần ${finalPrice.toLocaleString('vi-VN')}đ, hiện có ${(buyer?.balance||0).toLocaleString('vi-VN')}đ` });
  const feeRate = buyer.is_vip ? 0.015 : SERVICE_FEE_RATE;
  const fee = Math.round(finalPrice * feeRate);
  const sellerPayout = finalPrice - fee;
  const deadlineAt = new Date(Date.now() + deliveryDays * 86400000).toISOString();
  const autoReleaseAt = new Date(Date.now() + (deliveryDays + SERVICE_AUTO_RELEASE_DAYS) * 86400000).toISOString();
  await supabase.from('users').update({ balance: buyer.balance - finalPrice }).eq('id', req.user.id);
  const { data: order, error: orderErr } = await supabase.from('service_orders').insert({
    service_id, package_id: package_id || null, buyer_id: req.user.id, seller_id: svc.seller_id,
    package_name: pkgName, service_title: svc.title, price: finalPrice, fee, seller_payout: sellerPayout,
    status: 'pending', requirements: requirements || null, max_revisions: maxRevisions,
    deadline_at: deadlineAt, auto_release_at: autoReleaseAt
  }).select().single();
  if (orderErr) {
    await supabase.from('users').update({ balance: buyer.balance }).eq('id', req.user.id);
    return res.status(500).json({ error: orderErr.message });
  }
  await supabase.from('service_listings').update({ total_orders: (svc.total_orders||0) + 1 }).eq('id', service_id);
  createNotification(svc.seller_id, 'order', '🛒 Đơn dịch vụ mới!', `Đơn mới: "${svc.title}". Hạn: ${new Date(deadlineAt).toLocaleDateString('vi-VN')}`, '/service-orders');
  createNotification(req.user.id, 'order', '✅ Đặt dịch vụ thành công', `"${svc.title}" đã được đặt. Tiền escrow.`, '/service-orders');
  res.json({ order_id: order.id, message: 'Đặt dịch vụ thành công!' });
});

// ── GET /api/service-orders ──────────────────────────────
app.get('/api/service-orders', auth, async (req, res) => {
  const { role } = req.query;
  let q = supabase.from('service_orders').select('*').order('created_at', { ascending: false });
  if (role === 'seller') q = q.eq('seller_id', req.user.id);
  else q = q.eq('buyer_id', req.user.id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── GET /api/service-orders/:id ──────────────────────────
app.get('/api/service-orders/:id', auth, async (req, res) => {
  const { data: order } = await supabase.from('service_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  const [dRes, mRes, bRes, sRes, rRes] = await Promise.all([
    supabase.from('deliverables').select('*').eq('order_id', order.id).order('created_at'),
    supabase.from('service_messages').select('*').eq('order_id', order.id).order('created_at').limit(200),
    supabase.from('users').select('id,name,avg_rating,is_verified').eq('id', order.buyer_id).single(),
    supabase.from('users').select('id,name,avg_rating,is_verified').eq('id', order.seller_id).single(),
    supabase.from('service_reviews').select('*').eq('order_id', order.id).maybeSingle()
  ]);
  res.json({ ...order, deliverables: dRes.data||[], messages: mRes.data||[], buyer: bRes.data, seller: sRes.data, review: rRes.data });
});

// ── POST /api/service-orders/:id/start ───────────────────
app.post('/api/service-orders/:id/start', auth, async (req, res) => {
  const { data: order } = await supabase.from('service_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (order.status !== 'pending') return res.status(400).json({ error: 'Đơn không ở trạng thái chờ' });
  await supabase.from('service_orders').update({ status: 'in_progress', updated_at: new Date().toISOString() }).eq('id', order.id);
  createNotification(order.buyer_id, 'order', '🔨 Seller bắt đầu làm!', `"${order.service_title}" đang được thực hiện.`, '/service-orders');
  res.json({ message: 'Đã bắt đầu thực hiện' });
});

// ── POST /api/service-orders/:id/submit ──────────────────
app.post('/api/service-orders/:id/submit', auth, async (req, res) => {
  const { message, file_url, file_name } = req.body;
  const { data: order } = await supabase.from('service_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (!['in_progress','revision_requested'].includes(order.status)) return res.status(400).json({ error: 'Không thể nộp ở trạng thái này' });
  if (!message && !file_url) return res.status(400).json({ error: 'Cần nội dung hoặc file' });
  const autoReleaseAt = new Date(Date.now() + SERVICE_AUTO_RELEASE_DAYS * 86400000).toISOString();
  await supabase.from('service_orders').update({ status: 'submitted', submitted_at: new Date().toISOString(), auto_release_at: autoReleaseAt, updated_at: new Date().toISOString() }).eq('id', order.id);
  await supabase.from('deliverables').insert({ order_id: order.id, seller_id: req.user.id, file_url: file_url||null, file_name: file_name||null, message: message||null });
  createNotification(order.buyer_id, 'order', '📦 Seller nộp sản phẩm!', `"${order.service_title}" hoàn thành. Kiểm tra và xác nhận.`, '/service-orders');
  res.json({ message: 'Đã nộp sản phẩm!' });
});

// ── POST /api/service-orders/:id/approve ─────────────────
app.post('/api/service-orders/:id/approve', auth, async (req, res) => {
  const { data: order } = await supabase.from('service_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (order.status !== 'submitted') return res.status(400).json({ error: 'Đơn chưa được nộp' });
  const { data: seller } = await supabase.from('users').select('balance').eq('id', order.seller_id).single();
  await supabase.from('users').update({ balance: (seller?.balance||0) + order.seller_payout }).eq('id', order.seller_id);
  await supabase.from('service_orders').update({ status: 'completed', approved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', order.id);
  createNotification(order.seller_id, 'payout', '💸 Tiền giải ngân!', `"${order.service_title}" xác nhận. ${order.seller_payout.toLocaleString('vi-VN')}đ vào ví.`, '/wallet');
  res.json({ message: 'Đã xác nhận. Tiền giải ngân cho seller.' });
});

// ── POST /api/service-orders/:id/revision ────────────────
app.post('/api/service-orders/:id/revision', auth, async (req, res) => {
  const { note } = req.body;
  const { data: order } = await supabase.from('service_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (order.status !== 'submitted') return res.status(400).json({ error: 'Chỉ yêu cầu sửa khi đã nộp' });
  if (order.revision_count >= order.max_revisions) return res.status(400).json({ error: `Đã dùng hết ${order.max_revisions} lần sửa` });
  const newCount = order.revision_count + 1;
  await supabase.from('service_orders').update({ status: 'revision_requested', revision_count: newCount, updated_at: new Date().toISOString() }).eq('id', order.id);
  await supabase.from('service_messages').insert({ order_id: order.id, sender_id: req.user.id, content: `📝 Yêu cầu sửa (${newCount}/${order.max_revisions}): ${note || 'Không có ghi chú'}` });
  createNotification(order.seller_id, 'order', '📝 Yêu cầu sửa', `"${order.service_title}" cần sửa (${newCount}/${order.max_revisions})`, '/service-orders');
  res.json({ message: `Đã gửi yêu cầu sửa lần ${newCount}` });
});

// ── POST /api/service-orders/:id/dispute ─────────────────
app.post('/api/service-orders/:id/dispute', auth, async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Vui lòng nêu lý do tranh chấp' });
  const { data: order } = await supabase.from('service_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (['completed','cancelled','disputed'].includes(order.status)) return res.status(400).json({ error: 'Không thể tranh chấp ở trạng thái này' });
  await supabase.from('service_orders').update({ status: 'disputed', disputed_at: new Date().toISOString(), dispute_reason: reason, updated_at: new Date().toISOString() }).eq('id', order.id);
  const otherId = order.buyer_id === req.user.id ? order.seller_id : order.buyer_id;
  createNotification(otherId, 'dispute', '⚠️ Tranh chấp mở', `"${order.service_title}" đang tranh chấp. Admin xem xét.`, '/service-orders');
  res.json({ message: 'Đã mở tranh chấp.' });
});

// ── POST /api/service-orders/:id/cancel ──────────────────
app.post('/api/service-orders/:id/cancel', auth, async (req, res) => {
  const { data: order } = await supabase.from('service_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (['completed','cancelled','disputed'].includes(order.status)) return res.status(400).json({ error: 'Không thể huỷ ở trạng thái này' });
  if (order.status === 'submitted') return res.status(400).json({ error: 'Seller đã nộp. Hãy xác nhận hoặc yêu cầu sửa.' });
  if (['pending','in_progress'].includes(order.status)) {
    const { data: buyer } = await supabase.from('users').select('balance').eq('id', order.buyer_id).single();
    await supabase.from('users').update({ balance: (buyer?.balance||0) + order.price }).eq('id', order.buyer_id);
    createNotification(order.buyer_id, 'refund', '↩️ Hoàn tiền', `"${order.service_title}" đã huỷ. ${order.price.toLocaleString('vi-VN')}đ hoàn ví.`, '/wallet');
  }
  await supabase.from('service_orders').update({ status: 'cancelled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', order.id);
  res.json({ message: 'Đã huỷ đơn.' });
});

// ── GET /api/service-orders/:id/messages ─────────────────
app.get('/api/service-orders/:id/messages', auth, async (req, res) => {
  const { data: order } = await supabase.from('service_orders').select('buyer_id,seller_id').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  const { data, error } = await supabase.from('service_messages').select('*').eq('order_id', req.params.id).order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── POST /api/service-orders/:id/messages ────────────────
app.post('/api/service-orders/:id/messages', auth, async (req, res) => {
  const { content, file_url } = req.body;
  if (!content && !file_url) return res.status(400).json({ error: 'Không có nội dung' });
  const { data: order } = await supabase.from('service_orders').select('buyer_id,seller_id').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  const { data, error } = await supabase.from('service_messages').insert({ order_id: req.params.id, sender_id: req.user.id, content: content||null, file_url: file_url||null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  const otherId = order.buyer_id === req.user.id ? order.seller_id : order.buyer_id;
  sendToUser(otherId, { type: 'service_message', order_id: req.params.id, message: data });
  res.json(data);
});

// ── POST /api/service-reviews ────────────────────────────
app.post('/api/service-reviews', auth, async (req, res) => {
  const { order_id, rating, review } = req.body;
  if (!order_id || !rating) return res.status(400).json({ error: 'Thiếu thông tin' });
  if (Number(rating) < 1 || Number(rating) > 5) return res.status(400).json({ error: 'Rating 1-5' });
  const { data: order } = await supabase.from('service_orders').select('*').eq('id', order_id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Chỉ buyer mới được đánh giá' });
  if (order.status !== 'completed') return res.status(400).json({ error: 'Chỉ đánh giá đơn hoàn thành' });
  const { error } = await supabase.from('service_reviews').insert({ order_id, service_id: order.service_id, buyer_id: req.user.id, seller_id: order.seller_id, rating: Number(rating), review: review||null });
  if (error) return res.status(400).json({ error: 'Đã đánh giá đơn này rồi' });
  const { data: reviews } = await supabase.from('service_reviews').select('rating').eq('service_id', order.service_id);
  if (reviews && reviews.length > 0) {
    const avg = reviews.reduce((s,r) => s + r.rating, 0) / reviews.length;
    await supabase.from('service_listings').update({ avg_rating: Math.round(avg * 10) / 10, review_count: reviews.length }).eq('id', order.service_id);
  }
  res.json({ message: 'Đánh giá thành công!' });
});

// ── POST /api/service-orders/:id/upload ──────────────────
app.post('/api/service-orders/:id/upload', auth, deliverableUpload.single('file'), async (req, res) => {
  const { data: order } = await supabase.from('service_orders').select('seller_id').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: 'Chỉ seller mới upload được' });
  if (!req.file) return res.status(400).json({ error: 'Không có file' });
  const ext = req.file.originalname.split('.').pop().toLowerCase();
  const fileName = `${req.params.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await supabase.storage.from('deliverables').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
  if (error) return res.status(500).json({ error: error.message });
  const { data: { publicUrl } } = supabase.storage.from('deliverables').getPublicUrl(fileName);
  res.json({ file_url: publicUrl, file_name: req.file.originalname });
});

// ── Admin: GET /api/admin/service-listings ───────────────
app.get('/api/admin/service-listings', adminAuth, async (req, res) => {
  const { status } = req.query;
  let q = supabase.from('service_listings').select('*').order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const ids = [...new Set((data||[]).map(s => s.seller_id))];
  let sellers = {};
  if (ids.length > 0) {
    const { data: su } = await supabase.from('users').select('id,name').in('id', ids);
    (su||[]).forEach(u => sellers[u.id] = u.name);
  }
  res.json((data||[]).map(s => ({ ...s, seller_name: sellers[s.seller_id] || '?' })));
});

// ── Admin: PUT /api/admin/service-listings/:id/status ────
app.put('/api/admin/service-listings/:id/status', adminAuth, async (req, res) => {
  const { status, note } = req.body;
  if (!['active','paused','rejected'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  const { data: svc } = await supabase.from('service_listings').select('seller_id,title').eq('id', req.params.id).single();
  if (!svc) return res.status(404).json({ error: 'Không tìm thấy' });
  await supabase.from('service_listings').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id);
  if (status === 'rejected') createNotification(svc.seller_id, 'order', '❌ Gig bị từ chối', `"${svc.title}" không được duyệt. ${note||''}`, '/service-orders');
  else if (status === 'active') createNotification(svc.seller_id, 'order', '✅ Gig được duyệt', `"${svc.title}" đã kích hoạt.`, '/service-orders');
  res.json({ message: 'Cập nhật thành công' });
});

// ── Admin: GET /api/admin/service-orders ─────────────────
app.get('/api/admin/service-orders', adminAuth, async (req, res) => {
  const { status } = req.query;
  let q = supabase.from('service_orders').select('*').order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const uids = [...new Set([...(data||[]).map(o=>o.buyer_id),...(data||[]).map(o=>o.seller_id)])];
  let usersMap = {};
  if (uids.length > 0) {
    const { data: ud } = await supabase.from('users').select('id,name').in('id', uids);
    (ud||[]).forEach(u => usersMap[u.id] = u.name);
  }
  res.json((data||[]).map(o => ({ ...o, buyer_name: usersMap[o.buyer_id]||'?', seller_name: usersMap[o.seller_id]||'?' })));
});

// ── Admin: POST /api/admin/service-orders/:id/refund ─────
app.post('/api/admin/service-orders/:id/refund', adminAuth, async (req, res) => {
  const { admin_note } = req.body;
  const { data: order } = await supabase.from('service_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (['completed','cancelled'].includes(order.status)) return res.status(400).json({ error: 'Không thể hoàn tiền' });
  const { data: buyer } = await supabase.from('users').select('balance').eq('id', order.buyer_id).single();
  await supabase.from('users').update({ balance: (buyer?.balance||0) + order.price }).eq('id', order.buyer_id);
  await supabase.from('service_orders').update({ status: 'cancelled', admin_note: admin_note||'Admin hoàn tiền', cancelled_at: new Date().toISOString() }).eq('id', order.id);
  createNotification(order.buyer_id, 'refund', '✅ Hoàn tiền dịch vụ', `${order.price.toLocaleString('vi-VN')}đ hoàn về ví.`, '/wallet');
  res.json({ message: 'Hoàn tiền thành công' });
});

// ── Admin: POST /api/admin/service-orders/:id/release ────
app.post('/api/admin/service-orders/:id/release', adminAuth, async (req, res) => {
  const { admin_note } = req.body;
  const { data: order } = await supabase.from('service_orders').select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (['completed','cancelled'].includes(order.status)) return res.status(400).json({ error: 'Không thể giải ngân' });
  const { data: seller } = await supabase.from('users').select('balance').eq('id', order.seller_id).single();
  await supabase.from('users').update({ balance: (seller?.balance||0) + order.seller_payout }).eq('id', order.seller_id);
  await supabase.from('service_orders').update({ status: 'completed', approved_at: new Date().toISOString(), admin_note: admin_note||'Admin giải ngân' }).eq('id', order.id);
  createNotification(order.seller_id, 'payout', '💸 Giải ngân dịch vụ', `${order.seller_payout.toLocaleString('vi-VN')}đ vào ví.`, '/wallet');
  res.json({ message: 'Giải ngân thành công' });
});

// ── Auto-release after 5 days ─────────────────────────────
async function autoReleaseServiceOrders() {
  const now = new Date().toISOString();
  const { data: orders } = await supabase.from('service_orders')
    .select('*').eq('status','submitted').lt('auto_release_at', now);
  if (!orders || orders.length === 0) return;
  for (const o of orders) {
    const { data: seller } = await supabase.from('users').select('balance').eq('id', o.seller_id).single();
    await supabase.from('users').update({ balance: (seller?.balance||0) + o.seller_payout }).eq('id', o.seller_id);
    await supabase.from('service_orders').update({ status: 'completed', approved_at: new Date().toISOString() }).eq('id', o.id);
    createNotification(o.seller_id, 'payout', '💸 Tự động giải ngân', `"${o.service_title}" sau 5 ngày. ${o.seller_payout.toLocaleString('vi-VN')}đ vào ví.`, '/wallet');
    console.log(`[ServiceEscrow] Auto-released ${o.id}`);
  }
}

// ── SERVE FRONTEND STATIC FILES ──
app.use(express.static(join(__dirname, 'frontend')));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(join(__dirname, 'frontend', 'index.html'));
  }
});

// ── Chuẩn hóa số điện thoại cũ khi khởi động ──
async function migratePhoneNumbers() {
  try {
    const { data: users, error } = await supabase.from('users').select('id,phone');
    if (error) { console.error('[PhoneMigrate] Lỗi đọc users:', error.message); return; }
    let fixed = 0;
    for (const u of users || []) {
      const norm = normalizePhone(u.phone);
      if (norm !== u.phone) {
        // Kiểm tra xem số chuẩn hóa đã tồn tại chưa
        const { data: dup } = await supabase.from('users').select('id').eq('phone', norm).neq('id', u.id).maybeSingle();
        if (!dup) {
          await supabase.from('users').update({ phone: norm }).eq('id', u.id);
          console.log(`[PhoneMigrate] ${u.phone} → ${norm}`);
          fixed++;
        } else {
          console.warn(`[PhoneMigrate] Bỏ qua ${u.phone} → ${norm} (đã tồn tại)`);
        }
      }
    }
    if (fixed > 0) console.log(`[PhoneMigrate] Đã chuẩn hóa ${fixed} số điện thoại.`);
    else console.log('[PhoneMigrate] Tất cả số điện thoại đã chuẩn.');
  } catch(e) { console.error('[PhoneMigrate] Lỗi:', e.message); }
}

// ════════════════════════════════════════════════════════════════
//  🔐 OPEN ESCROW NETWORK — Complete API
// ════════════════════════════════════════════════════════════════

const oeStorage = multer.memoryStorage();
const oeUpload  = multer({ storage: oeStorage, limits: { fileSize: 20 * 1024 * 1024 } });

// Helper: send system message inside an escrow room
async function oeSystemMsg(escrowId, content) {
  await supabase.from('open_escrow_messages').insert({ escrow_id: escrowId, type: 'system', content });
  oeWsBroadcast(escrowId, { type: 'message', payload: { escrow_id: escrowId, type: 'system', content, created_at: new Date().toISOString() } });
}

// Helper: get participant names & trust scores joined to escrow
async function oeGetFull(id) {
  const { data: e, error } = await supabase.from('open_escrows').select('*').eq('id', id).single();
  if(error||!e) return null;
  if(e.buyer_id) {
    const { data: bu } = await supabase.from('users').select('name,phone').eq('id', e.buyer_id).single();
    e.buyer_name  = bu?.name || bu?.phone || 'Buyer';
    const { count: bc } = await supabase.from('open_escrows').select('*',{count:'exact',head:true}).eq('buyer_id',e.buyer_id).eq('status','completed');
    const { count: bd } = await supabase.from('open_escrows').select('*',{count:'exact',head:true}).or(`buyer_id.eq.${e.buyer_id},seller_id.eq.${e.buyer_id}`).eq('status','disputed');
    const { count: bt } = await supabase.from('open_escrows').select('*',{count:'exact',head:true}).or(`buyer_id.eq.${e.buyer_id},seller_id.eq.${e.buyer_id}`).in('status',['completed','disputed','cancelled']);
    e.buyer_trust    = bt>0 ? Math.round((bc/bt)*100) : null;
    e.buyer_completed = bc||0;
    e.buyer_disputed  = bd||0;
    e.buyer_total     = bt||0;
  }
  if(e.seller_id) {
    const { data: su } = await supabase.from('users').select('name,phone').eq('id', e.seller_id).single();
    e.seller_name  = su?.name || su?.phone || e.seller_email;
    const { count: sc } = await supabase.from('open_escrows').select('*',{count:'exact',head:true}).eq('seller_id',e.seller_id).eq('status','completed');
    const { count: sd } = await supabase.from('open_escrows').select('*',{count:'exact',head:true}).or(`buyer_id.eq.${e.seller_id},seller_id.eq.${e.seller_id}`).eq('status','disputed');
    const { count: st } = await supabase.from('open_escrows').select('*',{count:'exact',head:true}).or(`buyer_id.eq.${e.seller_id},seller_id.eq.${e.seller_id}`).in('status',['completed','disputed','cancelled']);
    e.seller_trust    = st>0 ? Math.round((sc/st)*100) : null;
    e.seller_completed = sc||0;
    e.seller_disputed  = sd||0;
    e.seller_total     = st||0;
  }
  return e;
}

// ── WebSocket rooms for open escrow ──
const oeRooms = new Map(); // escrowId => Set<ws>
function oeWsJoin(escrowId, socket) {
  if(!oeRooms.has(escrowId)) oeRooms.set(escrowId, new Set());
  oeRooms.get(escrowId).add(socket);
}
function oeWsLeave(escrowId, socket) {
  oeRooms.get(escrowId)?.delete(socket);
}
function oeWsBroadcast(escrowId, payload, exceptSocket) {
  const room = oeRooms.get(escrowId);
  if(!room) return;
  const msg = JSON.stringify(payload);
  room.forEach(s => { if(s !== exceptSocket && s.readyState === 1) s.send(msg); });
}

// ── CREATE escrow ──
app.post('/api/open-escrow', auth, async (req, res) => {
  const { title, description, category, amount, seller_email } = req.body;
  if(!title||!seller_email||!amount||amount<10000)
    return res.status(400).json({ error: 'Thiếu thông tin hoặc số tiền tối thiểu 10.000đ' });

  const { data: e, error } = await supabase.from('open_escrows').insert({
    title, description: description||'', category: category||'other',
    amount: parseInt(amount), buyer_id: req.user.id,
    seller_email: seller_email.toLowerCase(), status: 'pending'
  }).select().single();
  if(error) return res.status(500).json({ error: error.message });

  // Send invite email if Resend configured
  if(resend) {
    const inviteUrl = `${process.env.APP_URL||'https://'+process.env.REPLIT_DEV_DOMAIN||'http://localhost:5000'}/escrow.html?invite=${e.invite_token}`;
    resend.emails.send({
      from: 'SafePass <noreply@safepass.vn>',
      to: seller_email,
      subject: `[SafePass] Bạn được mời làm Seller — ${title}`,
      html: `<h2>Bạn được mời tham gia giao dịch Escrow an toàn</h2>
        <p><strong>Tiêu đề:</strong> ${title}</p>
        <p><strong>Giá trị:</strong> ${new Intl.NumberFormat('vi-VN').format(amount)}đ</p>
        <p><strong>Mô tả:</strong> ${description||'—'}</p>
        <p>Nhấn nút bên dưới để xem và chấp nhận giao dịch:</p>
        <a href="${inviteUrl}" style="display:inline-block;background:#3d8ef8;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Xem giao dịch →</a>
        <p style="color:#888;font-size:12px;margin-top:20px">SafePass — Marketplace Escrow An Toàn</p>`
    }).catch(()=>{});
  }
  res.json(e);
});

// ── GET my escrows ──
app.get('/api/open-escrow/my', auth, async (req, res) => {
  const { data, error } = await supabase.from('open_escrows')
    .select('*').or(`buyer_id.eq.${req.user.id},seller_id.eq.${req.user.id}`)
    .order('created_at', { ascending: false });
  if(error) return res.status(500).json({ error: error.message });

  // Attach names
  const enriched = await Promise.all((data||[]).map(async e => {
    if(e.buyer_id) {
      const { data: u } = await supabase.from('users').select('name,phone').eq('id',e.buyer_id).single();
      e.buyer_name = u?.name||u?.phone||'Buyer';
    }
    if(e.seller_id) {
      const { data: u } = await supabase.from('users').select('name,phone').eq('id',e.seller_id).single();
      e.seller_name = u?.name||u?.phone||e.seller_email;
    }
    return e;
  }));
  res.json(enriched);
});

// ── GET escrow by invite token (public, no auth — for invite page render) ──
app.get('/api/open-escrow/invite/:token', async (req, res) => {
  const { data: e, error } = await supabase.from('open_escrows').select('*').eq('invite_token', req.params.token).single();
  if(error||!e) return res.status(404).json({ error: 'Link không hợp lệ hoặc đã hết hạn' });
  const full = await oeGetFull(e.id);
  res.json(full);
});

// ── GET single escrow (must be participant) ──
app.get('/api/open-escrow/:id', auth, async (req, res) => {
  const e = await oeGetFull(req.params.id);
  if(!e) return res.status(404).json({ error: 'Không tìm thấy' });
  if(e.buyer_id !== req.user.id && e.seller_id !== req.user.id)
    return res.status(403).json({ error: 'Bạn không có quyền xem giao dịch này' });
  res.json(e);
});

// ── SELLER ACCEPTS ──
app.post('/api/open-escrow/:id/accept', auth, async (req, res) => {
  const { data: e } = await supabase.from('open_escrows').select('*').eq('id',req.params.id).single();
  if(!e) return res.status(404).json({ error: 'Không tìm thấy' });
  if(e.status !== 'pending') return res.status(400).json({ error: 'Giao dịch không ở trạng thái chờ' });
  if(e.buyer_id === req.user.id) return res.status(400).json({ error: 'Buyer không thể tự chấp nhận' });

  // Check seller email matches
  const { data: u } = await supabase.from('users').select('email,phone').eq('id',req.user.id).single();
  if(u?.email && u.email.toLowerCase() !== e.seller_email.toLowerCase() && u?.phone !== e.seller_email)
    return res.status(403).json({ error: 'Email/SĐT của bạn không khớp với thư mời' });

  await supabase.from('open_escrows').update({ seller_id: req.user.id, updated_at: new Date() }).eq('id',req.params.id);
  await oeSystemMsg(req.params.id, 'Seller đã chấp nhận giao dịch. Đang chờ Buyer nạp tiền vào Escrow.');
  oeWsBroadcast(req.params.id, { type: 'status_change', status: 'pending' });
  const updated = await oeGetFull(req.params.id);
  res.json(updated);
});

// ── BUYER FUNDS ESCROW ──
app.post('/api/open-escrow/:id/fund', auth, async (req, res) => {
  const { data: e } = await supabase.from('open_escrows').select('*').eq('id',req.params.id).single();
  if(!e) return res.status(404).json({ error: 'Không tìm thấy' });
  if(e.buyer_id !== req.user.id) return res.status(403).json({ error: 'Chỉ Buyer mới có thể nạp tiền' });
  if(e.status !== 'pending' || !e.seller_id)
    return res.status(400).json({ error: 'Giao dịch chưa sẵn sàng hoặc seller chưa xác nhận' });

  // Deduct from buyer wallet
  const { data: buyer } = await supabase.from('users').select('balance,escrow').eq('id',req.user.id).single();
  if(!buyer || buyer.balance < e.amount)
    return res.status(400).json({ error: `Số dư không đủ. Cần ${e.amount.toLocaleString()}đ, bạn có ${(buyer?.balance||0).toLocaleString()}đ` });

  await supabase.from('users').update({
    balance: buyer.balance - e.amount,
    escrow:  (buyer.escrow||0) + e.amount
  }).eq('id', req.user.id);

  await supabase.from('open_escrows').update({ status:'funded', funded_at: new Date(), updated_at: new Date() }).eq('id',req.params.id);
  await supabase.from('transactions').insert({ user_id: req.user.id, type:'escrow_lock', amount: -e.amount, description: `Escrow: ${e.title}`, ref_id: e.id });
  await oeSystemMsg(req.params.id, `Buyer đã nạp ${e.amount.toLocaleString()}đ vào Escrow. Tiền được khoá an toàn. Seller có thể bắt đầu giao hàng.`);
  oeWsBroadcast(req.params.id, { type: 'status_change', status: 'funded' });
  res.json({ ok: true });
});

// ── SELLER SHIPS ──
app.post('/api/open-escrow/:id/ship', auth, async (req, res) => {
  const { tracking_info } = req.body;
  const { data: e } = await supabase.from('open_escrows').select('*').eq('id',req.params.id).single();
  if(!e) return res.status(404).json({ error: 'Không tìm thấy' });
  if(e.seller_id !== req.user.id) return res.status(403).json({ error: 'Chỉ Seller mới có thể xác nhận giao hàng' });
  if(e.status !== 'funded') return res.status(400).json({ error: 'Escrow chưa được nạp tiền' });

  await supabase.from('open_escrows').update({
    status:'shipped', shipped_at: new Date(), tracking_info, updated_at: new Date()
  }).eq('id',req.params.id);
  await oeSystemMsg(req.params.id, `Seller đã xác nhận giao hàng. ${tracking_info?'Thông tin: '+tracking_info:''} Đang chờ Buyer xác nhận đã nhận.`);
  oeWsBroadcast(req.params.id, { type: 'status_change', status: 'shipped' });
  res.json({ ok: true });
});

// ── BUYER CONFIRMS DELIVERY → RELEASE FUNDS ──
app.post('/api/open-escrow/:id/confirm', auth, async (req, res) => {
  const { data: e } = await supabase.from('open_escrows').select('*').eq('id',req.params.id).single();
  if(!e) return res.status(404).json({ error: 'Không tìm thấy' });
  if(e.buyer_id !== req.user.id) return res.status(403).json({ error: 'Chỉ Buyer mới có thể xác nhận' });
  if(!['shipped','delivered'].includes(e.status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });

  const fee = Math.round(e.amount * 0.01); // 1% platform fee
  const sellerReceives = e.amount - fee;

  // Release from buyer escrow, pay seller
  const { data: buyer } = await supabase.from('users').select('escrow').eq('id',e.buyer_id).single();
  const { data: seller } = await supabase.from('users').select('balance').eq('id',e.seller_id).single();

  await supabase.from('users').update({ escrow: Math.max(0,(buyer?.escrow||0)-e.amount) }).eq('id',e.buyer_id);
  await supabase.from('users').update({ balance: (seller?.balance||0)+sellerReceives }).eq('id',e.seller_id);

  await supabase.from('open_escrows').update({
    status:'completed', delivered_at: new Date(), completed_at: new Date(), updated_at: new Date()
  }).eq('id',req.params.id);

  await supabase.from('transactions').insert([
    { user_id: e.buyer_id,  type:'escrow_release', amount: -e.amount, description: `Giải ngân Escrow: ${e.title}`, ref_id: e.id },
    { user_id: e.seller_id, type:'escrow_release', amount: sellerReceives, description: `Nhận tiền Escrow: ${e.title}`, ref_id: e.id }
  ]);
  await oeSystemMsg(req.params.id, `✅ Buyer đã xác nhận nhận hàng! Escrow hoàn thành. Seller nhận được ${sellerReceives.toLocaleString()}đ (phí 1% = ${fee.toLocaleString()}đ).`);
  oeWsBroadcast(req.params.id, { type: 'status_change', status: 'completed' });
  res.json({ ok: true });
});

// ── DISPUTE ──
app.post('/api/open-escrow/:id/dispute', auth, async (req, res) => {
  const { reason } = req.body;
  const { data: e } = await supabase.from('open_escrows').select('*').eq('id',req.params.id).single();
  if(!e) return res.status(404).json({ error: 'Không tìm thấy' });
  if(e.buyer_id !== req.user.id && e.seller_id !== req.user.id)
    return res.status(403).json({ error: 'Bạn không tham gia giao dịch này' });
  if(!['funded','shipped','delivered'].includes(e.status))
    return res.status(400).json({ error: 'Không thể mở tranh chấp ở trạng thái này' });
  if(!reason) return res.status(400).json({ error: 'Vui lòng nhập lý do tranh chấp' });

  await supabase.from('open_escrows').update({
    status:'disputed', disputed_at: new Date(), dispute_reason: reason,
    dispute_by: req.user.id, updated_at: new Date()
  }).eq('id',req.params.id);
  const { data: u } = await supabase.from('users').select('name,phone').eq('id',req.user.id).single();
  await oeSystemMsg(req.params.id, `⚠️ ${u?.name||u?.phone||'Người dùng'} đã mở tranh chấp: "${reason}". Admin sẽ xem xét trong 48h. Tiền Escrow bị đóng băng.`);
  oeWsBroadcast(req.params.id, { type: 'status_change', status: 'disputed' });
  res.json({ ok: true });
});

// ── CANCEL ──
app.post('/api/open-escrow/:id/cancel', auth, async (req, res) => {
  const { data: e } = await supabase.from('open_escrows').select('*').eq('id',req.params.id).single();
  if(!e) return res.status(404).json({ error: 'Không tìm thấy' });
  if(e.buyer_id !== req.user.id && e.seller_id !== req.user.id)
    return res.status(403).json({ error: 'Không có quyền' });
  if(['completed','disputed','frozen'].includes(e.status))
    return res.status(400).json({ error: 'Không thể huỷ ở trạng thái này' });

  // Refund if funded
  if(e.status==='funded' && e.buyer_id) {
    const { data: buyer } = await supabase.from('users').select('balance,escrow').eq('id',e.buyer_id).single();
    await supabase.from('users').update({
      balance: (buyer?.balance||0)+e.amount,
      escrow:  Math.max(0,(buyer?.escrow||0)-e.amount)
    }).eq('id',e.buyer_id);
    await supabase.from('transactions').insert({ user_id: e.buyer_id, type:'refund', amount: e.amount, description: `Hoàn tiền Escrow: ${e.title}`, ref_id: e.id });
  }
  await supabase.from('open_escrows').update({ status:'cancelled', cancelled_at: new Date(), updated_at: new Date() }).eq('id',req.params.id);
  await oeSystemMsg(req.params.id, 'Giao dịch đã bị huỷ. Tiền đã được hoàn lại cho Buyer (nếu có).');
  oeWsBroadcast(req.params.id, { type: 'status_change', status: 'cancelled' });
  res.json({ ok: true });
});

// ── GET MESSAGES ──
app.get('/api/open-escrow/:id/messages', auth, async (req, res) => {
  const { data: e } = await supabase.from('open_escrows').select('buyer_id,seller_id').eq('id',req.params.id).single();
  if(!e || (e.buyer_id !== req.user.id && e.seller_id !== req.user.id))
    return res.status(403).json({ error: 'Không có quyền' });
  const { data } = await supabase.from('open_escrow_messages').select('*').eq('escrow_id',req.params.id).order('created_at');
  // Attach sender names
  const enriched = await Promise.all((data||[]).map(async m => {
    if(m.user_id && m.type!=='system') {
      const { data: u } = await supabase.from('users').select('name,phone').eq('id',m.user_id).single();
      m.sender_name = u?.name||u?.phone||'Người dùng';
    }
    return m;
  }));
  res.json(enriched);
});

// ── SEND MESSAGE ──
app.post('/api/open-escrow/:id/messages', auth, async (req, res) => {
  const { content } = req.body;
  if(!content?.trim()) return res.status(400).json({ error: 'Nội dung trống' });
  const { data: e } = await supabase.from('open_escrows').select('buyer_id,seller_id').eq('id',req.params.id).single();
  if(!e || (e.buyer_id !== req.user.id && e.seller_id !== req.user.id))
    return res.status(403).json({ error: 'Không có quyền' });
  const { data: u } = await supabase.from('users').select('name,phone').eq('id',req.user.id).single();
  const { data: msg } = await supabase.from('open_escrow_messages').insert({
    escrow_id: req.params.id, user_id: req.user.id, content: content.trim(), type:'user'
  }).select().single();
  if(msg) { msg.sender_name = u?.name||u?.phone||'Người dùng'; }
  oeWsBroadcast(req.params.id, { type:'message', payload: msg });
  res.json(msg);
});

// ── SEND FILE MESSAGE (multer) ──
app.post('/api/open-escrow/:id/messages/file', auth, oeUpload.single('file'), async (req, res) => {
  if(!req.file) return res.status(400).json({ error: 'Không có file' });
  const { data: e } = await supabase.from('open_escrows').select('buyer_id,seller_id').eq('id',req.params.id).single();
  if(!e || (e.buyer_id !== req.user.id && e.seller_id !== req.user.id))
    return res.status(403).json({ error: 'Không có quyền' });

  const isImg = req.file.mimetype.startsWith('image/');
  const ext   = req.file.originalname.split('.').pop();
  const path  = `escrow/${req.params.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const { data: upload, error: upErr } = await supabase.storage.from('chat-images').upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if(upErr) return res.status(500).json({ error: upErr.message });
  const { data: { publicUrl } } = supabase.storage.from('chat-images').getPublicUrl(path);

  const { data: u } = await supabase.from('users').select('name,phone').eq('id',req.user.id).single();
  const { data: msg } = await supabase.from('open_escrow_messages').insert({
    escrow_id: req.params.id, user_id: req.user.id,
    type: isImg?'image':'file', file_url: publicUrl, file_name: req.file.originalname, content: req.file.originalname
  }).select().single();
  if(msg) msg.sender_name = u?.name||u?.phone||'Người dùng';
  oeWsBroadcast(req.params.id, { type:'message', payload: msg });
  res.json(msg);
});

// ── GET EVIDENCE ──
app.get('/api/open-escrow/:id/evidence', auth, async (req, res) => {
  const { data: e } = await supabase.from('open_escrows').select('buyer_id,seller_id').eq('id',req.params.id).single();
  if(!e || (e.buyer_id !== req.user.id && e.seller_id !== req.user.id))
    return res.status(403).json({ error: 'Không có quyền' });
  const { data } = await supabase.from('open_escrow_evidence').select('*').eq('escrow_id',req.params.id).order('created_at');
  res.json(data||[]);
});

// ── UPLOAD EVIDENCE ──
app.post('/api/open-escrow/:id/evidence', auth, oeUpload.single('file'), async (req, res) => {
  if(!req.file) return res.status(400).json({ error: 'Không có file' });
  const { data: e } = await supabase.from('open_escrows').select('buyer_id,seller_id').eq('id',req.params.id).single();
  if(!e || (e.buyer_id !== req.user.id && e.seller_id !== req.user.id))
    return res.status(403).json({ error: 'Không có quyền' });

  const isImg  = req.file.mimetype.startsWith('image/');
  const isVid  = req.file.mimetype.startsWith('video/');
  const isPdf  = req.file.mimetype === 'application/pdf';
  const ftype  = isImg?'image':isVid?'video':isPdf?'pdf':'file';
  const ext    = req.file.originalname.split('.').pop();
  const path   = `evidence/${req.params.id}/${Date.now()}.${ext}`;

  const bucket = isImg?'ticket-images':'kyc-documents';
  const { error: upErr } = await supabase.storage.from(bucket).upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if(upErr) return res.status(500).json({ error: upErr.message });
  const { data: { publicUrl } } = supabase.storage.from(bucket).getPublicUrl(path);

  const { data: ev } = await supabase.from('open_escrow_evidence').insert({
    escrow_id: req.params.id, user_id: req.user.id, file_url: publicUrl, file_type: ftype, description: req.body.description||''
  }).select().single();

  await oeSystemMsg(req.params.id, `📎 Bằng chứng mới được tải lên bởi ${req.user.id===e.buyer_id?'Buyer':'Seller'}.`);
  res.json(ev);
});

// ── TRUST SCORE ──
app.get('/api/open-escrow/trust/:userId', async (req, res) => {
  const uid = req.params.userId;
  const { count: total } = await supabase.from('open_escrows').select('*',{count:'exact',head:true})
    .or(`buyer_id.eq.${uid},seller_id.eq.${uid}`);
  const { count: done  } = await supabase.from('open_escrows').select('*',{count:'exact',head:true})
    .or(`buyer_id.eq.${uid},seller_id.eq.${uid}`).eq('status','completed');
  const { count: disp  } = await supabase.from('open_escrows').select('*',{count:'exact',head:true})
    .or(`buyer_id.eq.${uid},seller_id.eq.${uid}`).eq('status','disputed');
  res.json({
    total: total||0, completed: done||0, disputed: disp||0,
    success_rate: total>0 ? Math.round(((done||0)/(total||1))*100) : null,
    dispute_rate: total>0 ? Math.round(((disp||0)/(total||1))*100) : null
  });
});

// ── ADMIN: LIST ALL ──
app.get('/api/admin/open-escrows', adminAuth, async (req, res) => {
  const { status, search } = req.query;
  let q = supabase.from('open_escrows').select('*').order('created_at',{ascending:false}).limit(200);
  if(status) q = q.eq('status',status);
  if(search) q = q.or(`title.ilike.%${search}%,seller_email.ilike.%${search}%`);
  const { data, error } = await q;
  if(error) return res.status(500).json({ error: error.message });
  res.json(data||[]);
});

// ── ADMIN: STATS ──
app.get('/api/admin/open-escrows/stats', adminAuth, async (req, res) => {
  const { data } = await supabase.from('open_escrows').select('status,amount');
  const rows = data||[];
  const byStatus = {};
  let totalVolume=0, activeVolume=0;
  rows.forEach(r=>{
    byStatus[r.status]=(byStatus[r.status]||0)+1;
    if(r.status==='completed') totalVolume+=(r.amount||0);
    if(['funded','shipped','delivered'].includes(r.status)) activeVolume+=(r.amount||0);
  });
  res.json({ total: rows.length, byStatus, totalVolume, activeVolume });
});

// ── ADMIN: ACTION (freeze / release / refund / resolve) ──
app.post('/api/admin/open-escrows/:id/action', adminAuth, async (req, res) => {
  const { action, notes } = req.body;
  const { data: e } = await supabase.from('open_escrows').select('*').eq('id',req.params.id).single();
  if(!e) return res.status(404).json({ error: 'Không tìm thấy' });

  let update = { admin_notes: notes||'', admin_action_by: req.admin?.email||'admin', updated_at: new Date() };
  let sysMsg = '';

  if(action==='freeze') {
    update.status = 'frozen';
    sysMsg = `🔒 Admin đã đóng băng giao dịch. ${notes||''}`;
  } else if(action==='release') {
    // Release funds to seller
    if(!e.seller_id) return res.status(400).json({ error: 'Chưa có seller' });
    const fee = Math.round(e.amount * 0.01);
    const sellerReceives = e.amount - fee;
    const { data: buyer  } = await supabase.from('users').select('escrow').eq('id',e.buyer_id).single();
    const { data: seller } = await supabase.from('users').select('balance').eq('id',e.seller_id).single();
    await supabase.from('users').update({ escrow: Math.max(0,(buyer?.escrow||0)-e.amount) }).eq('id',e.buyer_id);
    await supabase.from('users').update({ balance: (seller?.balance||0)+sellerReceives }).eq('id',e.seller_id);
    await supabase.from('transactions').insert({ user_id: e.seller_id, type:'escrow_release', amount: sellerReceives, description:`Admin giải ngân: ${e.title}`, ref_id: e.id });
    update.status = 'completed'; update.completed_at = new Date();
    sysMsg = `✅ Admin đã giải ngân ${sellerReceives.toLocaleString()}đ cho Seller. ${notes||''}`;
  } else if(action==='refund') {
    // Full refund to buyer
    const { data: buyer } = await supabase.from('users').select('balance,escrow').eq('id',e.buyer_id).single();
    await supabase.from('users').update({
      balance: (buyer?.balance||0)+e.amount, escrow: Math.max(0,(buyer?.escrow||0)-e.amount)
    }).eq('id',e.buyer_id);
    await supabase.from('transactions').insert({ user_id: e.buyer_id, type:'refund', amount: e.amount, description:`Admin hoàn tiền: ${e.title}`, ref_id: e.id });
    update.status = 'cancelled'; update.cancelled_at = new Date();
    sysMsg = `🔄 Admin đã hoàn toàn bộ ${e.amount.toLocaleString()}đ cho Buyer. ${notes||''}`;
  } else if(action==='resolve') {
    update.status = 'completed';
    sysMsg = `⚖️ Admin đã giải quyết tranh chấp. ${notes||''}`;
  } else {
    return res.status(400).json({ error: 'Hành động không hợp lệ' });
  }

  await supabase.from('open_escrows').update(update).eq('id',req.params.id);
  if(sysMsg) await oeSystemMsg(req.params.id, sysMsg);
  oeWsBroadcast(req.params.id, { type:'status_change', status: update.status });
  res.json({ ok: true });
});

// ── EXTEND WEBSOCKET HANDLER FOR ESCROW ──
// (Added to existing httpServer.on('upgrade') below via wss2)
const wss2 = new WebSocketServer({ noServer: true });

wss2.on('connection', async (socket, req) => {
  const user = req._wsUser;
  const url  = new URL(req.url, 'http://localhost');
  const escrowId = url.searchParams.get('escrowId');
  if(!escrowId) { socket.close(); return; }

  // Verify participant
  const { data: e } = await supabase.from('open_escrows').select('buyer_id,seller_id').eq('id',escrowId).single();
  if(!e || (e.buyer_id !== user.id && e.seller_id !== user.id)) { socket.close(); return; }

  oeWsJoin(escrowId, socket);

  socket.on('message', async raw => {
    try {
      const d = JSON.parse(raw);
      if(d.type==='message' && d.content?.trim()) {
        const { data: u } = await supabase.from('users').select('name,phone').eq('id',user.id).single();
        const { data: msg } = await supabase.from('open_escrow_messages').insert({
          escrow_id: escrowId, user_id: user.id, content: d.content.trim(), type:'user'
        }).select().single();
        if(msg) { msg.sender_name = u?.name||u?.phone||'Người dùng'; }
        oeWsBroadcast(escrowId, { type:'message', payload: msg });
        socket.send(JSON.stringify({ type:'message', payload: msg }));
      }
    } catch {}
  });

  socket.on('close', () => oeWsLeave(escrowId, socket));
});

// ════════════════════════════════════════════════════════════════
//  PHASE 6 — DIGITAL ASSET MARKETPLACE (DAM)
// ════════════════════════════════════════════════════════════════

// ── Multer for listing images ──
const damStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, '/tmp'),
  filename: (req, file, cb) => cb(null, `dam_${Date.now()}_${file.originalname}`)
});
const damUpload = multer({ storage: damStorage, limits: { fileSize: 5 * 1024 * 1024 } });

async function damAudit(orderId, listingId, userId, action, details, ip) {
  await supabase.from('dam_audit_logs').insert({
    order_id: orderId||null, listing_id: listingId||null,
    user_id: userId, action, details: details||{}, ip_address: ip||''
  });
}

// ── BROWSE LISTINGS ──
app.get('/api/dam/listings', async (req, res) => {
  const { category, subcategory, min_price, max_price, search, sort = 'newest', limit = 24, offset = 0 } = req.query;
  let q = supabase.from('dam_listings').select('*, users!dam_listings_seller_id_fkey(name,phone)').eq('status','active');
  if (category)    q = q.eq('category', category);
  if (subcategory) q = q.eq('subcategory', subcategory);
  if (min_price)   q = q.gte('price', parseInt(min_price));
  if (max_price)   q = q.lte('price', parseInt(max_price));
  if (search)      q = q.ilike('title', `%${search}%`);
  if (sort === 'price_asc')  q = q.order('price', { ascending: true });
  else if (sort === 'price_desc') q = q.order('price', { ascending: false });
  else q = q.order('created_at', { ascending: false });
  q = q.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── LISTING DETAIL ──
app.get('/api/dam/listings/:id', async (req, res) => {
  const { data: listing, error } = await supabase.from('dam_listings')
    .select('*, users!dam_listings_seller_id_fkey(name,phone)')
    .eq('id', req.params.id).eq('status','active').single();
  if (error || !listing) return res.status(404).json({ error: 'Không tìm thấy' });
  await supabase.from('dam_listings').update({ view_count: (listing.view_count||0)+1 }).eq('id', req.params.id);
  // Seller stats
  const { count: sold } = await supabase.from('dam_orders').select('*',{count:'exact',head:true}).eq('seller_id',listing.seller_id).eq('status','confirmed');
  const { count: total } = await supabase.from('dam_orders').select('*',{count:'exact',head:true}).eq('seller_id',listing.seller_id).not('status','in','("cancelled","refunded")');
  const { data: reviews } = await supabase.from('dam_reviews').select('rating').eq('seller_id',listing.seller_id);
  const avgRating = reviews?.length ? (reviews.reduce((s,r)=>s+r.rating,0)/reviews.length).toFixed(1) : null;
  listing.seller_stats = { sold: sold||0, total: total||0, rating: avgRating, review_count: reviews?.length||0 };
  res.json(listing);
});

// ── MY LISTINGS ──
app.get('/api/dam/my/listings', auth, async (req, res) => {
  const { data, error } = await supabase.from('dam_listings')
    .select('*').eq('seller_id', req.user.id).neq('status','deleted')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── CREATE LISTING ──
app.post('/api/dam/listings', auth, async (req, res) => {
  const { title, description, category, subcategory, price, image_url, asset_info } = req.body;
  if (!title || !category || !subcategory || !price || price < 10000)
    return res.status(400).json({ error: 'Thiếu thông tin hoặc giá tối thiểu 10.000đ' });
  const { data, error } = await supabase.from('dam_listings').insert({
    seller_id: req.user.id, title, description, category, subcategory,
    price: parseInt(price), image_url: image_url||null, asset_info: asset_info||null
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await damAudit(null, data.id, req.user.id, 'listing_created', { title, category, subcategory, price }, req.ip);
  res.json(data);
});

// ── UPDATE LISTING ──
app.put('/api/dam/listings/:id', auth, async (req, res) => {
  const { data: listing } = await supabase.from('dam_listings').select('seller_id').eq('id',req.params.id).single();
  if (!listing) return res.status(404).json({ error: 'Không tìm thấy' });
  if (listing.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  const { title, description, price, image_url, asset_info, status } = req.body;
  const update = { updated_at: new Date() };
  if (title !== undefined)      update.title = title;
  if (description !== undefined) update.description = description;
  if (price !== undefined)      update.price = parseInt(price);
  if (image_url !== undefined)  update.image_url = image_url;
  if (asset_info !== undefined) update.asset_info = asset_info;
  if (status && ['active','paused','deleted'].includes(status)) update.status = status;
  await supabase.from('dam_listings').update(update).eq('id',req.params.id);
  res.json({ ok: true });
});

// ── SAVE VAULT CREDENTIALS ──
app.post('/api/dam/listings/:id/vault', auth, async (req, res) => {
  const { data: listing } = await supabase.from('dam_listings').select('seller_id').eq('id',req.params.id).single();
  if (!listing || listing.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  const { username, password, email, backup_codes, notes } = req.body;
  const enc = (v) => v ? encryptField(v) : null;
  const existing = await supabase.from('dam_vault').select('id').eq('listing_id',req.params.id).single();
  if (existing.data) {
    await supabase.from('dam_vault').update({
      username_enc: enc(username), password_enc: enc(password),
      email_enc: enc(email), backup_codes_enc: enc(backup_codes), notes_enc: enc(notes),
      updated_at: new Date()
    }).eq('listing_id', req.params.id);
  } else {
    await supabase.from('dam_vault').insert({
      listing_id: req.params.id,
      username_enc: enc(username), password_enc: enc(password),
      email_enc: enc(email), backup_codes_enc: enc(backup_codes), notes_enc: enc(notes)
    });
  }
  await damAudit(null, req.params.id, req.user.id, 'vault_saved', {}, req.ip);
  res.json({ ok: true });
});

// ── BUY / CREATE ORDER ──
app.post('/api/dam/orders', auth, async (req, res) => {
  const { listing_id } = req.body;
  const { data: listing } = await supabase.from('dam_listings').select('*').eq('id',listing_id).eq('status','active').single();
  if (!listing) return res.status(404).json({ error: 'Tài sản không tồn tại hoặc đã bán' });
  if (listing.seller_id === req.user.id) return res.status(400).json({ error: 'Không thể mua tài sản của chính mình' });
  const { data: buyer } = await supabase.from('users').select('balance').eq('id',req.user.id).single();
  if (!buyer || buyer.balance < listing.price) return res.status(400).json({ error: `Số dư không đủ. Cần ${listing.price.toLocaleString()}đ` });
  // Deduct from buyer, lock in escrow
  await supabase.from('users').update({ balance: buyer.balance - listing.price, escrow: (buyer.escrow||0) + listing.price }).eq('id',req.user.id);
  // Mark listing as sold
  await supabase.from('dam_listings').update({ status:'sold', updated_at: new Date() }).eq('id', listing_id);
  const { data: order, error } = await supabase.from('dam_orders').insert({
    listing_id, buyer_id: req.user.id, seller_id: listing.seller_id,
    price: listing.price, status: 'funded', funded_at: new Date()
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('transactions').insert({ user_id: req.user.id, type:'escrow_lock', amount: -listing.price, description:`DAM Escrow: ${listing.title}`, ref_id: order.id });
  await damAudit(order.id, listing_id, req.user.id, 'order_funded', { price: listing.price }, req.ip);
  res.json(order);
});

// ── MY ORDERS ──
app.get('/api/dam/orders/my', auth, async (req, res) => {
  const { data, error } = await supabase.from('dam_orders')
    .select('*, dam_listings(title,category,subcategory,image_url)')
    .or(`buyer_id.eq.${req.user.id},seller_id.eq.${req.user.id}`)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── ORDER DETAIL ──
app.get('/api/dam/orders/:id', auth, async (req, res) => {
  const { data: order, error } = await supabase.from('dam_orders')
    .select('*, dam_listings(title,category,subcategory,image_url,description,asset_info)')
    .eq('id',req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id)
    return res.status(403).json({ error: 'Không có quyền' });
  // Enrich with names
  const [{ data: buyer }, { data: seller }] = await Promise.all([
    supabase.from('users').select('name,phone').eq('id',order.buyer_id).single(),
    supabase.from('users').select('name,phone').eq('id',order.seller_id).single()
  ]);
  order.buyer_name  = buyer?.name || buyer?.phone || 'Buyer';
  order.seller_name = seller?.name || seller?.phone || 'Seller';
  // Check if reviewed
  const { data: review } = await supabase.from('dam_reviews').select('*').eq('order_id',req.params.id).eq('reviewer_id',req.user.id).single();
  order.my_review = review || null;
  res.json(order);
});

// ── SELLER DELIVERS ──
app.post('/api/dam/orders/:id/deliver', auth, async (req, res) => {
  const { data: order } = await supabase.from('dam_orders').select('*').eq('id',req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: 'Chỉ Seller mới có quyền' });
  if (order.status !== 'funded') return res.status(400).json({ error: 'Đơn chưa được thanh toán' });
  await supabase.from('dam_orders').update({ status:'delivered', delivered_at: new Date(), updated_at: new Date() }).eq('id',req.params.id);
  await damAudit(req.params.id, order.listing_id, req.user.id, 'delivered', {}, req.ip);
  res.json({ ok: true });
});

// ── GET VAULT (buyer only, after delivered/confirmed) ──
app.get('/api/dam/orders/:id/vault', auth, async (req, res) => {
  const { data: order } = await supabase.from('dam_orders').select('*').eq('id',req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Chỉ Buyer mới xem được' });
  if (!['delivered','confirmed'].includes(order.status)) return res.status(403).json({ error: 'Chưa bàn giao — vault chưa mở' });
  const { data: vault } = await supabase.from('dam_vault').select('*').eq('listing_id',order.listing_id).single();
  if (!vault) return res.json({ empty: true });
  const dec = (v) => { try { return v ? decryptField(v) : null; } catch { return null; } };
  await damAudit(req.params.id, order.listing_id, req.user.id, 'vault_accessed', {}, req.ip);
  res.json({
    username: dec(vault.username_enc),
    password: dec(vault.password_enc),
    email:    dec(vault.email_enc),
    backup_codes: dec(vault.backup_codes_enc),
    notes:    dec(vault.notes_enc)
  });
});

// ── BUYER CONFIRMS ──
app.post('/api/dam/orders/:id/confirm', auth, async (req, res) => {
  const { data: order } = await supabase.from('dam_orders').select('*').eq('id',req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Chỉ Buyer mới xác nhận được' });
  if (order.status !== 'delivered') return res.status(400).json({ error: 'Tài sản chưa được bàn giao' });
  // Release escrow to seller (1% fee)
  const fee = Math.round(order.price * 0.01);
  const sellerGets = order.price - fee;
  const [{ data: buyer }, { data: seller }] = await Promise.all([
    supabase.from('users').select('escrow').eq('id',order.buyer_id).single(),
    supabase.from('users').select('balance').eq('id',order.seller_id).single()
  ]);
  await Promise.all([
    supabase.from('users').update({ escrow: Math.max(0,(buyer?.escrow||0)-order.price) }).eq('id',order.buyer_id),
    supabase.from('users').update({ balance: (seller?.balance||0)+sellerGets }).eq('id',order.seller_id),
    supabase.from('transactions').insert({ user_id: order.seller_id, type:'sale', amount: sellerGets, description:`DAM bán: ${order.listing_id}`, ref_id: order.id }),
    supabase.from('dam_orders').update({ status:'confirmed', confirmed_at: new Date(), updated_at: new Date() }).eq('id',req.params.id)
  ]);
  await damAudit(req.params.id, order.listing_id, req.user.id, 'confirmed', { released: sellerGets }, req.ip);
  res.json({ ok: true });
});

// ── DISPUTE ──
app.post('/api/dam/orders/:id/dispute', auth, async (req, res) => {
  const { reason } = req.body;
  const { data: order } = await supabase.from('dam_orders').select('*').eq('id',req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (!['funded','delivered'].includes(order.status)) return res.status(400).json({ error: 'Không thể mở tranh chấp ở trạng thái này' });
  if (!reason?.trim()) return res.status(400).json({ error: 'Vui lòng nhập lý do tranh chấp' });
  await supabase.from('dam_orders').update({ status:'disputed', dispute_reason: reason, disputed_at: new Date(), updated_at: new Date() }).eq('id',req.params.id);
  await damAudit(req.params.id, order.listing_id, req.user.id, 'disputed', { reason }, req.ip);
  res.json({ ok: true });
});

// ── UPDATE CHECKLIST ──
app.post('/api/dam/orders/:id/checklist', auth, async (req, res) => {
  const { data: order } = await supabase.from('dam_orders').select('*').eq('id',req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Chỉ Buyer mới cập nhật được' });
  const current = order.checklist || {};
  const merged = { ...current, ...req.body };
  await supabase.from('dam_orders').update({ checklist: merged, updated_at: new Date() }).eq('id',req.params.id);
  await damAudit(req.params.id, order.listing_id, req.user.id, 'checklist_updated', merged, req.ip);
  res.json({ ok: true, checklist: merged });
});

// ── SUBMIT REVIEW ──
app.post('/api/dam/orders/:id/review', auth, async (req, res) => {
  const { rating, comment } = req.body;
  const { data: order } = await supabase.from('dam_orders').select('*').eq('id',req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Chỉ Buyer mới đánh giá được' });
  if (order.status !== 'confirmed') return res.status(400).json({ error: 'Hoàn thành giao dịch trước khi đánh giá' });
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Điểm đánh giá phải từ 1-5' });
  const existing = await supabase.from('dam_reviews').select('id').eq('order_id',req.params.id).eq('reviewer_id',req.user.id).single();
  if (existing.data) return res.status(400).json({ error: 'Bạn đã đánh giá giao dịch này rồi' });
  await supabase.from('dam_reviews').insert({ order_id: req.params.id, reviewer_id: req.user.id, seller_id: order.seller_id, rating: parseInt(rating), comment: comment||'' });
  res.json({ ok: true });
});

// ── SELLER PROFILE ──
app.get('/api/dam/seller/:id/profile', async (req, res) => {
  const sellerId = req.params.id;
  const [{ data: user }, listings, orders, reviews] = await Promise.all([
    supabase.from('users').select('name,phone,created_at').eq('id',sellerId).single(),
    supabase.from('dam_listings').select('id,title,category,subcategory,price,image_url,status,created_at').eq('seller_id',sellerId).eq('status','active').order('created_at',{ascending:false}).limit(20),
    supabase.from('dam_orders').select('status').eq('seller_id',sellerId),
    supabase.from('dam_reviews').select('rating,comment,created_at').eq('seller_id',sellerId).order('created_at',{ascending:false}).limit(20)
  ]);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy' });
  const ord = orders.data || [];
  const rev = reviews.data || [];
  const confirmed = ord.filter(o=>o.status==='confirmed').length;
  const disputed  = ord.filter(o=>o.status==='disputed').length;
  const avgRating = rev.length ? (rev.reduce((s,r)=>s+r.rating,0)/rev.length).toFixed(1) : null;
  res.json({
    seller: { ...user, id: sellerId },
    listings: listings.data || [],
    reviews: rev,
    stats: { total: ord.length, confirmed, disputed, avg_rating: avgRating, review_count: rev.length }
  });
});

// ── ADMIN: LIST ALL ORDERS ──
app.get('/api/admin/dam/orders', adminAuth, async (req, res) => {
  const { status, search } = req.query;
  let q = supabase.from('dam_orders')
    .select('*, dam_listings(title,category,subcategory)')
    .order('created_at',{ascending:false}).limit(200);
  if (status) q = q.eq('status',status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── ADMIN: STATS ──
app.get('/api/admin/dam/stats', adminAuth, async (req, res) => {
  const [orders, listings] = await Promise.all([
    supabase.from('dam_orders').select('status,price'),
    supabase.from('dam_listings').select('status')
  ]);
  const ord = orders.data || [];
  const lst = listings.data || [];
  const byStatus = {};
  let volume = 0;
  ord.forEach(o => { byStatus[o.status]=(byStatus[o.status]||0)+1; if(o.status==='confirmed') volume+=(o.price||0); });
  res.json({ total_orders: ord.length, total_listings: lst.length, active_listings: lst.filter(l=>l.status==='active').length, volume, by_status: byStatus });
});

// ── ADMIN: ACTION ──
app.post('/api/admin/dam/orders/:id/action', adminAuth, async (req, res) => {
  const { action, notes } = req.body;
  const { data: order } = await supabase.from('dam_orders').select('*').eq('id',req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy' });
  let update = { admin_notes: notes||'', admin_action_by: req.admin?.email||'admin', updated_at: new Date() };
  if (action === 'release') {
    const fee = Math.round(order.price * 0.01);
    const sellerGets = order.price - fee;
    const [{ data: buyer }, { data: seller }] = await Promise.all([
      supabase.from('users').select('escrow').eq('id',order.buyer_id).single(),
      supabase.from('users').select('balance').eq('id',order.seller_id).single()
    ]);
    await supabase.from('users').update({ escrow: Math.max(0,(buyer?.escrow||0)-order.price) }).eq('id',order.buyer_id);
    await supabase.from('users').update({ balance: (seller?.balance||0)+sellerGets }).eq('id',order.seller_id);
    await supabase.from('transactions').insert({ user_id: order.seller_id, type:'sale', amount: sellerGets, description:`Admin giải ngân DAM`, ref_id: order.id });
    update.status = 'confirmed'; update.confirmed_at = new Date();
  } else if (action === 'refund') {
    const { data: buyer } = await supabase.from('users').select('balance,escrow').eq('id',order.buyer_id).single();
    await supabase.from('users').update({ balance:(buyer?.balance||0)+order.price, escrow: Math.max(0,(buyer?.escrow||0)-order.price) }).eq('id',order.buyer_id);
    await supabase.from('transactions').insert({ user_id: order.buyer_id, type:'refund', amount: order.price, description:`Admin hoàn tiền DAM`, ref_id: order.id });
    await supabase.from('dam_listings').update({ status:'active', updated_at: new Date() }).eq('id',order.listing_id);
    update.status = 'refunded';
  } else if (action === 'cancel') {
    update.status = 'cancelled';
  } else {
    return res.status(400).json({ error: 'Hành động không hợp lệ' });
  }
  await supabase.from('dam_orders').update(update).eq('id',req.params.id);
  await damAudit(req.params.id, order.listing_id, null, `admin_${action}`, { notes }, req.ip);
  res.json({ ok: true });
});

// ────────────────────────────────────────────────
//  END OF PHASE 6 DAM ROUTES
// ────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════
//  SAFEPASS BUSINESS — Escrow-as-a-Service API
// ══════════════════════════════════════════════════════════

// ── Business JWT middleware ──
function businessAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'business_jwt') return res.status(401).json({ error: 'Token không hợp lệ' });
    req.biz = payload;
    next();
  } catch { res.status(401).json({ error: 'Token không hợp lệ' }); }
}

// ── Business API Key middleware (for external API calls) ──
async function businessApiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key required. Send X-Api-Key header.' });
  const { data: keyRow } = await supabase.from('api_keys')
    .select('*, business_accounts!inner(id, company_name, status, plan, api_calls_this_month, transactions_this_month)')
    .eq('api_key', apiKey).eq('status', 'active').single();
  if (!keyRow) return res.status(401).json({ error: 'Invalid or revoked API key' });
  if (keyRow.business_accounts.status !== 'active') return res.status(403).json({ error: 'Business account suspended' });
  req.apiKeyRow = keyRow;
  req.bizAccount = keyRow.business_accounts;
  // Log API call (non-blocking)
  supabase.from('business_api_logs').insert({
    business_id: keyRow.business_id, api_key_id: keyRow.id,
    endpoint: req.path, method: req.method, env_type: keyRow.env_type
  }).then(() => {}).catch(() => {});
  // Increment monthly counter (non-blocking)
  supabase.from('business_accounts')
    .update({ api_calls_this_month: (keyRow.business_accounts.api_calls_this_month||0) + 1 })
    .eq('id', keyRow.business_id).then(() => {}).catch(() => {});
  next();
}

// ── Webhook fire helper ──
async function fireBusinessWebhook(businessId, event, payload) {
  try {
    const { data: hooks } = await supabase.from('business_webhooks')
      .select('*').eq('business_id', businessId).eq('status', 'active');
    if (!hooks?.length) return;
    for (const hook of hooks) {
      if (!hook.events?.includes(event)) continue;
      const body = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() });
      const sig = crypto.createHmac('sha256', hook.secret_key || 'safepass').update(body).digest('hex');
      try {
        await fetch(hook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-SafePass-Signature': sig, 'X-SafePass-Event': event },
          body, signal: AbortSignal.timeout(5000)
        });
        await supabase.from('business_webhooks').update({ last_triggered_at: new Date().toISOString() }).eq('id', hook.id);
      } catch(e) {}
    }
  } catch(e) {}
}

// ── API key generator ──
function genApiKey(env) {
  const prefix = env === 'production' ? 'sk_live_' : 'sk_test_';
  return prefix + crypto.randomBytes(20).toString('hex');
}
function genApiSecret() { return 'ss_' + crypto.randomBytes(24).toString('hex'); }

// ── BUSINESS AUTH ──
app.post('/api/business/auth/register', async (req, res) => {
  try {
    const { company_name, email, phone, website, password } = req.body;
    if (!company_name || !email || !password) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
    if (password.length < 8) return res.status(400).json({ error: 'Mật khẩu tối thiểu 8 ký tự' });
    const { data: existing } = await supabase.from('business_accounts').select('id').eq('email', email).single();
    if (existing) return res.status(409).json({ error: 'Email đã được đăng ký' });
    const password_hash = await bcrypt.hash(password, 10);
    const { data: biz, error } = await supabase.from('business_accounts').insert({
      company_name: sanitize(company_name), email: email.toLowerCase().trim(),
      phone: phone||null, website: website||null, password_hash, status: 'active', plan: 'starter'
    }).select().single();
    if (error) return res.status(500).json({ error: 'Tạo tài khoản thất bại' });
    // Auto-create sandbox key
    await supabase.from('api_keys').insert({
      business_id: biz.id, name: 'Default Sandbox Key',
      api_key: genApiKey('sandbox'), api_secret: genApiSecret(), env_type: 'sandbox'
    });
    const token = jwt.sign({ type: 'business_jwt', bizId: biz.id, email: biz.email }, JWT_SECRET, { expiresIn: '30d' });
    const { password_hash: _ph, ...bizSafe } = biz;
    res.json({ token, business: bizSafe });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/business/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Nhập email và mật khẩu' });
    const { data: biz } = await supabase.from('business_accounts').select('*').eq('email', email.toLowerCase().trim()).single();
    if (!biz) return res.status(401).json({ error: 'Email không tồn tại' });
    if (biz.status === 'suspended') return res.status(403).json({ error: 'Tài khoản bị khóa' });
    const ok = await bcrypt.compare(password, biz.password_hash);
    if (!ok) return res.status(401).json({ error: 'Mật khẩu không đúng' });
    const token = jwt.sign({ type: 'business_jwt', bizId: biz.id, email: biz.email }, JWT_SECRET, { expiresIn: '30d' });
    const { password_hash: _ph, ...bizSafe } = biz;
    res.json({ token, business: bizSafe });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.get('/api/business/auth/me', businessAuth, async (req, res) => {
  const { data: biz } = await supabase.from('business_accounts').select('id,company_name,email,phone,website,status,plan,api_calls_this_month,transactions_this_month,created_at').eq('id', req.biz.bizId).single();
  if (!biz) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  res.json({ business: biz });
});

// ── DASHBOARD ──
app.get('/api/business/dashboard', businessAuth, async (req, res) => {
  try {
    const bizId = req.biz.bizId;
    const [{ data: biz }, { data: escrows }, { data: keys }] = await Promise.all([
      supabase.from('business_accounts').select('*').eq('id', bizId).single(),
      supabase.from('business_escrows').select('id,title,amount,status,ref,created_at').eq('business_id', bizId).order('created_at', { ascending: false }),
      supabase.from('api_keys').select('id,status').eq('business_id', bizId).eq('status', 'active')
    ]);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const escrowsThisMonth = (escrows||[]).filter(e => e.created_at >= monthStart);
    const totalVolume = (escrows||[]).reduce((s, e) => s + (e.amount||0), 0);
    res.json({
      api_calls_this_month: biz?.api_calls_this_month || 0,
      escrow_count_month: escrowsThisMonth.length,
      escrow_volume_total: totalVolume,
      active_keys: (keys||[]).length,
      recent_escrows: (escrows||[]).slice(0, 5)
    });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── API KEYS ──
app.get('/api/business/api-keys', businessAuth, async (req, res) => {
  const { data: keys } = await supabase.from('api_keys')
    .select('id,name,api_key,env_type,status,last_used_at,created_at')
    .eq('business_id', req.biz.bizId).order('created_at', { ascending: false });
  res.json({ keys: keys || [] });
});

app.post('/api/business/api-keys', businessAuth, async (req, res) => {
  try {
    const { name, env_type } = req.body;
    const env = env_type === 'production' ? 'production' : 'sandbox';
    const api_key = genApiKey(env);
    const api_secret = genApiSecret();
    const { data: key, error } = await supabase.from('api_keys').insert({
      business_id: req.biz.bizId, name: sanitize(name||'API Key'), api_key, api_secret, env_type: env
    }).select().single();
    if (error) return res.status(500).json({ error: 'Tạo key thất bại' });
    res.json({ api_key: key.api_key, api_secret: key.api_secret, id: key.id, env_type: key.env_type });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.delete('/api/business/api-keys/:id', businessAuth, async (req, res) => {
  const { error } = await supabase.from('api_keys')
    .update({ status: 'revoked' }).eq('id', req.params.id).eq('business_id', req.biz.bizId);
  if (error) return res.status(500).json({ error: 'Thất bại' });
  res.json({ ok: true });
});

// ── ESCROW API (via API key — external use) ──
app.post('/api/business/escrow/create', businessApiKeyAuth, async (req, res) => {
  try {
    const { title, description, amount, buyer_email, buyer_name, seller_email, seller_name, ref, category, metadata, expires_hours } = req.body;
    if (!title || !amount) return res.status(400).json({ error: 'title và amount là bắt buộc' });
    if (amount < 1000) return res.status(400).json({ error: 'Số tiền tối thiểu 1,000 VND' });
    if (ref) {
      const { data: dup } = await supabase.from('business_escrows').select('id').eq('ref', ref).eq('business_id', req.bizAccount.id).single();
      if (dup) return res.status(409).json({ error: 'ref đã tồn tại, dùng ref khác' });
    }
    const expiresAt = expires_hours ? new Date(Date.now() + (expires_hours||48) * 3600000).toISOString() : null;
    const { data: escrow, error } = await supabase.from('business_escrows').insert({
      business_id: req.bizAccount.id, api_key_id: req.apiKeyRow.id,
      env_type: req.apiKeyRow.env_type, ref: ref||null,
      title: sanitize(title), description: sanitize(description||''),
      amount: parseInt(amount), currency: 'VND',
      buyer_email: buyer_email||null, buyer_name: buyer_name||null,
      seller_email: seller_email||null, seller_name: seller_name||null,
      category: category||'general', metadata: metadata||null,
      status: 'pending', expires_at: expiresAt
    }).select().single();
    if (error) return res.status(500).json({ error: 'Tạo escrow thất bại' });
    fireBusinessWebhook(req.bizAccount.id, 'escrow.created', escrow);
    res.status(201).json({ ok: true, escrow });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.get('/api/business/escrow', businessAuth, async (req, res) => {
  const { data: escrows } = await supabase.from('business_escrows')
    .select('*').eq('business_id', req.biz.bizId).order('created_at', { ascending: false }).limit(100);
  res.json({ escrows: escrows || [] });
});

app.get('/api/business/escrow/:id', businessApiKeyAuth, async (req, res) => {
  const { data: escrow } = await supabase.from('business_escrows')
    .select('*').eq('id', req.params.id).eq('business_id', req.bizAccount.id).single();
  if (!escrow) return res.status(404).json({ error: 'Không tìm thấy escrow' });
  res.json({ escrow });
});

app.post('/api/business/escrow/:id/release', businessApiKeyAuth, async (req, res) => {
  try {
    const { data: escrow } = await supabase.from('business_escrows')
      .select('*').eq('id', req.params.id).eq('business_id', req.bizAccount.id).single();
    if (!escrow) return res.status(404).json({ error: 'Không tìm thấy escrow' });
    if (!['funded','pending'].includes(escrow.status)) return res.status(400).json({ error: `Không thể release escrow ở trạng thái ${escrow.status}` });
    const { data: updated } = await supabase.from('business_escrows')
      .update({ status: 'completed', released_at: new Date().toISOString() })
      .eq('id', escrow.id).select().single();
    fireBusinessWebhook(req.bizAccount.id, 'escrow.released', updated);
    res.json({ ok: true, escrow: updated });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/business/escrow/:id/refund', businessApiKeyAuth, async (req, res) => {
  try {
    const { data: escrow } = await supabase.from('business_escrows')
      .select('*').eq('id', req.params.id).eq('business_id', req.bizAccount.id).single();
    if (!escrow) return res.status(404).json({ error: 'Không tìm thấy escrow' });
    if (escrow.status === 'completed') return res.status(400).json({ error: 'Escrow đã hoàn tất, không thể hoàn tiền' });
    const { data: updated } = await supabase.from('business_escrows')
      .update({ status: 'refunded', refunded_at: new Date().toISOString() })
      .eq('id', escrow.id).select().single();
    fireBusinessWebhook(req.bizAccount.id, 'escrow.refunded', updated);
    res.json({ ok: true, escrow: updated });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── TRUST & FRAUD (via API key) ──
app.get('/api/business/trust/:phone', businessApiKeyAuth, async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { data: user } = await supabase.from('users').select('id,name,is_verified,avg_rating,review_count,is_banned,created_at').eq('phone', phone).single();
    if (!user) return res.status(404).json({ error: 'Người dùng không tồn tại trên SafePass' });
    const { data: orders } = await supabase.from('orders').select('id,status').or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`);
    const total = (orders||[]).length;
    const completed = (orders||[]).filter(o => o.status === 'completed').length;
    const disputed = (orders||[]).filter(o => o.status === 'disputed').length;
    const completionRate = total > 0 ? completed / total : 0;
    let score = 50;
    if (user.is_verified) score += 20;
    if (total > 5) score += 10;
    if (completionRate > 0.9) score += 15;
    if (user.avg_rating >= 4.5) score += 10;
    if (user.is_banned) score = 0;
    if (disputed > 2) score -= 15;
    score = Math.max(0, Math.min(100, score));
    const level = score >= 80 ? 'trusted' : score >= 50 ? 'moderate' : 'risky';
    res.json({ phone, trust_score: score, level, total_orders: total, completed_orders: completed, disputed_orders: disputed, avg_rating: user.avg_rating||null, is_verified: user.is_verified, is_banned: user.is_banned });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/business/fraud-check', businessApiKeyAuth, async (req, res) => {
  try {
    const { phone, amount } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone là bắt buộc' });
    const { data: user } = await supabase.from('users').select('id,is_banned,is_verified,avg_rating,review_count,created_at').eq('phone', phone).single();
    const flags = [];
    let risk = 0;
    if (!user) { flags.push('User không tồn tại trên SafePass'); risk += 40; }
    else {
      if (user.is_banned) { flags.push('Tài khoản đã bị khóa'); risk += 80; }
      if (!user.is_verified) { risk += 15; }
      if ((user.review_count||0) < 3) { risk += 10; }
      if ((user.avg_rating||5) < 3) { flags.push('Đánh giá thấp'); risk += 20; }
      const accountAge = (Date.now() - new Date(user.created_at)) / 86400000;
      if (accountAge < 7) { flags.push('Tài khoản mới tạo dưới 7 ngày'); risk += 15; }
      if (amount > 10000000) { risk += 10; }
      if (amount > 50000000) { flags.push('Giao dịch giá trị rất cao'); risk += 20; }
    }
    risk = Math.min(100, risk);
    const risk_level = risk >= 60 ? 'high' : risk >= 30 ? 'medium' : 'low';
    const recommendation = risk >= 60 ? 'REJECT' : risk >= 30 ? 'REVIEW' : 'APPROVE';
    if (risk >= 60) fireBusinessWebhook(req.bizAccount.id, 'fraud.detected', { phone, risk_score: risk, flags });
    res.json({ risk_level, risk_score: risk, flags, recommendation });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── WEBHOOKS ──
app.get('/api/business/webhooks', businessAuth, async (req, res) => {
  const { data: webhooks } = await supabase.from('business_webhooks')
    .select('id,url,events,status,last_triggered_at,created_at').eq('business_id', req.biz.bizId).order('created_at', { ascending: false });
  res.json({ webhooks: webhooks || [] });
});

app.post('/api/business/webhooks', businessAuth, async (req, res) => {
  try {
    const { url, secret_key, events, retry_count } = req.body;
    if (!url) return res.status(400).json({ error: 'URL là bắt buộc' });
    if (!Array.isArray(events) || !events.length) return res.status(400).json({ error: 'Chọn ít nhất 1 event' });
    const { data: hook, error } = await supabase.from('business_webhooks').insert({
      business_id: req.biz.bizId, url, secret_key: secret_key || genToken(),
      events, retry_count: retry_count || 3, status: 'active'
    }).select().single();
    if (error) return res.status(500).json({ error: 'Tạo webhook thất bại' });
    res.status(201).json({ ok: true, webhook: hook });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.delete('/api/business/webhooks/:id', businessAuth, async (req, res) => {
  const { error } = await supabase.from('business_webhooks').delete().eq('id', req.params.id).eq('business_id', req.biz.bizId);
  if (error) return res.status(500).json({ error: 'Xóa thất bại' });
  res.json({ ok: true });
});

// ── ANALYTICS ──
app.get('/api/business/analytics', businessAuth, async (req, res) => {
  try {
    const bizId = req.biz.bizId;
    const [{ count: totalApiCalls }, { data: escrows }] = await Promise.all([
      supabase.from('business_api_logs').select('*', { count: 'exact', head: true }).eq('business_id', bizId),
      supabase.from('business_escrows').select('id,status,env_type').eq('business_id', bizId)
    ]);
    const all = escrows || [];
    const byStatus = ['pending','funded','completed','refunded','disputed','cancelled'].map(s => ({
      status: s, count: all.filter(e => e.status === s).length
    })).filter(s => s.count > 0);
    const byEnv = ['sandbox','production'].map(e => ({
      env_type: e, count: all.filter(es => es.env_type === e).length
    })).filter(e => e.count > 0);
    res.json({
      total_api_calls: totalApiCalls || 0,
      total_escrows: all.length,
      completed: all.filter(e => e.status === 'completed').length,
      disputed: all.filter(e => e.status === 'disputed').length,
      by_status: byStatus, by_env: byEnv
    });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── WHITE LABEL ──
app.get('/api/business/white-label', businessAuth, async (req, res) => {
  const { data: config } = await supabase.from('white_label_configs').select('*').eq('business_id', req.biz.bizId).single();
  res.json({ config: config || null });
});

app.put('/api/business/white-label', businessAuth, async (req, res) => {
  try {
    const { brand_name, logo_url, primary_color, domain, custom_css } = req.body;
    const { data: existing } = await supabase.from('white_label_configs').select('id').eq('business_id', req.biz.bizId).single();
    const payload = { business_id: req.biz.bizId, brand_name: sanitize(brand_name||''), logo_url: logo_url||null, primary_color: primary_color||'#3d8ef8', domain: domain||null, custom_css: custom_css||null, updated_at: new Date().toISOString() };
    let result;
    if (existing) {
      result = await supabase.from('white_label_configs').update(payload).eq('id', existing.id).select().single();
    } else {
      result = await supabase.from('white_label_configs').insert(payload).select().single();
    }
    if (result.error) return res.status(500).json({ error: 'Lưu thất bại' });
    res.json({ ok: true, config: result.data });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── BILLING ──
app.get('/api/business/billing', businessAuth, async (req, res) => {
  const { data: biz } = await supabase.from('business_accounts')
    .select('plan,api_calls_this_month,transactions_this_month,plan_expires_at').eq('id', req.biz.bizId).single();
  res.json(biz || {});
});

app.post('/api/business/billing/upgrade', businessAuth, async (req, res) => {
  const { plan } = req.body;
  if (!['starter','growth','enterprise'].includes(plan)) return res.status(400).json({ error: 'Gói không hợp lệ' });
  const { error } = await supabase.from('business_accounts').update({ plan }).eq('id', req.biz.bizId);
  if (error) return res.status(500).json({ error: 'Nâng cấp thất bại' });
  res.json({ ok: true, plan });
});

// ── ADMIN — Business Management ──
app.get('/api/admin/business/accounts', adminAuth, async (req, res) => {
  const { data: accounts } = await supabase.from('business_accounts')
    .select('id,company_name,email,phone,website,status,plan,api_calls_this_month,transactions_this_month,created_at')
    .order('created_at', { ascending: false });
  res.json({ accounts: accounts || [] });
});

app.patch('/api/admin/business/accounts/:id/status', adminAuth, async (req, res) => {
  const { status } = req.body;
  if (!['active','pending','suspended'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  const { error } = await supabase.from('business_accounts').update({ status }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Cập nhật thất bại' });
  res.json({ ok: true });
});

app.get('/api/admin/business/api-usage', adminAuth, async (req, res) => {
  const { data: logs } = await supabase.from('business_api_logs')
    .select('business_id, endpoint, env_type, created_at').order('created_at', { ascending: false }).limit(200);
  res.json({ logs: logs || [] });
});

// ── SERVE business.html ──
app.get('/business', (req, res) => {
  res.sendFile(join(__dirname, 'frontend', 'business.html'));
});

// ══════════════════════════════════════════════════════════
//  SAFEPASS FREELANCE — Fiverr/Upwork-style Marketplace
// ══════════════════════════════════════════════════════════

const FL_FEE_RATE = 0.05; // 5% platform fee

async function flLogActivity(contractId, actorId, actorName, action, detail = '') {
  try {
    await supabase.from('fl_activities').insert({ contract_id: contractId, actor_id: actorId, actor_name: actorName, action, detail });
  } catch(e) {}
}

// ── Categories ──
const FL_CATEGORIES = [
  { id: 'design',    label: 'Thiết Kế',     icon: '🎨', subs: ['Logo','Banner','UI/UX','Illustration'] },
  { id: 'video',     label: 'Video',         icon: '🎬', subs: ['Edit Video','YouTube','TikTok','Motion'] },
  { id: 'marketing', label: 'Marketing',     icon: '📢', subs: ['Facebook Ads','Google Ads','SEO','Content'] },
  { id: 'ai',        label: 'AI & Automation',icon: '🤖', subs: ['Prompt AI','Chatbot','Automation','Data'] },
  { id: 'code',      label: 'Lập Trình',     icon: '💻', subs: ['Website','Mobile App','Game','API'] },
  { id: 'writing',   label: 'Viết Nội Dung', icon: '✍️', subs: ['Blog','Kịch bản','Copywriting','Dịch thuật'] }
];

app.get('/api/freelance/categories', (req, res) => res.json({ categories: FL_CATEGORIES }));

// ── Freelancer Profiles ──
app.get('/api/freelance/profiles', async (req, res) => {
  const { category, q, limit = 20, page = 1 } = req.query;
  let query = supabase.from('fl_profiles').select('*, users!inner(id,name,phone,is_verified)').eq('is_available', true);
  if (category) query = query.eq('category', category);
  if (q) query = query.ilike('display_name', `%${q}%`);
  query = query.order('avg_rating', { ascending: false }).range((page-1)*limit, page*limit-1);
  const { data, error } = await query;
  res.json({ profiles: data || [] });
});

app.get('/api/freelance/profiles/:userId', async (req, res) => {
  const { data: profile } = await supabase.from('fl_profiles').select('*, users!inner(id,name,is_verified,avg_rating,review_count)').eq('user_id', req.params.userId).single();
  if (!profile) return res.status(404).json({ error: 'Không tìm thấy profile' });
  const { data: gigs } = await supabase.from('fl_gigs').select('*').eq('seller_id', req.params.userId).eq('status', 'active').limit(6);
  const { data: reviews } = await supabase.from('fl_reviews').select('*, users!reviewer_id(name)').eq('reviewee_id', req.params.userId).order('created_at', { ascending: false }).limit(10);
  res.json({ profile, gigs: gigs||[], reviews: reviews||[] });
});

app.get('/api/freelance/profiles/me', auth, async (req, res) => {
  const { data } = await supabase.from('fl_profiles').select('*').eq('user_id', req.user.id).single();
  res.json({ profile: data || null });
});

app.put('/api/freelance/profiles/me', auth, async (req, res) => {
  try {
    const { display_name, tagline, bio, skills, category, experience_years, country, language, hourly_rate, avatar_url, portfolio_url, is_available } = req.body;
    const { data: existing } = await supabase.from('fl_profiles').select('id').eq('user_id', req.user.id).single();
    const payload = {
      user_id: req.user.id,
      display_name: sanitize(display_name||''),
      tagline: sanitize(tagline||''),
      bio: sanitize(bio||''),
      skills: Array.isArray(skills) ? skills.map(s=>sanitize(s)) : [],
      category: category||'code',
      experience_years: parseInt(experience_years)||0,
      country: sanitize(country||'Vietnam'),
      language: sanitize(language||'Vietnamese'),
      hourly_rate: parseInt(hourly_rate)||0,
      avatar_url: avatar_url||null,
      portfolio_url: portfolio_url||null,
      is_available: is_available !== false,
      updated_at: new Date().toISOString()
    };
    let result;
    if (existing) {
      result = await supabase.from('fl_profiles').update(payload).eq('id', existing.id).select().single();
    } else {
      result = await supabase.from('fl_profiles').insert(payload).select().single();
    }
    if (result.error) return res.status(500).json({ error: 'Lưu profile thất bại' });
    res.json({ ok: true, profile: result.data });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── Gigs ──
app.get('/api/freelance/gigs', async (req, res) => {
  const { category, q, min_price, max_price, sort = 'rating', limit = 24, page = 1 } = req.query;
  let query = supabase.from('fl_gigs').select('*, users!seller_id(id,name,is_verified)').eq('status', 'active');
  if (category) query = query.eq('category', category);
  if (q) query = query.ilike('title', `%${q}%`);
  if (min_price) query = query.gte('price', parseInt(min_price));
  if (max_price) query = query.lte('price', parseInt(max_price));
  if (sort === 'price_asc') query = query.order('price', { ascending: true });
  else if (sort === 'price_desc') query = query.order('price', { ascending: false });
  else if (sort === 'newest') query = query.order('created_at', { ascending: false });
  else query = query.order('avg_rating', { ascending: false });
  query = query.range((page-1)*limit, page*limit-1);
  const { data, count } = await query;
  res.json({ gigs: data||[], total: count||0, page: parseInt(page), limit: parseInt(limit) });
});

app.get('/api/freelance/gigs/mine', auth, async (req, res) => {
  const { data } = await supabase.from('fl_gigs').select('*').eq('seller_id', req.user.id).order('created_at', { ascending: false });
  res.json({ gigs: data||[] });
});

app.get('/api/freelance/gigs/:id', async (req, res) => {
  const { data: gig } = await supabase.from('fl_gigs').select('*, users!seller_id(id,name,is_verified,avg_rating,review_count)').eq('id', req.params.id).single();
  if (!gig) return res.status(404).json({ error: 'Không tìm thấy gig' });
  await supabase.from('fl_gigs').update({ view_count: (gig.view_count||0)+1 }).eq('id', gig.id);
  const { data: reviews } = await supabase.from('fl_reviews').select('*, users!reviewer_id(name)').eq('gig_id', gig.id).order('created_at', { ascending: false }).limit(10);
  res.json({ gig, reviews: reviews||[] });
});

app.post('/api/freelance/gigs', auth, async (req, res) => {
  try {
    const { title, description, category, subcategory, price, delivery_days, revisions, image_url, images, tags } = req.body;
    if (!title || !category || !price) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
    const { data: gig, error } = await supabase.from('fl_gigs').insert({
      seller_id: req.user.id,
      title: sanitize(title), description: sanitize(description||''),
      category, subcategory: subcategory||null, price: parseInt(price),
      delivery_days: parseInt(delivery_days)||3, revisions: parseInt(revisions)||1,
      image_url: image_url||null, images: Array.isArray(images)?images:[],
      tags: Array.isArray(tags)?tags.map(t=>sanitize(t)):[], status: 'active'
    }).select().single();
    if (error) return res.status(500).json({ error: 'Tạo gig thất bại' });
    res.status(201).json({ ok: true, gig });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.patch('/api/freelance/gigs/:id', auth, async (req, res) => {
  const { data: gig } = await supabase.from('fl_gigs').select('seller_id').eq('id', req.params.id).single();
  if (!gig || gig.seller_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  const allowed = ['title','description','price','delivery_days','revisions','image_url','images','tags','status'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('fl_gigs').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: 'Cập nhật thất bại' });
  res.json({ ok: true, gig: data });
});

// ── Job Postings ──
app.get('/api/freelance/jobs', async (req, res) => {
  const { category, q, status = 'open', limit = 20, page = 1 } = req.query;
  let query = supabase.from('fl_jobs').select('*, users!client_id(id,name,is_verified)').eq('status', status);
  if (category) query = query.eq('category', category);
  if (q) query = query.ilike('title', `%${q}%`);
  query = query.order('created_at', { ascending: false }).range((page-1)*limit, page*limit-1);
  const { data } = await query;
  res.json({ jobs: data||[] });
});

app.get('/api/freelance/jobs/mine', auth, async (req, res) => {
  const { data } = await supabase.from('fl_jobs').select('*').eq('client_id', req.user.id).order('created_at', { ascending: false });
  res.json({ jobs: data||[] });
});

app.get('/api/freelance/jobs/:id', async (req, res) => {
  const { data: job } = await supabase.from('fl_jobs').select('*, users!client_id(id,name,is_verified)').eq('id', req.params.id).single();
  if (!job) return res.status(404).json({ error: 'Không tìm thấy job' });
  await supabase.from('fl_jobs').update({ view_count: (job.view_count||0)+1 }).eq('id', job.id);
  const { data: proposals } = await supabase.from('fl_proposals').select('*, users!freelancer_id(id,name,is_verified,avg_rating,review_count)').eq('job_id', job.id).order('created_at', { ascending: false });
  res.json({ job, proposals: proposals||[] });
});

app.post('/api/freelance/jobs', auth, async (req, res) => {
  try {
    const { title, description, category, skills_required, budget_min, budget_max, budget_type, deadline } = req.body;
    if (!title || !category) return res.status(400).json({ error: 'Thiếu tiêu đề và danh mục' });
    const { data: job, error } = await supabase.from('fl_jobs').insert({
      client_id: req.user.id, title: sanitize(title), description: sanitize(description||''),
      category, skills_required: Array.isArray(skills_required)?skills_required:[],
      budget_min: parseInt(budget_min)||0, budget_max: parseInt(budget_max)||0,
      budget_type: budget_type||'fixed', deadline: deadline||null, status: 'open'
    }).select().single();
    if (error) return res.status(500).json({ error: 'Đăng job thất bại' });
    res.status(201).json({ ok: true, job });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── Proposals ──
app.post('/api/freelance/jobs/:jobId/proposals', auth, async (req, res) => {
  try {
    const { price, delivery_days, cover_letter } = req.body;
    if (!price || !delivery_days) return res.status(400).json({ error: 'Thiếu giá và thời gian' });
    const { data: job } = await supabase.from('fl_jobs').select('client_id,status').eq('id', req.params.jobId).single();
    if (!job) return res.status(404).json({ error: 'Job không tồn tại' });
    if (job.status !== 'open') return res.status(400).json({ error: 'Job đã đóng' });
    if (job.client_id === req.user.id) return res.status(400).json({ error: 'Không thể tự apply job của mình' });
    const { data: existing } = await supabase.from('fl_proposals').select('id').eq('job_id', req.params.jobId).eq('freelancer_id', req.user.id).single();
    if (existing) return res.status(409).json({ error: 'Bạn đã gửi proposal rồi' });
    const { data: proposal, error } = await supabase.from('fl_proposals').insert({
      job_id: req.params.jobId, freelancer_id: req.user.id,
      price: parseInt(price), delivery_days: parseInt(delivery_days),
      cover_letter: sanitize(cover_letter||''), status: 'pending'
    }).select().single();
    if (error) return res.status(500).json({ error: 'Gửi proposal thất bại' });
    await supabase.from('fl_jobs').update({ proposal_count: supabase.rpc ? undefined : undefined }).eq('id', req.params.jobId);
    res.status(201).json({ ok: true, proposal });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.patch('/api/freelance/proposals/:id/accept', auth, async (req, res) => {
  try {
    const { data: proposal } = await supabase.from('fl_proposals')
      .select('*, fl_jobs!inner(client_id, title, description)').eq('id', req.params.id).single();
    if (!proposal) return res.status(404).json({ error: 'Proposal không tồn tại' });
    if (proposal.fl_jobs.client_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
    // Check buyer wallet
    const { data: client } = await supabase.from('users').select('wallet_balance').eq('id', req.user.id).single();
    const totalWithFee = Math.floor(proposal.price * (1 + FL_FEE_RATE));
    if ((client?.wallet_balance||0) < totalWithFee) return res.status(400).json({ error: `Số dư không đủ. Cần ${totalWithFee.toLocaleString('vi')}đ (bao gồm phí 5%)` });
    // Deduct from client wallet
    await supabase.from('users').update({ wallet_balance: client.wallet_balance - totalWithFee }).eq('id', req.user.id);
    // Create contract
    const { data: contract, error } = await supabase.from('fl_contracts').insert({
      job_id: proposal.job_id, proposal_id: proposal.id,
      client_id: req.user.id, freelancer_id: proposal.freelancer_id,
      title: proposal.fl_jobs.title, description: proposal.fl_jobs.description,
      total_amount: proposal.price, escrow_amount: totalWithFee,
      platform_fee: totalWithFee - proposal.price,
      status: 'active',
      deadline: new Date(Date.now() + proposal.delivery_days * 86400000).toISOString().split('T')[0]
    }).select().single();
    if (error) { await supabase.from('users').update({ wallet_balance: client.wallet_balance }).eq('id', req.user.id); return res.status(500).json({ error: 'Tạo contract thất bại' }); }
    // Update proposal & job status
    await supabase.from('fl_proposals').update({ status: 'accepted' }).eq('id', proposal.id);
    await supabase.from('fl_jobs').update({ status: 'in_progress' }).eq('id', proposal.job_id);
    // Log transaction
    await supabase.from('transactions').insert({ user_id: req.user.id, type: 'escrow_lock', amount: -totalWithFee, description: `Khóa Escrow Freelance: ${contract.title}`, ref_id: contract.id });
    await flLogActivity(contract.id, req.user.id, 'Client', 'contract_started', 'Hợp đồng đã bắt đầu — tiền đã được khóa Escrow');
    // Notify freelancer
    await supabase.from('notifications').insert({ user_id: proposal.freelancer_id, type: 'fl_hired', title: '🎉 Bạn được thuê!', body: `${proposal.fl_jobs.title} — ${proposal.price.toLocaleString('vi')}đ`, link: `/freelance.html#contract-${contract.id}` });
    res.json({ ok: true, contract });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.patch('/api/freelance/proposals/:id/reject', auth, async (req, res) => {
  const { data: proposal } = await supabase.from('fl_proposals').select('*, fl_jobs!inner(client_id)').eq('id', req.params.id).single();
  if (!proposal || proposal.fl_jobs.client_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('fl_proposals').update({ status: 'rejected' }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Order a Gig directly ──
app.post('/api/freelance/gigs/:gigId/order', auth, async (req, res) => {
  try {
    const { data: gig } = await supabase.from('fl_gigs').select('*, users!seller_id(id,name)').eq('id', req.params.gigId).eq('status','active').single();
    if (!gig) return res.status(404).json({ error: 'Gig không tồn tại' });
    if (gig.seller_id === req.user.id) return res.status(400).json({ error: 'Không thể tự mua gig của mình' });
    const { data: client } = await supabase.from('users').select('wallet_balance,name').eq('id', req.user.id).single();
    const totalWithFee = Math.floor(gig.price * (1 + FL_FEE_RATE));
    if ((client?.wallet_balance||0) < totalWithFee) return res.status(400).json({ error: `Số dư không đủ. Cần ${totalWithFee.toLocaleString('vi')}đ` });
    await supabase.from('users').update({ wallet_balance: client.wallet_balance - totalWithFee }).eq('id', req.user.id);
    const { data: contract, error } = await supabase.from('fl_contracts').insert({
      gig_id: gig.id, client_id: req.user.id, freelancer_id: gig.seller_id,
      title: gig.title, description: gig.description||'',
      total_amount: gig.price, escrow_amount: totalWithFee,
      platform_fee: totalWithFee - gig.price, status: 'active',
      deadline: new Date(Date.now() + gig.delivery_days * 86400000).toISOString().split('T')[0]
    }).select().single();
    if (error) { await supabase.from('users').update({ wallet_balance: client.wallet_balance }).eq('id', req.user.id); return res.status(500).json({ error: 'Đặt gig thất bại' }); }
    await supabase.from('fl_gigs').update({ order_count: (gig.order_count||0)+1 }).eq('id', gig.id);
    await supabase.from('transactions').insert({ user_id: req.user.id, type: 'escrow_lock', amount: -totalWithFee, description: `Khóa Escrow Gig: ${gig.title}`, ref_id: contract.id });
    await flLogActivity(contract.id, req.user.id, client.name||'Client', 'contract_started', 'Đơn hàng mới — tiền đã khóa Escrow');
    await supabase.from('notifications').insert({ user_id: gig.seller_id, type: 'fl_order', title: '🛒 Đơn hàng mới!', body: `${gig.title} — ${gig.price.toLocaleString('vi')}đ`, link: `/freelance.html#contract-${contract.id}` });
    res.status(201).json({ ok: true, contract });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── Contracts ──
app.get('/api/freelance/contracts', auth, async (req, res) => {
  const { role = 'all' } = req.query;
  let query = supabase.from('fl_contracts').select('*, client:users!client_id(id,name), freelancer:users!freelancer_id(id,name,is_verified)');
  if (role === 'client') query = query.eq('client_id', req.user.id);
  else if (role === 'freelancer') query = query.eq('freelancer_id', req.user.id);
  else query = query.or(`client_id.eq.${req.user.id},freelancer_id.eq.${req.user.id}`);
  query = query.order('created_at', { ascending: false });
  const { data } = await query;
  res.json({ contracts: data||[] });
});

app.get('/api/freelance/contracts/:id', auth, async (req, res) => {
  const { data: contract } = await supabase.from('fl_contracts')
    .select('*, client:users!client_id(id,name,is_verified), freelancer:users!freelancer_id(id,name,is_verified)')
    .eq('id', req.params.id).single();
  if (!contract) return res.status(404).json({ error: 'Không tìm thấy' });
  if (contract.client_id !== req.user.id && contract.freelancer_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  const [{ data: milestones }, { data: messages }, { data: files }, { data: activities }] = await Promise.all([
    supabase.from('fl_milestones').select('*').eq('contract_id', contract.id).order('order_index'),
    supabase.from('fl_messages').select('*').eq('contract_id', contract.id).order('created_at'),
    supabase.from('fl_files').select('*').eq('contract_id', contract.id).order('created_at', { ascending: false }),
    supabase.from('fl_activities').select('*').eq('contract_id', contract.id).order('created_at')
  ]);
  res.json({ contract, milestones: milestones||[], messages: messages||[], files: files||[], activities: activities||[] });
});

// ── Milestones ──
app.post('/api/freelance/contracts/:id/milestones', auth, async (req, res) => {
  const { data: contract } = await supabase.from('fl_contracts').select('client_id,freelancer_id').eq('id', req.params.id).single();
  if (!contract || (contract.client_id !== req.user.id && contract.freelancer_id !== req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
  const { title, description, amount, due_date, order_index } = req.body;
  if (!title || !amount) return res.status(400).json({ error: 'Thiếu tiêu đề và giá trị' });
  const { data: ms, error } = await supabase.from('fl_milestones').insert({
    contract_id: req.params.id, title: sanitize(title), description: sanitize(description||''),
    amount: parseInt(amount), due_date: due_date||null, order_index: parseInt(order_index)||0, status: 'pending'
  }).select().single();
  if (error) return res.status(500).json({ error: 'Tạo milestone thất bại' });
  const { data: u } = await supabase.from('users').select('name').eq('id', req.user.id).single();
  await flLogActivity(req.params.id, req.user.id, u?.name||'User', 'milestone_created', `Milestone "${title}" đã được tạo`);
  res.status(201).json({ ok: true, milestone: ms });
});

app.patch('/api/freelance/milestones/:id/submit', auth, async (req, res) => {
  const { data: ms } = await supabase.from('fl_milestones').select('*, fl_contracts!inner(freelancer_id,client_id,title)').eq('id', req.params.id).single();
  if (!ms || ms.fl_contracts.freelancer_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('fl_milestones').update({ status: 'submitted', submitted_at: new Date().toISOString() }).eq('id', req.params.id);
  await supabase.from('fl_contracts').update({ status: 'submitted' }).eq('id', ms.contract_id);
  const { data: u } = await supabase.from('users').select('name').eq('id', req.user.id).single();
  await flLogActivity(ms.contract_id, req.user.id, u?.name||'Freelancer', 'milestone_submitted', `Nộp milestone: "${ms.title}"`);
  await supabase.from('notifications').insert({ user_id: ms.fl_contracts.client_id, type: 'fl_submitted', title: '📋 Freelancer đã nộp bài', body: ms.fl_contracts.title, link: `/freelance.html#contract-${ms.contract_id}` });
  res.json({ ok: true });
});

app.patch('/api/freelance/milestones/:id/approve', auth, async (req, res) => {
  try {
    const { data: ms } = await supabase.from('fl_milestones').select('*, fl_contracts!inner(client_id,freelancer_id,total_amount,escrow_amount,platform_fee,title)').eq('id', req.params.id).single();
    if (!ms || ms.fl_contracts.client_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
    if (ms.status !== 'submitted') return res.status(400).json({ error: 'Milestone chưa được nộp' });
    // Check if all milestones done → release full escrow; else partial
    const { data: allMs } = await supabase.from('fl_milestones').select('id,status,amount').eq('contract_id', ms.contract_id);
    const remaining = allMs ? allMs.filter(m => m.id !== ms.id && m.status !== 'approved') : [];
    await supabase.from('fl_milestones').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', ms.id);
    if (remaining.length === 0) {
      // Release full escrow to freelancer
      const payout = ms.fl_contracts.total_amount;
      await supabase.from('users').update({ wallet_balance: supabase.rpc ? undefined : undefined }).eq('id', ms.fl_contracts.freelancer_id);
      const { data: fl } = await supabase.from('users').select('wallet_balance').eq('id', ms.fl_contracts.freelancer_id).single();
      await supabase.from('users').update({ wallet_balance: (fl?.wallet_balance||0) + payout }).eq('id', ms.fl_contracts.freelancer_id);
      await supabase.from('fl_contracts').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', ms.contract_id);
      await supabase.from('transactions').insert({ user_id: ms.fl_contracts.freelancer_id, type: 'fl_payout', amount: payout, description: `Thanh toán Freelance: ${ms.fl_contracts.title}`, ref_id: ms.contract_id });
      // Update freelancer stats
      const { data: flProfile } = await supabase.from('fl_profiles').select('total_projects,total_earned').eq('user_id', ms.fl_contracts.freelancer_id).single();
      if (flProfile) await supabase.from('fl_profiles').update({ total_projects: (flProfile.total_projects||0)+1, total_earned: (flProfile.total_earned||0)+payout }).eq('user_id', ms.fl_contracts.freelancer_id);
      await flLogActivity(ms.contract_id, req.user.id, 'Client', 'contract_completed', `Dự án hoàn tất — ${payout.toLocaleString('vi')}đ đã giải ngân cho freelancer`);
      await supabase.from('notifications').insert({ user_id: ms.fl_contracts.freelancer_id, type: 'fl_paid', title: '💰 Thanh toán thành công!', body: `${payout.toLocaleString('vi')}đ đã vào ví`, link: `/freelance.html#contract-${ms.contract_id}` });
    } else {
      await flLogActivity(ms.contract_id, req.user.id, 'Client', 'milestone_approved', `Duyệt milestone: "${ms.title}"`);
    }
    res.json({ ok: true, contract_completed: remaining.length === 0 });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── Contract Messages ──
app.get('/api/freelance/contracts/:id/messages', auth, async (req, res) => {
  const { data: contract } = await supabase.from('fl_contracts').select('client_id,freelancer_id').eq('id', req.params.id).single();
  if (!contract || (contract.client_id !== req.user.id && contract.freelancer_id !== req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
  const { data } = await supabase.from('fl_messages').select('*').eq('contract_id', req.params.id).order('created_at');
  res.json({ messages: data||[] });
});

app.post('/api/freelance/contracts/:id/messages', auth, async (req, res) => {
  const { data: contract } = await supabase.from('fl_contracts').select('client_id,freelancer_id').eq('id', req.params.id).single();
  if (!contract || (contract.client_id !== req.user.id && contract.freelancer_id !== req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Tin nhắn trống' });
  const { data: u } = await supabase.from('users').select('name').eq('id', req.user.id).single();
  const { data: msg } = await supabase.from('fl_messages').insert({ contract_id: req.params.id, sender_id: req.user.id, sender_name: u?.name||'User', text: sanitize(text) }).select().single();
  const otherId = contract.client_id === req.user.id ? contract.freelancer_id : contract.client_id;
  sendToUser(otherId, { type: 'fl_msg', contractId: req.params.id, message: msg });
  res.status(201).json({ ok: true, message: msg });
});

// ── Reviews ──
app.post('/api/freelance/contracts/:id/review', auth, async (req, res) => {
  try {
    const { data: contract } = await supabase.from('fl_contracts').select('*').eq('id', req.params.id).single();
    if (!contract) return res.status(404).json({ error: 'Không tìm thấy' });
    if (contract.client_id !== req.user.id) return res.status(403).json({ error: 'Chỉ client mới được đánh giá' });
    if (contract.status !== 'completed') return res.status(400).json({ error: 'Contract chưa hoàn tất' });
    const { data: existing } = await supabase.from('fl_reviews').select('id').eq('contract_id', req.params.id).single();
    if (existing) return res.status(409).json({ error: 'Đã đánh giá rồi' });
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating phải từ 1-5' });
    const { data: review, error } = await supabase.from('fl_reviews').insert({
      contract_id: req.params.id, gig_id: contract.gig_id||null,
      reviewer_id: req.user.id, reviewee_id: contract.freelancer_id,
      rating: parseInt(rating), comment: sanitize(comment||'')
    }).select().single();
    if (error) return res.status(500).json({ error: 'Đánh giá thất bại' });
    // Recompute freelancer avg_rating
    const { data: allReviews } = await supabase.from('fl_reviews').select('rating').eq('reviewee_id', contract.freelancer_id);
    if (allReviews?.length) {
      const avg = allReviews.reduce((s,r)=>s+r.rating,0)/allReviews.length;
      await supabase.from('fl_profiles').update({ avg_rating: avg.toFixed(2), review_count: allReviews.length }).eq('user_id', contract.freelancer_id);
      if (contract.gig_id) await supabase.from('fl_gigs').update({ avg_rating: avg.toFixed(2), review_count: allReviews.length }).eq('id', contract.gig_id);
    }
    res.status(201).json({ ok: true, review });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── Leaderboard ──
app.get('/api/freelance/leaderboard', async (req, res) => {
  const { by = 'rating', limit = 20 } = req.query;
  let orderCol = 'avg_rating';
  if (by === 'projects') orderCol = 'total_projects';
  else if (by === 'earned') orderCol = 'total_earned';
  const { data } = await supabase.from('fl_profiles')
    .select('*, users!inner(id,name,is_verified)')
    .order(orderCol, { ascending: false }).limit(parseInt(limit));
  res.json({ leaderboard: data||[], by });
});

// ── Admin Freelance ──
app.get('/api/admin/freelance/stats', adminAuth, async (req, res) => {
  const [{ count: totalGigs }, { count: totalJobs }, { count: totalContracts }, { count: activeContracts }] = await Promise.all([
    supabase.from('fl_gigs').select('*', { count: 'exact', head: true }),
    supabase.from('fl_jobs').select('*', { count: 'exact', head: true }),
    supabase.from('fl_contracts').select('*', { count: 'exact', head: true }),
    supabase.from('fl_contracts').select('*', { count: 'exact', head: true }).in('status', ['active','submitted'])
  ]);
  res.json({ total_gigs: totalGigs||0, total_jobs: totalJobs||0, total_contracts: totalContracts||0, active_contracts: activeContracts||0 });
});

app.get('/api/admin/freelance/contracts', adminAuth, async (req, res) => {
  const { data } = await supabase.from('fl_contracts')
    .select('*, client:users!client_id(id,name), freelancer:users!freelancer_id(id,name)')
    .order('created_at', { ascending: false }).limit(100);
  res.json({ contracts: data||[] });
});

// ── Contract Files Upload ──
app.post('/api/freelance/contracts/:id/files', auth, async (req, res) => {
  const { data: contract } = await supabase.from('fl_contracts').select('client_id,freelancer_id').eq('id', req.params.id).single();
  if (!contract || (contract.client_id !== req.user.id && contract.freelancer_id !== req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
  const { file_name, file_url, file_size, milestone_id } = req.body;
  if (!file_name || !file_url) return res.status(400).json({ error: 'Thiếu tên file và URL' });
  const { data: u } = await supabase.from('users').select('name').eq('id', req.user.id).single();
  const { data: file, error } = await supabase.from('fl_files').insert({
    contract_id: req.params.id, uploader_id: req.user.id,
    uploader_name: u?.name||'User', file_name: sanitize(file_name),
    file_url, file_size: file_size||null, milestone_id: milestone_id||null
  }).select().single();
  if (error) return res.status(500).json({ error: 'Upload thất bại' });
  await flLogActivity(req.params.id, req.user.id, u?.name||'User', 'file_uploaded', `Đã upload: ${file_name}`);
  res.status(201).json({ ok: true, file });
});

// ── SERVE freelance.html ──
app.get('/freelance', (req, res) => {
  res.sendFile(join(__dirname, 'frontend', 'freelance.html'));
});

// ══════════════════════════════════════════════════════════
//  SAFEPASS LOGISTICS HUB
// ══════════════════════════════════════════════════════════

const LG_PROVINCES_SAME = ['Hồ Chí Minh','Hà Nội','Đà Nẵng','Cần Thơ','Hải Phòng'];
const LG_SERVICE_TYPES = {
  standard: { label: 'Tiêu chuẩn',  multiplier: 1.0, extra_days: 0 },
  express:  { label: 'Nhanh',        multiplier: 1.5, extra_days: -1 },
  same_day: { label: 'Hỏa tốc',      multiplier: 2.5, extra_days: -2 }
}
const LG_CARGO_FEES = { general:0, fragile:5000, electronics:10000, documents:0, food:5000, clothing:0 };
const LG_INSURANCE_RATE = 0.005; // 0.5% of declared value

function lgGenTrackingNumber() {
  const ts = Date.now().toString().slice(-8);
  const rand = Math.floor(Math.random()*9000+1000);
  return `SP${ts}${rand}`;
}

async function lgCalcFee(from_province, to_province, weight, service_type = 'standard', declared_value = 0, has_insurance = false) {
  let base = 20000, perKg = 5000, est_days = 2;
  const { data: route } = await supabase.from('lg_routes')
    .select('*').eq('from_province', from_province).eq('to_province', to_province).eq('is_active', true).single();
  if (route) { base = route.base_fee; perKg = route.per_kg_fee; est_days = route.est_days; }
  else if (from_province === to_province) { base = 15000; perKg = 3000; est_days = 1; }
  else { base = 30000; perKg = 6000; est_days = 3; }
  const svc = LG_SERVICE_TYPES[service_type] || LG_SERVICE_TYPES.standard;
  const weightFee = Math.ceil(weight / 0.5) * perKg;
  const subtotal = Math.floor((base + weightFee) * svc.multiplier);
  const insurance_fee = has_insurance ? Math.floor(declared_value * LG_INSURANCE_RATE) : 0;
  const total = subtotal + insurance_fee;
  const delivery_days = Math.max(1, est_days + svc.extra_days);
  const estimated_delivery = new Date(Date.now() + delivery_days * 86400000).toISOString().split('T')[0];
  return { shipping_fee: subtotal, insurance_fee, total_fee: total, estimated_delivery, delivery_days };
}

async function lgAddEvent(shipmentId, status, location, description, created_by = 'system') {
  await supabase.from('lg_tracking_events').insert({ shipment_id: shipmentId, status, location, description, created_by });
}

// ── Shipping Quote ──
app.post('/api/logistics/quote', async (req, res) => {
  try {
    const { from_province, to_province, weight, service_type, declared_value, has_insurance } = req.body;
    if (!from_province || !to_province || !weight) return res.status(400).json({ error: 'Thiếu thông tin' });
    const quote = await lgCalcFee(from_province, to_province, parseFloat(weight)||0.5, service_type||'standard', parseInt(declared_value)||0, has_insurance||false);
    const quotes = await Promise.all(Object.keys(LG_SERVICE_TYPES).map(async svc => {
      const q = await lgCalcFee(from_province, to_province, parseFloat(weight)||0.5, svc, parseInt(declared_value)||0, has_insurance||false);
      return { service_type: svc, label: LG_SERVICE_TYPES[svc].label, ...q };
    }));
    res.json({ quote, all_quotes: quotes });
  } catch(e) { res.status(500).json({ error: 'Lỗi tính phí' }); }
});

// ── Create Shipment ──
app.post('/api/logistics/shipments', auth, async (req, res) => {
  try {
    const {
      sender_name, sender_phone, sender_address, sender_district, sender_province,
      receiver_name, receiver_phone, receiver_address, receiver_district, receiver_province,
      cargo_type, weight, length, width, height, description,
      declared_value, has_insurance, service_type, cod_amount,
      payment_method, pickup_date, pickup_time_slot, notes
    } = req.body;
    if (!sender_name || !sender_phone || !sender_address || !sender_province ||
        !receiver_name || !receiver_phone || !receiver_address || !receiver_province)
      return res.status(400).json({ error: 'Thiếu thông tin người gửi/nhận' });
    const tracking_number = lgGenTrackingNumber();
    const fees = await lgCalcFee(
      sender_province, receiver_province, parseFloat(weight)||0.5,
      service_type||'standard', parseInt(declared_value)||0, has_insurance||false
    );
    const { data: shipment, error } = await supabase.from('lg_shipments').insert({
      tracking_number, user_id: req.user.id,
      sender_name: sanitize(sender_name), sender_phone: sanitize(sender_phone),
      sender_address: sanitize(sender_address), sender_district: sanitize(sender_district||''),
      sender_province: sanitize(sender_province),
      receiver_name: sanitize(receiver_name), receiver_phone: sanitize(receiver_phone),
      receiver_address: sanitize(receiver_address), receiver_district: sanitize(receiver_district||''),
      receiver_province: sanitize(receiver_province),
      cargo_type: cargo_type||'general', weight: parseFloat(weight)||0.5,
      length: parseFloat(length)||null, width: parseFloat(width)||null, height: parseFloat(height)||null,
      description: sanitize(description||''), declared_value: parseInt(declared_value)||0,
      has_insurance: has_insurance||false, service_type: service_type||'standard',
      cod_amount: parseInt(cod_amount)||0, payment_method: payment_method||'sender',
      pickup_date: pickup_date||null, pickup_time_slot: pickup_time_slot||null,
      notes: sanitize(notes||''),
      shipping_fee: fees.shipping_fee, insurance_fee: fees.insurance_fee, total_fee: fees.total_fee,
      estimated_delivery: fees.estimated_delivery, status: 'pending'
    }).select().single();
    if (error) return res.status(500).json({ error: 'Tạo đơn thất bại: ' + error.message });
    await lgAddEvent(shipment.id, 'pending', sender_province, `Đơn hàng #${tracking_number} đã được tạo. Đang chờ lấy hàng.`);
    res.status(201).json({ ok: true, shipment });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── Get My Shipments ──
app.get('/api/logistics/shipments', auth, async (req, res) => {
  const { status, limit = 20, page = 1 } = req.query;
  let query = supabase.from('lg_shipments').select('*').eq('user_id', req.user.id);
  if (status) query = query.eq('status', status);
  query = query.order('created_at', { ascending: false }).range((page-1)*limit, page*limit-1);
  const { data } = await query;
  res.json({ shipments: data||[] });
});

// ── Track Shipment (public) ──
app.get('/api/logistics/track/:trackingNumber', async (req, res) => {
  const { data: shipment } = await supabase.from('lg_shipments').select('*').eq('tracking_number', req.params.trackingNumber.toUpperCase()).single();
  if (!shipment) return res.status(404).json({ error: 'Không tìm thấy mã vận đơn' });
  const { data: events } = await supabase.from('lg_tracking_events').select('*').eq('shipment_id', shipment.id).order('created_at', { ascending: true });
  res.json({ shipment, events: events||[] });
});

// ── Get Shipment Detail ──
app.get('/api/logistics/shipments/:id', auth, async (req, res) => {
  const { data: shipment } = await supabase.from('lg_shipments').select('*, lg_drivers(*), lg_warehouses(*)').eq('id', req.params.id).single();
  if (!shipment) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (shipment.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Không có quyền' });
  const { data: events } = await supabase.from('lg_tracking_events').select('*').eq('shipment_id', shipment.id).order('created_at', { ascending: true });
  res.json({ shipment, events: events||[] });
});

// ── Cancel Shipment ──
app.patch('/api/logistics/shipments/:id/cancel', auth, async (req, res) => {
  const { data: shipment } = await supabase.from('lg_shipments').select('user_id,status,tracking_number').eq('id', req.params.id).single();
  if (!shipment || shipment.user_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (!['pending'].includes(shipment.status)) return res.status(400).json({ error: 'Chỉ hủy được đơn đang chờ lấy hàng' });
  await supabase.from('lg_shipments').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', req.params.id);
  await lgAddEvent(req.params.id, 'cancelled', '', 'Đơn hàng đã bị hủy bởi người gửi.');
  res.json({ ok: true });
});

// ── Schedule Pickup ──
app.post('/api/logistics/pickups', auth, async (req, res) => {
  try {
    const { shipment_id, pickup_date, time_slot, pickup_address, contact_name, contact_phone, notes } = req.body;
    if (!pickup_date || !time_slot || !pickup_address) return res.status(400).json({ error: 'Thiếu thông tin lịch lấy hàng' });
    const { data: pickup, error } = await supabase.from('lg_pickups').insert({
      shipment_id: shipment_id||null, user_id: req.user.id,
      pickup_date, time_slot, pickup_address: sanitize(pickup_address),
      contact_name: sanitize(contact_name||''), contact_phone: sanitize(contact_phone||''),
      notes: sanitize(notes||''), status: 'scheduled'
    }).select().single();
    if (error) return res.status(500).json({ error: 'Đặt lịch thất bại' });
    if (shipment_id) {
      await supabase.from('lg_shipments').update({ pickup_date, pickup_time_slot: time_slot }).eq('id', shipment_id);
      await lgAddEvent(shipment_id, 'pending', '', `Đã đặt lịch lấy hàng: ${pickup_date} — ${time_slot}`);
    }
    res.status(201).json({ ok: true, pickup });
  } catch(e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.get('/api/logistics/pickups', auth, async (req, res) => {
  const { data } = await supabase.from('lg_pickups').select('*, lg_shipments(tracking_number)').eq('user_id', req.user.id).order('pickup_date', { ascending: false });
  res.json({ pickups: data||[] });
});

// ── Dashboard Stats ──
app.get('/api/logistics/dashboard', auth, async (req, res) => {
  const [
    { count: total },
    { count: pending },
    { count: in_transit },
    { count: delivered },
    { count: returned }
  ] = await Promise.all([
    supabase.from('lg_shipments').select('*',{count:'exact',head:true}).eq('user_id', req.user.id),
    supabase.from('lg_shipments').select('*',{count:'exact',head:true}).eq('user_id', req.user.id).eq('status','pending'),
    supabase.from('lg_shipments').select('*',{count:'exact',head:true}).eq('user_id', req.user.id).in('status',['picked_up','in_transit','at_warehouse','out_for_delivery']),
    supabase.from('lg_shipments').select('*',{count:'exact',head:true}).eq('user_id', req.user.id).eq('status','delivered'),
    supabase.from('lg_shipments').select('*',{count:'exact',head:true}).eq('user_id', req.user.id).eq('status','returned')
  ]);
  const { data: recent } = await supabase.from('lg_shipments').select('*').eq('user_id', req.user.id).order('created_at',{ascending:false}).limit(5);
  res.json({ stats: { total:total||0, pending:pending||0, in_transit:in_transit||0, delivered:delivered||0, returned:returned||0 }, recent: recent||[] });
});

// ── Admin — Update Tracking Status ──
app.patch('/api/admin/logistics/shipments/:id/status', adminAuth, async (req, res) => {
  const { status, location, description } = req.body;
  const validStatuses = ['pending','picked_up','in_transit','at_warehouse','out_for_delivery','delivered','returned','cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  const updates = { status, updated_at: new Date().toISOString() };
  if (status === 'delivered') updates.delivered_at = new Date().toISOString();
  await supabase.from('lg_shipments').update(updates).eq('id', req.params.id);
  const { data: s } = await supabase.from('lg_shipments').select('tracking_number,sender_province,receiver_province').eq('id', req.params.id).single();
  const loc = location || (status === 'at_warehouse' ? 'Kho trung chuyển' : status === 'delivered' ? s?.receiver_province : s?.sender_province) || '';
  const desc = description || {
    picked_up: 'Đã lấy hàng thành công',
    in_transit: 'Đơn hàng đang trên đường vận chuyển',
    at_warehouse: 'Đơn hàng đã đến kho trung chuyển',
    out_for_delivery: 'Shipper đang trên đường giao hàng',
    delivered: 'Giao hàng thành công',
    returned: 'Hoàn hàng về người gửi',
    cancelled: 'Đơn hàng đã bị hủy'
  }[status] || status;
  await lgAddEvent(req.params.id, status, loc, desc, 'admin');
  res.json({ ok: true });
});

app.patch('/api/admin/logistics/shipments/:id/assign-driver', adminAuth, async (req, res) => {
  const { driver_id } = req.body;
  await supabase.from('lg_shipments').update({ driver_id, updated_at: new Date().toISOString() }).eq('id', req.params.id);
  const { data: d } = await supabase.from('lg_drivers').select('name').eq('id', driver_id).single();
  await lgAddEvent(req.params.id, undefined, '', `Đã phân công tài xế: ${d?.name||''}`, 'admin');
  res.json({ ok: true });
});

app.get('/api/admin/logistics/stats', adminAuth, async (req, res) => {
  const [
    { count: total }, { count: pending }, { count: in_transit },
    { count: delivered }, { count: returned }
  ] = await Promise.all([
    supabase.from('lg_shipments').select('*',{count:'exact',head:true}),
    supabase.from('lg_shipments').select('*',{count:'exact',head:true}).eq('status','pending'),
    supabase.from('lg_shipments').select('*',{count:'exact',head:true}).in('status',['picked_up','in_transit','at_warehouse','out_for_delivery']),
    supabase.from('lg_shipments').select('*',{count:'exact',head:true}).eq('status','delivered'),
    supabase.from('lg_shipments').select('*',{count:'exact',head:true}).eq('status','returned')
  ]);
  const { data: drivers } = await supabase.from('lg_drivers').select('*').eq('status','available');
  res.json({ total:total||0, pending:pending||0, in_transit:in_transit||0, delivered:delivered||0, returned:returned||0, available_drivers: (drivers||[]).length });
});

app.get('/api/admin/logistics/shipments', adminAuth, async (req, res) => {
  const { status, limit = 50, page = 1 } = req.query;
  let q = supabase.from('lg_shipments').select('*, users!user_id(id,name,phone)');
  if (status) q = q.eq('status', status);
  q = q.order('created_at',{ascending:false}).range((page-1)*limit, page*limit-1);
  const { data } = await q;
  res.json({ shipments: data||[] });
});

app.get('/api/admin/logistics/drivers', adminAuth, async (req, res) => {
  const { data } = await supabase.from('lg_drivers').select('*').order('created_at',{ascending:false});
  res.json({ drivers: data||[] });
});

app.post('/api/admin/logistics/drivers', adminAuth, async (req, res) => {
  const { name, phone, vehicle_type, vehicle_plate, province } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Thiếu tên và số điện thoại' });
  const { data, error } = await supabase.from('lg_drivers').insert({ name: sanitize(name), phone: sanitize(phone), vehicle_type: vehicle_type||'motorbike', vehicle_plate: sanitize(vehicle_plate||''), province: sanitize(province||'') }).select().single();
  if (error) return res.status(500).json({ error: 'Thêm tài xế thất bại' });
  res.status(201).json({ ok: true, driver: data });
});

app.get('/api/admin/logistics/warehouses', adminAuth, async (req, res) => {
  const { data } = await supabase.from('lg_warehouses').select('*').eq('is_active', true);
  res.json({ warehouses: data||[] });
});

// ── SERVE logistics.html ──
app.get('/logistics', (req, res) => {
  res.sendFile(join(__dirname, 'frontend', 'logistics.html'));
});

const PORT = process.env.PORT || 5000;
const httpServer = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✓ SafePass chạy tại http://0.0.0.0:${PORT}`);
  await migratePhoneNumbers();
});

// ── WEBSOCKET SERVER (noServer — attaches to existing HTTP server) ──
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  try {
    const user = jwt.verify(token, JWT_SECRET);
    request._wsUser = user;
    if (url.pathname.startsWith('/ws/escrow')) {
      wss2.handleUpgrade(request, socket, head, (wsClient) => {
        wss2.emit('connection', wsClient, request);
      });
    } else if (url.pathname.startsWith('/ws/chat')) {
      wss.handleUpgrade(request, socket, head, (wsClient) => {
        wss.emit('connection', wsClient, request);
      });
    } else {
      socket.destroy();
    }
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
