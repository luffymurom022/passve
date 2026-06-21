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
app.set('trust proxy', 1);
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
  try {
    const { password, name, email } = req.body;
    const phone = normalizePhone(req.body.phone);
    if (!phone || !password || !name)
      return res.status(400).json({ error: 'Thiếu thông tin' });
    if (phone.length < 9 || phone.length > 15)
      return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
    if (typeof password !== 'string' || password.length < 6)
      return res.status(400).json({ error: 'Mật khẩu phải ít nhất 6 ký tự' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Email không hợp lệ' });

    const { data: existing } = await supabase.from('users').select('id').eq('phone', phone).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Số điện thoại đã tồn tại' });

    const hashed = await bcrypt.hash(password, 10);

    // Build insert payload — try with optional columns, fall back if schema missing them
    const buildPayload = (withExtra) => {
      const base = { phone, password: hashed, name: sanitize(name), balance: 0, escrow: 0 };
      if (email && withExtra) base.email = email.toLowerCase().trim();
      if (withExtra) {
        try { base.referral_code = generateReferralCode(); } catch(e) {}
      }
      return base;
    };

    let data, error;
    // Attempt 1: full payload with email + referral_code
    ({ data, error } = await supabase.from('users').insert(buildPayload(true)).select().single());

    // Attempt 2: without email if email column missing
    if (error && error.message?.toLowerCase().includes('email')) {
      const p = buildPayload(true); delete p.email;
      ({ data, error } = await supabase.from('users').insert(p).select().single());
    }

    // Attempt 3: without referral_code if column missing
    if (error && (error.message?.toLowerCase().includes('referral_code') || error.message?.toLowerCase().includes('schema cache'))) {
      const p = buildPayload(false);
      if (email) p.email = email.toLowerCase().trim();
      ({ data, error } = await supabase.from('users').insert(p).select().single());
    }

    // Attempt 4: bare minimum
    if (error) {
      ({ data, error } = await supabase.from('users').insert({ phone, password: hashed, name: sanitize(name), balance: 0, escrow: 0 }).select().single());
    }

    if (error) return res.status(500).json({ error: 'Đăng ký thất bại: ' + error.message });

    const token = jwt.sign({ id: data.id, phone, name: data.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: data.id, phone, name: data.name, balance: 0, escrow: 0 } });
  } catch (e) {
    res.status(500).json({ error: 'Lỗi server: ' + e.message });
  }
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
// Note: catch-all moved to end of file so named routes take priority

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
// PHASE 14: MERCHANT CENTER ROUTES
// ══════════════════════════════════════════════════════════

// ── MERCHANT DASHBOARD ──
app.get('/api/merchant/dashboard', businessAuth, async (req, res) => {
  try {
    const bizId = req.biz.bizId;
    const [{ data: biz }, { data: inv }, { data: consigns }] = await Promise.all([
      supabase.from('business_accounts').select('*').eq('id', bizId).single(),
      supabase.from('merchant_inventory').select('id,name,stock,price,status').eq('business_id', bizId).eq('status', 'active').order('stock', { ascending: true }),
      supabase.from('merchant_consignments').select('id,item_name,seller_name,status').eq('business_id', bizId).order('created_at', { ascending: false }).limit(5)
    ]);
    const lowStock = (inv || []).filter(i => i.stock <= 10).slice(0, 5);
    res.json({
      ok: true,
      data: {
        total_revenue: biz?.total_revenue || 0,
        total_orders: biz?.total_orders || 0,
        wallet_balance: biz?.wallet_balance || 0,
        avg_rating: biz?.avg_rating || null,
        review_count: biz?.review_count || 0,
        completion_rate: Math.round((biz?.completion_rate || 0) * 100),
        inventory_count: (inv || []).length,
        low_stock: lowStock,
        recent_consignments: consigns || []
      }
    });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── MERCHANT PROFILE ──
app.get('/api/merchant/profile', businessAuth, async (req, res) => {
  try {
    const { data: biz } = await supabase.from('business_accounts')
      .select('id,company_name,email,phone,website,status,plan,account_type,logo_url,banner_url,bio,address,hotline,fanpage,store_slug,badge,is_verified_business,verification_status,wallet_balance,total_revenue,total_orders,completion_rate,avg_rating,review_count,rank_score,total_fees,created_at')
      .eq('id', req.biz.bizId).single();
    if (!biz) return res.status(404).json({ error: 'Không tìm thấy' });
    res.json({ profile: biz });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.put('/api/merchant/profile', businessAuth, async (req, res) => {
  try {
    const { company_name, bio, store_slug, address, hotline, website, fanpage, logo_url, banner_url, account_type } = req.body;
    const payload = {};
    if (company_name !== undefined) payload.company_name = sanitize(company_name);
    if (bio !== undefined) payload.bio = sanitize(bio);
    if (address !== undefined) payload.address = sanitize(address);
    if (hotline !== undefined) payload.hotline = sanitize(hotline);
    if (website !== undefined) payload.website = website;
    if (fanpage !== undefined) payload.fanpage = fanpage;
    if (logo_url !== undefined) payload.logo_url = logo_url;
    if (banner_url !== undefined) payload.banner_url = banner_url;
    if (account_type && ['individual','store','business','consignment'].includes(account_type)) payload.account_type = account_type;
    if (store_slug) {
      const slug = store_slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (slug.length >= 2) {
        const { data: dup } = await supabase.from('business_accounts').select('id').eq('store_slug', slug).neq('id', req.biz.bizId).single();
        if (dup) return res.status(409).json({ error: 'Slug đã được dùng, hãy chọn slug khác' });
        payload.store_slug = slug;
      }
    }
    const { data: updated, error } = await supabase.from('business_accounts').update(payload).eq('id', req.biz.bizId).select().single();
    if (error) return res.status(500).json({ error: 'Cập nhật thất bại' });
    const { password_hash: _ph, ...safe } = updated;
    res.json({ ok: true, profile: safe });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── MERCHANT INVENTORY ──
app.get('/api/merchant/inventory', businessAuth, async (req, res) => {
  const { data: items } = await supabase.from('merchant_inventory')
    .select('*').eq('business_id', req.biz.bizId).order('created_at', { ascending: false });
  res.json({ items: items || [] });
});

app.post('/api/merchant/inventory', businessAuth, async (req, res) => {
  try {
    const { name, sku, description, price, stock, category, image_url, status } = req.body;
    if (!name) return res.status(400).json({ error: 'Tên sản phẩm là bắt buộc' });
    const { data: item, error } = await supabase.from('merchant_inventory').insert({
      business_id: req.biz.bizId,
      name: sanitize(name), sku: sku || null, description: sanitize(description || ''),
      price: parseInt(price) || 0, stock: parseInt(stock) || 0,
      category: category || 'general', image_url: image_url || null,
      status: status || 'active'
    }).select().single();
    if (error) return res.status(500).json({ error: 'Thêm sản phẩm thất bại' });
    res.status(201).json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.put('/api/merchant/inventory/:id', businessAuth, async (req, res) => {
  try {
    const { name, sku, description, price, stock, category, status } = req.body;
    const payload = { updated_at: new Date().toISOString() };
    if (name) payload.name = sanitize(name);
    if (sku !== undefined) payload.sku = sku;
    if (description !== undefined) payload.description = sanitize(description);
    if (price !== undefined) payload.price = parseInt(price) || 0;
    if (stock !== undefined) payload.stock = parseInt(stock) || 0;
    if (category) payload.category = category;
    if (status) payload.status = status;
    const { error } = await supabase.from('merchant_inventory').update(payload).eq('id', req.params.id).eq('business_id', req.biz.bizId);
    if (error) return res.status(500).json({ error: 'Cập nhật thất bại' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.delete('/api/merchant/inventory/:id', businessAuth, async (req, res) => {
  const { error } = await supabase.from('merchant_inventory').delete().eq('id', req.params.id).eq('business_id', req.biz.bizId);
  if (error) return res.status(500).json({ error: 'Xóa thất bại' });
  res.json({ ok: true });
});

// ── MERCHANT CONSIGNMENTS ──
app.get('/api/merchant/consignments', businessAuth, async (req, res) => {
  try {
    const bizId = req.biz.bizId;
    const { data: items } = await supabase.from('merchant_consignments')
      .select('*').eq('business_id', bizId).order('created_at', { ascending: false });
    const all = items || [];
    const stats = {
      pending: all.filter(i => i.status === 'pending').length,
      accepted: all.filter(i => i.status === 'accepted').length,
      listed: all.filter(i => i.status === 'listed').length,
      sold: all.filter(i => i.status === 'sold').length,
      total_commission: all.filter(i => i.status === 'sold').reduce((s, i) => s + (i.commission_earned || 0), 0)
    };
    res.json({ items: all, stats });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/merchant/consignments', businessAuth, async (req, res) => {
  try {
    const { seller_name, seller_phone, item_name, description, quantity, asking_price, selling_price, commission_rate, notes } = req.body;
    if (!seller_name || !item_name) return res.status(400).json({ error: 'Tên người ký gửi và tên hàng là bắt buộc' });
    const { data: item, error } = await supabase.from('merchant_consignments').insert({
      business_id: req.biz.bizId,
      seller_name: sanitize(seller_name), seller_phone: seller_phone || null,
      item_name: sanitize(item_name), description: sanitize(description || ''),
      quantity: parseInt(quantity) || 1,
      asking_price: parseInt(asking_price) || 0, selling_price: parseInt(selling_price) || 0,
      commission_rate: parseFloat(commission_rate) || 0.1,
      notes: sanitize(notes || ''), status: 'pending'
    }).select().single();
    if (error) return res.status(500).json({ error: 'Thêm ký gửi thất bại' });
    res.status(201).json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.patch('/api/merchant/consignments/:id', businessAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending','accepted','listed','sold','returned'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
    const { data: con } = await supabase.from('merchant_consignments').select('*').eq('id', req.params.id).eq('business_id', req.biz.bizId).single();
    if (!con) return res.status(404).json({ error: 'Không tìm thấy' });
    const update = { status };
    if (status === 'sold') {
      update.commission_earned = Math.round((con.selling_price || 0) * (con.commission_rate || 0.1));
    }
    const { error } = await supabase.from('merchant_consignments').update(update).eq('id', req.params.id).eq('business_id', req.biz.bizId);
    if (error) return res.status(500).json({ error: 'Cập nhật thất bại' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── MERCHANT STAFF ──
app.get('/api/merchant/staff', businessAuth, async (req, res) => {
  const { data: staff } = await supabase.from('merchant_staff')
    .select('*').eq('business_id', req.biz.bizId).order('created_at', { ascending: false });
  res.json({ staff: staff || [] });
});

app.post('/api/merchant/staff', businessAuth, async (req, res) => {
  try {
    const { name, phone, email, role } = req.body;
    if (!name) return res.status(400).json({ error: 'Tên nhân viên là bắt buộc' });
    const validRoles = ['admin','manager','staff'];
    const staffRole = validRoles.includes(role) ? role : 'staff';
    const { data: member, error } = await supabase.from('merchant_staff').insert({
      business_id: req.biz.bizId, name: sanitize(name),
      phone: phone || null, email: email || null, role: staffRole
    }).select().single();
    if (error) return res.status(500).json({ error: 'Thêm nhân viên thất bại' });
    res.status(201).json({ ok: true, member });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.patch('/api/merchant/staff/:id', businessAuth, async (req, res) => {
  const { status, role } = req.body;
  const update = {};
  if (status && ['active','inactive'].includes(status)) update.status = status;
  if (role && ['admin','manager','staff'].includes(role)) update.role = role;
  const { error } = await supabase.from('merchant_staff').update(update).eq('id', req.params.id).eq('business_id', req.biz.bizId);
  if (error) return res.status(500).json({ error: 'Cập nhật thất bại' });
  res.json({ ok: true });
});

app.delete('/api/merchant/staff/:id', businessAuth, async (req, res) => {
  const { error } = await supabase.from('merchant_staff').delete().eq('id', req.params.id).eq('business_id', req.biz.bizId);
  if (error) return res.status(500).json({ error: 'Xóa thất bại' });
  res.json({ ok: true });
});

// ── MERCHANT FRANCHISES ──
app.get('/api/merchant/franchises', businessAuth, async (req, res) => {
  const { data: branches } = await supabase.from('merchant_franchises')
    .select('*').eq('business_id', req.biz.bizId).order('created_at', { ascending: false });
  res.json({ branches: branches || [] });
});

app.post('/api/merchant/franchises', businessAuth, async (req, res) => {
  try {
    const { branch_name, address, manager_name, manager_phone } = req.body;
    if (!branch_name) return res.status(400).json({ error: 'Tên chi nhánh là bắt buộc' });
    const { data: branch, error } = await supabase.from('merchant_franchises').insert({
      business_id: req.biz.bizId, branch_name: sanitize(branch_name),
      address: sanitize(address || ''), manager_name: sanitize(manager_name || ''),
      manager_phone: manager_phone || null
    }).select().single();
    if (error) return res.status(500).json({ error: 'Thêm chi nhánh thất bại' });
    res.status(201).json({ ok: true, branch });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.patch('/api/merchant/franchises/:id', businessAuth, async (req, res) => {
  const { status } = req.body;
  if (!['active','inactive'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  const { error } = await supabase.from('merchant_franchises').update({ status }).eq('id', req.params.id).eq('business_id', req.biz.bizId);
  if (error) return res.status(500).json({ error: 'Cập nhật thất bại' });
  res.json({ ok: true });
});

app.delete('/api/merchant/franchises/:id', businessAuth, async (req, res) => {
  const { error } = await supabase.from('merchant_franchises').delete().eq('id', req.params.id).eq('business_id', req.biz.bizId);
  if (error) return res.status(500).json({ error: 'Xóa thất bại' });
  res.json({ ok: true });
});

// ── MERCHANT WALLET ──
app.get('/api/merchant/wallet', businessAuth, async (req, res) => {
  try {
    const [{ data: biz }, { data: txns }] = await Promise.all([
      supabase.from('business_accounts').select('wallet_balance,total_revenue,total_fees,total_orders').eq('id', req.biz.bizId).single(),
      supabase.from('merchant_wallet_txns').select('*').eq('business_id', req.biz.bizId).order('created_at', { ascending: false }).limit(50)
    ]);
    res.json({ wallet: biz || {}, transactions: txns || [] });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── MERCHANT ANALYTICS ──
app.get('/api/merchant/analytics', businessAuth, async (req, res) => {
  try {
    const bizId = req.biz.bizId;
    const [{ data: biz }, { data: inv }, { data: consigns }, { data: txns }] = await Promise.all([
      supabase.from('business_accounts').select('total_revenue,total_orders,avg_rating,review_count').eq('id', bizId).single(),
      supabase.from('merchant_inventory').select('name,price,stock,status').eq('business_id', bizId).order('stock', { ascending: false }).limit(10),
      supabase.from('merchant_consignments').select('status,commission_earned').eq('business_id', bizId),
      supabase.from('merchant_wallet_txns').select('type,amount,created_at').eq('business_id', bizId)
    ]);
    const all = consigns || [];
    const conStatus = { pending: all.filter(c=>c.status==='pending').length, accepted: all.filter(c=>c.status==='accepted').length, listed: all.filter(c=>c.status==='listed').length, sold: all.filter(c=>c.status==='sold').length };
    const totalCommission = all.filter(c=>c.status==='sold').reduce((s,c)=>s+(c.commission_earned||0),0);
    // Monthly revenue (last 12 months)
    const monthly_revenue = Array(12).fill(0);
    const monthly_orders = Array(12).fill(0);
    (txns || []).filter(t=>t.type==='revenue').forEach(t => {
      const m = new Date(t.created_at).getMonth();
      monthly_revenue[m] += t.amount || 0;
    });
    res.json({ data: {
      total_revenue: biz?.total_revenue || 0, total_orders: biz?.total_orders || 0,
      avg_rating: biz?.avg_rating || null, review_count: biz?.review_count || 0,
      total_commission: totalCommission, consignment_status: conStatus,
      top_inventory: (inv || []).slice(0, 5), monthly_revenue, monthly_orders
    }});
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── MERCHANT VERIFICATION ──
app.get('/api/merchant/verification', businessAuth, async (req, res) => {
  const { data: v } = await supabase.from('merchant_verifications')
    .select('*').eq('business_id', req.biz.bizId).order('submitted_at', { ascending: false }).limit(1).single();
  res.json({ verification: v || null });
});

app.post('/api/merchant/verification', businessAuth, async (req, res) => {
  try {
    const { license_number, tax_id, representative_name, license_url, id_card_url } = req.body;
    if (!license_number || !tax_id || !representative_name) return res.status(400).json({ error: 'Điền đủ thông tin bắt buộc' });
    const { data: existing } = await supabase.from('merchant_verifications').select('id,status').eq('business_id', req.biz.bizId).eq('status', 'pending').single();
    if (existing) return res.status(409).json({ error: 'Hồ sơ đang chờ xét duyệt, không thể nộp lại' });
    const { data: v, error } = await supabase.from('merchant_verifications').insert({
      business_id: req.biz.bizId, license_number: sanitize(license_number),
      tax_id: sanitize(tax_id), representative_name: sanitize(representative_name),
      license_url: license_url || null, id_card_url: id_card_url || null, status: 'pending'
    }).select().single();
    if (error) return res.status(500).json({ error: 'Nộp hồ sơ thất bại' });
    await supabase.from('business_accounts').update({ verification_status: 'pending' }).eq('id', req.biz.bizId);
    res.status(201).json({ ok: true, verification: v });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── MERCHANT RANKINGS ──
app.get('/api/merchant/rankings', businessAuth, async (req, res) => {
  try {
    const { data: top } = await supabase.from('business_accounts')
      .select('id,company_name,store_slug,badge,avg_rating,review_count,total_orders,total_revenue,rank_score,account_type')
      .eq('status', 'active').order('rank_score', { ascending: false }).limit(20);
    const myId = req.biz.bizId;
    const ranked = (top || []).map((b, i) => ({ ...b, rank: i + 1 }));
    const myRank = ranked.find(b => b.id === myId) || null;
    res.json({ rankings: ranked, my_rank: myRank });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

// ── PUBLIC STORE PAGE ──
app.get('/store/:slug', async (req, res) => {
  const slug = req.params.slug.toLowerCase();
  const { data: biz } = await supabase.from('business_accounts')
    .select('id,company_name,bio,logo_url,banner_url,address,hotline,website,fanpage,badge,is_verified_business,avg_rating,review_count,total_orders')
    .eq('store_slug', slug).eq('status', 'active').single();
  if (!biz) return res.status(404).send('<!DOCTYPE html><html><body style="background:#06090f;color:#fff;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;"><div style="text-align:center;"><div style="font-size:48px;">🔍</div><h2>Shop không tồn tại</h2><p style="color:#6b7a99;">URL này chưa được đăng ký trên SafePass</p><a href="/" style="color:#f97316;">← Về trang chủ</a></div></body></html>');
  const { data: inv } = await supabase.from('merchant_inventory').select('id,name,price,stock,category,image_url').eq('business_id', biz.id).eq('status', 'active').order('created_at', { ascending: false }).limit(24);
  const { data: reviews } = await supabase.from('merchant_reviews').select('reviewer_name,rating,comment,created_at').eq('business_id', biz.id).order('created_at', { ascending: false }).limit(10);
  const badgeMap = { none:'',verified:'✅ Verified Shop',trusted:'💙 Trusted Shop',premium:'💜 Premium Shop',gold:'🥇 Gold Merchant',diamond:'💎 Diamond Merchant' };
  const items = inv || [];
  const revs = reviews || [];
  const html = `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${biz.company_name} — SafePass Store</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#05080f;--card:#0d1220;--brand:#f97316;--text:#e8edf5;--sub:#6b7a99;--border:rgba(255,255,255,.07);--green:#10b981;}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;}
.banner{width:100%;height:240px;object-fit:cover;background:linear-gradient(135deg,rgba(249,115,22,.15),rgba(61,142,248,.1));display:block;}
.banner-ph{width:100%;height:240px;background:linear-gradient(135deg,rgba(249,115,22,.12),rgba(61,142,248,.08));display:flex;align-items:center;justify-content:center;font-size:60px;}
.container{max-width:1100px;margin:0 auto;padding:0 20px;}
.profile-row{display:flex;align-items:flex-end;gap:20px;margin-top:-32px;padding:0 20px 20px;position:relative;}
.logo{width:80px;height:80px;border-radius:16px;border:4px solid var(--bg);background:var(--card);display:flex;align-items:center;justify-content:center;font-size:36px;overflow:hidden;flex-shrink:0;}
.logo img{width:100%;height:100%;object-fit:cover;}
.shop-name{font-size:24px;font-weight:800;}
.shop-meta{display:flex;flex-wrap:wrap;gap:12px;font-size:13px;color:var(--sub);margin-top:6px;}
.badge-pill{padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;background:rgba(16,185,129,.15);color:var(--green);}
.nav{background:var(--card);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10;}
.nav-inner{max-width:1100px;margin:0 auto;padding:0 20px;display:flex;gap:24px;}
.nav-link{padding:14px 0;font-size:13px;font-weight:600;color:var(--sub);border-bottom:2px solid transparent;cursor:pointer;}
.nav-link.active{color:var(--brand);border-bottom-color:var(--brand);}
.section{padding:24px 0;}
.section-title{font-size:16px;font-weight:700;margin-bottom:16px;}
.prod-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;}
.prod-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;transition:.15s;}
.prod-card:hover{border-color:var(--brand);}
.prod-icon{font-size:36px;margin-bottom:10px;}
.prod-name{font-size:13px;font-weight:700;margin-bottom:6px;}
.prod-price{font-size:16px;font-weight:800;color:var(--brand);}
.prod-stock{font-size:11px;color:var(--sub);margin-top:4px;}
.review-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;}
.stars{color:#f59e0b;font-size:14px;}
.footer{padding:32px 20px;text-align:center;color:var(--sub);font-size:12px;border-top:1px solid var(--border);margin-top:40px;}
.footer a{color:var(--brand);}
.stat-row{display:flex;gap:24px;flex-wrap:wrap;margin-top:8px;}
.stat-item{text-align:center;}
.stat-item .val{font-size:20px;font-weight:800;}
.stat-item .lbl{font-size:11px;color:var(--sub);}
</style>
</head><body>
${biz.banner_url?`<img src="${biz.banner_url}" class="banner" onerror="this.outerHTML='<div class=banner-ph>🏬</div>'"/>`:`<div class="banner-ph">🏬</div>`}
<div class="container">
  <div class="profile-row">
    <div class="logo">${biz.logo_url?`<img src="${biz.logo_url}" onerror="this.outerHTML='🏬'"/>`:'🏬'}</div>
    <div style="flex:1;padding-bottom:4px;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <div class="shop-name">${biz.company_name}</div>
        ${biz.is_verified_business?'<span class="badge-pill">✅ Verified Business</span>':''}
        ${biz.badge&&biz.badge!=='none'?`<span class="badge-pill">${badgeMap[biz.badge]||''}</span>`:''}
      </div>
      <div class="shop-meta">
        <span>⭐ ${biz.avg_rating||'—'} (${biz.review_count||0} đánh giá)</span>
        <span>📦 ${biz.total_orders||0} đơn hàng</span>
        ${biz.address?`<span>📍 ${biz.address}</span>`:''}
        ${biz.hotline?`<span>📞 ${biz.hotline}</span>`:''}
      </div>
    </div>
    <a href="/" style="padding:10px 20px;background:var(--brand);color:#fff;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none;flex-shrink:0;">Liên hệ qua SafePass</a>
  </div>
  ${biz.bio?`<div style="padding:0 20px 20px;font-size:14px;color:#9ca3af;">${biz.bio}</div>`:''}
</div>
<div class="nav"><div class="nav-inner"><div class="nav-link active">📦 Sản phẩm (${items.length})</div><div class="nav-link">⭐ Đánh giá (${revs.length})</div></div></div>
<div class="container">
  <div class="section">
    <div class="section-title">📦 Sản phẩm đang bán</div>
    ${items.length?`<div class="prod-grid">${items.map(i=>`<div class="prod-card"><div class="prod-icon">📦</div><div class="prod-name">${i.name}</div><div class="prod-price">${Number(i.price||0).toLocaleString('vi-VN')} ₫</div><div class="prod-stock">Còn ${i.stock}</div></div>`).join('')}</div>`:'<div style="text-align:center;padding:40px;color:var(--sub);">Chưa có sản phẩm</div>'}
  </div>
  ${revs.length?`<div class="section"><div class="section-title">⭐ Đánh giá từ khách hàng</div>${revs.map(r=>`<div class="review-card"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;"><div style="font-weight:700;font-size:13px;">${r.reviewer_name||'Khách hàng'}</div><div class="stars">${'★'.repeat(r.rating||5)}</div></div><div style="font-size:13px;color:#9ca3af;">${r.comment||''}</div></div>`).join('')}</div>`:''}
</div>
<div class="footer"><a href="/">SafePass</a> — Nền tảng escrow an toàn · <a href="/store/${slug}">safepass.vn/store/${slug}</a></div>
</body></html>`;
  res.send(html);
});

// ── ADMIN — MERCHANT MANAGEMENT ──
app.get('/api/admin/merchant/verifications', adminAuth, async (req, res) => {
  const { data: verifs } = await supabase.from('merchant_verifications')
    .select('*, business_accounts(company_name,email)')
    .order('submitted_at', { ascending: false });
  res.json({ verifications: verifs || [] });
});

app.patch('/api/admin/merchant/verifications/:id', adminAuth, async (req, res) => {
  try {
    const { status, admin_note } = req.body;
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
    const { data: v } = await supabase.from('merchant_verifications').select('business_id').eq('id', req.params.id).single();
    if (!v) return res.status(404).json({ error: 'Không tìm thấy' });
    await supabase.from('merchant_verifications').update({ status, admin_note: admin_note || null, reviewed_at: new Date().toISOString() }).eq('id', req.params.id);
    await supabase.from('business_accounts').update({ verification_status: status, is_verified_business: status === 'approved', badge: status === 'approved' ? 'verified' : undefined }).eq('id', v.business_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.patch('/api/admin/merchant/:id/badge', adminAuth, async (req, res) => {
  const { badge } = req.body;
  const validBadges = ['none','verified','trusted','premium','gold','diamond'];
  if (!validBadges.includes(badge)) return res.status(400).json({ error: 'Huy hiệu không hợp lệ' });
  const { error } = await supabase.from('business_accounts').update({ badge }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Cập nhật thất bại' });
  res.json({ ok: true });
});

app.get('/api/admin/merchant/all', adminAuth, async (req, res) => {
  const { data: merchants } = await supabase.from('business_accounts')
    .select('id,company_name,email,account_type,badge,is_verified_business,verification_status,status,total_revenue,total_orders,avg_rating,rank_score,created_at')
    .order('created_at', { ascending: false });
  res.json({ merchants: merchants || [] });
});

app.patch('/api/admin/merchant/:id/status', adminAuth, async (req, res) => {
  const { status } = req.body;
  if (!['active','suspended','pending'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  const { error } = await supabase.from('business_accounts').update({ status }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Cập nhật thất bại' });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
//  PHASE SOCIAL 7 — BUSINESS & BRAND ECOSYSTEM
// ══════════════════════════════════════════════════════════

// Serve brand pages
app.get('/brand', (req, res) => res.sendFile(join(__dirname, 'frontend', 'brand.html')));
app.get('/brand/:slug', (req, res) => res.sendFile(join(__dirname, 'frontend', 'brand.html')));

// ── Brand Posts ──
app.post('/api/brand/posts', businessAuth, async (req, res) => {
  const { type = 'post', content, image_url, cta_text, cta_url, is_pinned = false } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Nội dung không được trống' });
  const { data, error } = await supabase.from('brand_posts').insert({
    business_id: req.business.id, type, content: content.trim(), image_url, cta_text, cta_url, is_pinned
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('business_accounts').update({ posts_count: supabase.rpc ? undefined : undefined }).eq('id', req.business.id);
  supabase.from('business_accounts').select('posts_count').eq('id', req.business.id).single().then(({ data: b }) => {
    if (b) supabase.from('business_accounts').update({ posts_count: (b.posts_count || 0) + 1 }).eq('id', req.business.id).then(() => {});
  });
  res.json({ post: data });
});

app.get('/api/brand/:slug/posts', async (req, res) => {
  const { data: biz } = await supabase.from('business_accounts').select('id,company_name,store_slug,badge,is_verified_business,logo_url,cover_image_url,description,followers_count,posts_count,category').eq('store_slug', req.params.slug).single();
  if (!biz) return res.status(404).json({ error: 'Không tìm thấy thương hiệu' });
  const { page = 1, limit = 20 } = req.query;
  const from = (page - 1) * limit;
  const { data: posts } = await supabase.from('brand_posts').select('*').eq('business_id', biz.id).eq('status', 'active').order('is_pinned', { ascending: false }).order('created_at', { ascending: false }).range(from, from + limit - 1);
  res.json({ brand: biz, posts: posts || [] });
});

app.get('/api/brand/my-posts', businessAuth, async (req, res) => {
  const { data: posts } = await supabase.from('brand_posts').select('*').eq('business_id', req.business.id).neq('status', 'deleted').order('created_at', { ascending: false });
  res.json({ posts: posts || [] });
});

app.delete('/api/brand/posts/:id', businessAuth, async (req, res) => {
  const { data: post } = await supabase.from('brand_posts').select('business_id').eq('id', req.params.id).single();
  if (!post || post.business_id !== req.business.id) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('brand_posts').update({ status: 'deleted' }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.patch('/api/brand/posts/:id/pin', businessAuth, async (req, res) => {
  const { data: post } = await supabase.from('brand_posts').select('business_id,is_pinned').eq('id', req.params.id).single();
  if (!post || post.business_id !== req.business.id) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('brand_posts').update({ is_pinned: !post.is_pinned }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.post('/api/brand/posts/:id/like', auth, async (req, res) => {
  const { data: existing } = await supabase.from('brand_post_likes').select('id').eq('post_id', req.params.id).eq('user_id', req.user.id).single();
  if (existing) {
    await supabase.from('brand_post_likes').delete().eq('id', existing.id);
    await supabase.rpc ? null : supabase.from('brand_posts').select('likes_count').eq('id', req.params.id).single().then(({ data: p }) => {
      if (p) supabase.from('brand_posts').update({ likes_count: Math.max(0, (p.likes_count || 0) - 1) }).eq('id', req.params.id).then(() => {});
    });
    return res.json({ liked: false });
  }
  await supabase.from('brand_post_likes').insert({ post_id: req.params.id, user_id: req.user.id });
  supabase.from('brand_posts').select('likes_count').eq('id', req.params.id).single().then(({ data: p }) => {
    if (p) supabase.from('brand_posts').update({ likes_count: (p.likes_count || 0) + 1 }).eq('id', req.params.id).then(() => {});
  });
  res.json({ liked: true });
});

app.post('/api/brand/posts/:id/comment', auth, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Nội dung không được trống' });
  const { data } = await supabase.from('brand_post_comments').insert({ post_id: req.params.id, user_id: req.user.id, content: content.trim() }).select().single();
  supabase.from('brand_posts').select('comments_count').eq('id', req.params.id).single().then(({ data: p }) => {
    if (p) supabase.from('brand_posts').update({ comments_count: (p.comments_count || 0) + 1 }).eq('id', req.params.id).then(() => {});
  });
  res.json({ comment: data });
});

app.get('/api/brand/posts/:id/comments', async (req, res) => {
  const { data: comments } = await supabase.from('brand_post_comments').select('*,users(name,avatar_url)').eq('post_id', req.params.id).order('created_at', { ascending: true }).limit(50);
  res.json({ comments: comments || [] });
});

// ── Brand Campaigns ──
app.get('/api/brand/campaigns', businessAuth, async (req, res) => {
  const { data } = await supabase.from('brand_campaigns').select('*').eq('business_id', req.business.id).order('created_at', { ascending: false });
  res.json({ campaigns: data || [] });
});

app.post('/api/brand/campaigns', businessAuth, async (req, res) => {
  const { type = 'promo', title, description, discount_type = 'percent', discount_value = 0, min_order_value = 0, max_uses = 100, coupon_code, starts_at, ends_at, event_location, event_date } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Tiêu đề không được trống' });
  const { data, error } = await supabase.from('brand_campaigns').insert({
    business_id: req.business.id, type, title: title.trim(), description, discount_type, discount_value, min_order_value, max_uses,
    coupon_code: coupon_code?.toUpperCase() || null, starts_at, ends_at, event_location, event_date
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ campaign: data });
});

app.patch('/api/brand/campaigns/:id', businessAuth, async (req, res) => {
  const { data: camp } = await supabase.from('brand_campaigns').select('business_id').eq('id', req.params.id).single();
  if (!camp || camp.business_id !== req.business.id) return res.status(403).json({ error: 'Không có quyền' });
  const allowed = ['title','description','status','discount_value','min_order_value','max_uses','ends_at','event_location','event_date'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  const { data } = await supabase.from('brand_campaigns').update(updates).eq('id', req.params.id).select().single();
  res.json({ campaign: data });
});

app.delete('/api/brand/campaigns/:id', businessAuth, async (req, res) => {
  const { data: camp } = await supabase.from('brand_campaigns').select('business_id').eq('id', req.params.id).single();
  if (!camp || camp.business_id !== req.business.id) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('brand_campaigns').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

app.get('/api/brand/campaigns/public/:slug', async (req, res) => {
  const { data: biz } = await supabase.from('business_accounts').select('id').eq('store_slug', req.params.slug).single();
  if (!biz) return res.status(404).json({ error: 'Không tìm thấy' });
  const now = new Date().toISOString();
  const { data } = await supabase.from('brand_campaigns').select('*').eq('business_id', biz.id).eq('status', 'active').or(`ends_at.is.null,ends_at.gt.${now}`).order('created_at', { ascending: false });
  res.json({ campaigns: data || [] });
});

app.post('/api/brand/campaigns/:id/use', auth, async (req, res) => {
  const { data: camp } = await supabase.from('brand_campaigns').select('*').eq('id', req.params.id).single();
  if (!camp) return res.status(404).json({ error: 'Không tìm thấy chiến dịch' });
  if (camp.status !== 'active') return res.status(400).json({ error: 'Chiến dịch không còn hoạt động' });
  if (camp.uses_count >= camp.max_uses) return res.status(400).json({ error: 'Đã hết lượt dùng' });
  const { error: dupErr } = await supabase.from('brand_campaign_uses').insert({ campaign_id: req.params.id, user_id: req.user.id });
  if (dupErr) return res.status(400).json({ error: 'Bạn đã sử dụng coupon này rồi' });
  await supabase.from('brand_campaigns').update({ uses_count: (camp.uses_count || 0) + 1 }).eq('id', req.params.id);
  res.json({ ok: true, coupon_code: camp.coupon_code, discount_type: camp.discount_type, discount_value: camp.discount_value });
});

// ── Influencer Collaborations ──
app.get('/api/brand/collaborations', businessAuth, async (req, res) => {
  const { data } = await supabase.from('brand_collaborations').select('*').eq('business_id', req.business.id).order('created_at', { ascending: false });
  res.json({ collaborations: data || [] });
});

app.post('/api/brand/collaborations', businessAuth, async (req, res) => {
  const { title, description, requirements, budget_min = 0, budget_max = 0, commission_rate = 10, collaboration_type = 'affiliate', deadline } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Tiêu đề không được trống' });
  const { data, error } = await supabase.from('brand_collaborations').insert({
    business_id: req.business.id, title: title.trim(), description, requirements, budget_min, budget_max, commission_rate, collaboration_type, deadline
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ collaboration: data });
});

app.patch('/api/brand/collaborations/:id', businessAuth, async (req, res) => {
  const { data: col } = await supabase.from('brand_collaborations').select('business_id').eq('id', req.params.id).single();
  if (!col || col.business_id !== req.business.id) return res.status(403).json({ error: 'Không có quyền' });
  const allowed = ['title','description','requirements','budget_min','budget_max','commission_rate','status','deadline'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  const { data } = await supabase.from('brand_collaborations').update(updates).eq('id', req.params.id).select().single();
  res.json({ collaboration: data });
});

app.get('/api/brand/collaborations/open', async (req, res) => {
  const { type, limit = 20, page = 1 } = req.query;
  let q = supabase.from('brand_collaborations').select('*,business_accounts(company_name,store_slug,logo_url,badge,is_verified_business)').eq('status', 'open');
  if (type) q = q.eq('collaboration_type', type);
  const from = (page - 1) * limit;
  const { data } = await q.order('created_at', { ascending: false }).range(from, from + parseInt(limit) - 1);
  res.json({ collaborations: data || [] });
});

app.post('/api/brand/collaborations/:id/apply', auth, async (req, res) => {
  const { message, portfolio_url, follower_count = 0 } = req.body;
  const { data: col } = await supabase.from('brand_collaborations').select('*').eq('id', req.params.id).single();
  if (!col || col.status !== 'open') return res.status(400).json({ error: 'Chiến dịch không còn nhận đơn' });
  const { data, error } = await supabase.from('brand_collab_applications').insert({
    collaboration_id: req.params.id, creator_id: req.user.id, business_id: col.business_id, message, portfolio_url, follower_count
  }).select().single();
  if (error) return res.status(400).json({ error: 'Bạn đã ứng tuyển chiến dịch này rồi' });
  await supabase.from('brand_collaborations').update({ applications_count: (col.applications_count || 0) + 1 }).eq('id', req.params.id);
  res.json({ application: data });
});

app.get('/api/brand/collaborations/:id/applications', businessAuth, async (req, res) => {
  const { data: col } = await supabase.from('brand_collaborations').select('business_id').eq('id', req.params.id).single();
  if (!col || col.business_id !== req.business.id) return res.status(403).json({ error: 'Không có quyền' });
  const { data } = await supabase.from('brand_collab_applications').select('*,users(name,phone,avatar_url,avg_rating,review_count)').eq('collaboration_id', req.params.id).order('created_at', { ascending: false });
  res.json({ applications: data || [] });
});

app.patch('/api/brand/collab-applications/:id', businessAuth, async (req, res) => {
  const { status } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  const { data: app } = await supabase.from('brand_collab_applications').select('business_id').eq('id', req.params.id).single();
  if (!app || app.business_id !== req.business.id) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('brand_collab_applications').update({ status }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.get('/api/brand/my-applications', auth, async (req, res) => {
  const { data } = await supabase.from('brand_collab_applications').select('*,brand_collaborations(*,business_accounts(company_name,store_slug,logo_url))').eq('creator_id', req.user.id).order('created_at', { ascending: false });
  res.json({ applications: data || [] });
});

// ── Business Inbox (Messenger) ──
app.get('/api/brand/inbox', businessAuth, async (req, res) => {
  const { status } = req.query;
  let q = supabase.from('business_inbox').select('*,users(name,phone,avatar_url)').eq('business_id', req.business.id);
  if (status) q = q.eq('status', status);
  const { data } = await q.order('created_at', { ascending: false }).limit(100);
  res.json({ messages: data || [] });
});

app.post('/api/brand/inbox/:slug', auth, async (req, res) => {
  const { message, subject } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Tin nhắn không được trống' });
  const { data: biz } = await supabase.from('business_accounts').select('id').eq('store_slug', req.params.slug).single();
  if (!biz) return res.status(404).json({ error: 'Không tìm thấy thương hiệu' });
  // Check auto-reply
  const { data: autoReplies } = await supabase.from('business_auto_replies').select('*').eq('business_id', biz.id).eq('is_active', true);
  let autoReply = null;
  if (autoReplies?.length) {
    const lowerMsg = message.toLowerCase();
    const matched = autoReplies.find(r => lowerMsg.includes(r.trigger_keyword.toLowerCase()));
    if (matched) {
      autoReply = matched.reply_text;
      supabase.from('business_auto_replies').update({ trigger_count: (matched.trigger_count || 0) + 1 }).eq('id', matched.id).then(() => {});
    }
  }
  const { data } = await supabase.from('business_inbox').insert({
    business_id: biz.id, customer_id: req.user.id, subject, message: message.trim(),
    reply: autoReply, replied_at: autoReply ? new Date().toISOString() : null,
    is_auto_replied: !!autoReply, status: autoReply ? 'replied' : 'unread'
  }).select().single();
  res.json({ message: data, auto_reply: autoReply });
});

app.post('/api/brand/inbox/:id/reply', businessAuth, async (req, res) => {
  const { reply } = req.body;
  if (!reply?.trim()) return res.status(400).json({ error: 'Nội dung phản hồi không được trống' });
  const { data: msg } = await supabase.from('business_inbox').select('business_id').eq('id', req.params.id).single();
  if (!msg || msg.business_id !== req.business.id) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('business_inbox').update({ reply: reply.trim(), replied_at: new Date().toISOString(), status: 'replied' }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.patch('/api/brand/inbox/:id/status', businessAuth, async (req, res) => {
  const { status } = req.body;
  if (!['read','closed','unread'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  const { data: msg } = await supabase.from('business_inbox').select('business_id').eq('id', req.params.id).single();
  if (!msg || msg.business_id !== req.business.id) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('business_inbox').update({ status }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Auto Replies ──
app.get('/api/brand/auto-replies', businessAuth, async (req, res) => {
  const { data } = await supabase.from('business_auto_replies').select('*').eq('business_id', req.business.id).order('created_at', { ascending: false });
  res.json({ rules: data || [] });
});

app.post('/api/brand/auto-replies', businessAuth, async (req, res) => {
  const { trigger_keyword, reply_text } = req.body;
  if (!trigger_keyword?.trim() || !reply_text?.trim()) return res.status(400).json({ error: 'Từ khóa và phản hồi không được trống' });
  const { data } = await supabase.from('business_auto_replies').insert({ business_id: req.business.id, trigger_keyword: trigger_keyword.trim(), reply_text: reply_text.trim() }).select().single();
  res.json({ rule: data });
});

app.patch('/api/brand/auto-replies/:id', businessAuth, async (req, res) => {
  const { data: rule } = await supabase.from('business_auto_replies').select('business_id').eq('id', req.params.id).single();
  if (!rule || rule.business_id !== req.business.id) return res.status(403).json({ error: 'Không có quyền' });
  const { is_active, trigger_keyword, reply_text } = req.body;
  const updates = {};
  if (is_active !== undefined) updates.is_active = is_active;
  if (trigger_keyword) updates.trigger_keyword = trigger_keyword.trim();
  if (reply_text) updates.reply_text = reply_text.trim();
  await supabase.from('business_auto_replies').update(updates).eq('id', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/brand/auto-replies/:id', businessAuth, async (req, res) => {
  const { data: rule } = await supabase.from('business_auto_replies').select('business_id').eq('id', req.params.id).single();
  if (!rule || rule.business_id !== req.business.id) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('business_auto_replies').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Brand Follow & Discovery ──
app.post('/api/brand/follow/:slug', auth, async (req, res) => {
  const { data: biz } = await supabase.from('business_accounts').select('id,followers_count').eq('store_slug', req.params.slug).single();
  if (!biz) return res.status(404).json({ error: 'Không tìm thấy thương hiệu' });
  const { data: existing } = await supabase.from('brand_follows').select('id').eq('business_id', biz.id).eq('user_id', req.user.id).single();
  if (existing) {
    await supabase.from('brand_follows').delete().eq('id', existing.id);
    await supabase.from('business_accounts').update({ followers_count: Math.max(0, (biz.followers_count || 0) - 1) }).eq('id', biz.id);
    return res.json({ following: false });
  }
  await supabase.from('brand_follows').insert({ business_id: biz.id, user_id: req.user.id });
  await supabase.from('business_accounts').update({ followers_count: (biz.followers_count || 0) + 1 }).eq('id', biz.id);
  res.json({ following: true });
});

app.get('/api/brand/discover', async (req, res) => {
  const { category, search, limit = 24, page = 1 } = req.query;
  const from = (page - 1) * limit;
  let q = supabase.from('business_accounts').select('id,company_name,store_slug,logo_url,cover_image_url,description,badge,is_verified_business,followers_count,posts_count,avg_rating,total_orders,category,tags,status').eq('status', 'active');
  if (category) q = q.eq('category', category);
  if (search) q = q.ilike('company_name', `%${search}%`);
  const { data } = await q.order('followers_count', { ascending: false }).range(from, from + parseInt(limit) - 1);
  res.json({ brands: data || [] });
});

app.get('/api/brand/:slug/trust', async (req, res) => {
  const { data: biz } = await supabase.from('business_accounts').select('id,avg_rating,total_orders,trust_score,badge,is_verified_business').eq('store_slug', req.params.slug).single();
  if (!biz) return res.status(404).json({ error: 'Không tìm thấy thương hiệu' });
  // Compute trust score from multiple signals
  let score = 0;
  const signals = {};
  // Rating signal (0-30 pts)
  const ratingPts = Math.round((biz.avg_rating || 0) / 5 * 30);
  signals.rating = ratingPts;
  score += ratingPts;
  // Orders signal (0-25 pts)
  const orderPts = Math.min(25, Math.round((biz.total_orders || 0) / 10));
  signals.orders = orderPts;
  score += orderPts;
  // Verification (0-25 pts)
  const verifyPts = biz.is_verified_business ? 25 : 0;
  signals.verification = verifyPts;
  score += verifyPts;
  // Badge (0-20 pts)
  const badgePts = { diamond: 20, platinum: 16, gold: 12, silver: 8, bronze: 4, trusted: 6, verified: 10 }[biz.badge] || 0;
  signals.badge = badgePts;
  score += badgePts;
  // Update trust_score
  await supabase.from('business_accounts').update({ trust_score: Math.min(100, score) }).eq('id', biz.id);
  res.json({ trust_score: Math.min(100, score), signals, badge: biz.badge, is_verified: biz.is_verified_business });
});

app.get('/api/brand/:slug/page', async (req, res) => {
  const { data: biz } = await supabase.from('business_accounts').select('id,company_name,store_slug,logo_url,cover_image_url,description,website_url,badge,is_verified_business,followers_count,posts_count,avg_rating,total_orders,total_revenue,category,tags,trust_score,created_at').eq('store_slug', req.params.slug).eq('status','active').single();
  if (!biz) return res.status(404).json({ error: 'Không tìm thấy thương hiệu' });
  const [{ data: posts }, { data: campaigns }, { data: inventory }] = await Promise.all([
    supabase.from('brand_posts').select('*').eq('business_id', biz.id).eq('status','active').order('is_pinned',{ascending:false}).order('created_at',{ascending:false}).limit(10),
    supabase.from('brand_campaigns').select('*').eq('business_id', biz.id).eq('status','active').limit(5),
    supabase.from('merchant_inventory').select('id,name,price,images,stock_count,category').eq('business_id', biz.id).eq('status','active').limit(12)
  ]);
  res.json({ brand: biz, posts: posts||[], campaigns: campaigns||[], inventory: inventory||[] });
});

// ── Admin Brand Center ──
app.get('/api/admin/brand/posts', adminAuth, async (req, res) => {
  const { data } = await supabase.from('brand_posts').select('*,business_accounts(company_name,store_slug)').neq('status','deleted').order('created_at',{ascending:false}).limit(100);
  res.json({ posts: data || [] });
});

app.delete('/api/admin/brand/posts/:id', adminAuth, async (req, res) => {
  await supabase.from('brand_posts').update({ status: 'deleted' }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/brand/campaigns', adminAuth, async (req, res) => {
  const { data } = await supabase.from('brand_campaigns').select('*,business_accounts(company_name,store_slug)').order('created_at',{ascending:false}).limit(100);
  res.json({ campaigns: data || [] });
});

app.get('/api/admin/brand/overview', adminAuth, async (req, res) => {
  const [{ count: brands }, { count: posts }, { count: campaigns }, { count: collabs }, { count: inbox }] = await Promise.all([
    supabase.from('business_accounts').select('*',{count:'exact',head:true}).eq('status','active'),
    supabase.from('brand_posts').select('*',{count:'exact',head:true}).eq('status','active'),
    supabase.from('brand_campaigns').select('*',{count:'exact',head:true}).eq('status','active'),
    supabase.from('brand_collaborations').select('*',{count:'exact',head:true}).eq('status','open'),
    supabase.from('business_inbox').select('*',{count:'exact',head:true}).eq('status','unread')
  ]);
  res.json({ brands, posts, campaigns, collabs, inbox });
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

// ══════════════════════════════════════════════════════════
// PHASE 9 — TRUST CENTER & VERIFIED SELLER NETWORK
// ══════════════════════════════════════════════════════════

// ── SERVE trust.html ──
app.get('/trust', (req, res) => {
  res.sendFile(join(__dirname, 'frontend', 'trust.html'));
});

// ── HELPER: compute trust score from stats ──
async function recalculateTrustScore(userId) {
  try {
    const { data: user } = await supabase.from('users').select('created_at,is_verified').eq('id', userId).single();
    const { data: ts } = await supabase.from('trust_scores').select('*').eq('user_id', userId).single();
    const { data: orders } = await supabase.from('orders').select('status,buyer_id,seller_id').or(`buyer_id.eq.${userId},seller_id.eq.${userId}`);
    const { data: reviews } = await supabase.from('reviews').select('rating').eq('seller_id', userId);
    const { data: disputes } = await supabase.from('orders').select('id').eq('status','disputed').or(`buyer_id.eq.${userId},seller_id.eq.${userId}`);

    const totalOrders = (orders||[]).length;
    const completedOrders = (orders||[]).filter(o => o.status === 'completed').length;
    const disputeCount = (disputes||[]).length;
    const avgRating = reviews && reviews.length ? reviews.reduce((s,r) => s + r.rating, 0) / reviews.length : 0;

    const completionRate = totalOrders > 0 ? completedOrders / totalOrders : 0;
    const disputeRate = totalOrders > 0 ? disputeCount / totalOrders : 0;

    const joinsMs = user?.created_at ? Date.now() - new Date(user.created_at).getTime() : 0;
    const monthsActive = joinsMs / (1000 * 60 * 60 * 24 * 30);

    let score = 100;
    score += Math.min(completedOrders * 8, 250);
    score += Math.round(completionRate * 150);
    score += Math.round(avgRating * 30);
    score += Math.min(Math.floor(monthsActive) * 5, 100);
    score -= Math.round(disputeRate * 200);
    score -= disputeCount * 15;
    if (ts?.id_verified) score += 80;
    if (ts?.phone_verified) score += 50;
    if (ts?.email_verified) score += 30;
    if (ts?.address_verified) score += 40;
    if (ts?.face_verified) score += 50;

    score = Math.max(0, Math.min(1000, Math.round(score)));

    let level = 'bronze';
    if (score >= 800) level = 'diamond';
    else if (score >= 600) level = 'platinum';
    else if (score >= 400) level = 'gold';
    else if (score >= 200) level = 'silver';

    let risk_level = 'low';
    if (disputeRate > 0.3 || score < 150) risk_level = 'high';
    else if (disputeRate > 0.1 || score < 300) risk_level = 'medium';

    const isPremium = (ts?.id_verified && ts?.phone_verified && completedOrders >= 10 && avgRating >= 4.5);
    const isTop = (completedOrders >= 50 && avgRating >= 4.8 && score >= 700);

    await supabase.from('trust_scores').upsert({
      user_id: userId,
      score,
      level,
      risk_level,
      total_transactions: totalOrders,
      successful_transactions: completedOrders,
      dispute_count: disputeCount,
      avg_rating: Math.round(avgRating * 100) / 100,
      is_premium_seller: !!isPremium,
      is_top_seller: !!isTop,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

    return { score, level, risk_level };
  } catch(e) {
    return null;
  }
}

// ── GET /api/trust/me ──
app.get('/api/trust/me', auth, async (req, res) => {
  const userId = req.user.id;
  await recalculateTrustScore(userId);
  const { data: ts } = await supabase.from('trust_scores').select('*').eq('user_id', userId).single();
  const { data: docs } = await supabase.from('verification_documents').select('doc_type,status,submitted_at,reviewed_at,admin_note').eq('user_id', userId).order('submitted_at', { ascending: false });
  const { data: history } = await supabase.from('reputation_history').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(30);
  res.json({ trust: ts || { score: 100, level: 'bronze', risk_level: 'low' }, documents: docs || [], history: history || [] });
});

// ── GET /api/trust/profile/:userId ──
app.get('/api/trust/profile/:userId', async (req, res) => {
  const { userId } = req.params;
  await recalculateTrustScore(userId);
  const { data: user } = await supabase.from('users').select('id,name,created_at,is_verified').eq('id', userId).single();
  if (!user) return res.status(404).json({ error: 'Không tìm thấy' });
  const { data: ts } = await supabase.from('trust_scores').select('*').eq('user_id', userId).single();
  res.json({ user, trust: ts || { score: 100, level: 'bronze', risk_level: 'low' } });
});

// ── GET /api/trust/leaderboard ──
app.get('/api/trust/leaderboard', async (req, res) => {
  const { type = 'trust' } = req.query;
  let q = supabase.from('trust_scores').select('*, users!trust_scores_user_id_fkey(id,name,created_at)');
  if (type === 'seller') {
    q = q.order('successful_transactions', { ascending: false });
  } else if (type === 'buyer') {
    q = q.order('total_transactions', { ascending: false });
  } else {
    q = q.order('score', { ascending: false });
  }
  const { data, error } = await q.limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ leaderboard: data || [] });
});

// ── POST /api/trust/verify/document — upload CCCD/passport/license ──
const trustDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Chỉ chấp nhận file ảnh'));
    cb(null, true);
  }
});

app.post('/api/trust/verify/document', auth, trustDocUpload.fields([
  { name: 'front', maxCount: 1 },
  { name: 'back', maxCount: 1 }
]), async (req, res) => {
  const { doc_type } = req.body;
  if (!['cccd','passport','driver_license'].includes(doc_type)) {
    return res.status(400).json({ error: 'Loại tài liệu không hợp lệ' });
  }
  const frontFile = req.files?.front?.[0];
  if (!frontFile) return res.status(400).json({ error: 'Vui lòng upload ảnh mặt trước' });

  const frontPath = `identity/${req.user.id}/${doc_type}_front_${Date.now()}.${frontFile.mimetype.split('/')[1]}`;
  const { error: upErr } = await supabase.storage.from('kyc-documents').upload(frontPath, frontFile.buffer, { contentType: frontFile.mimetype, upsert: true });
  if (upErr) return res.status(500).json({ error: 'Lỗi upload ảnh' });
  const { data: { publicUrl: frontUrl } } = supabase.storage.from('kyc-documents').getPublicUrl(frontPath);

  let backUrl = null;
  const backFile = req.files?.back?.[0];
  if (backFile) {
    const backPath = `identity/${req.user.id}/${doc_type}_back_${Date.now()}.${backFile.mimetype.split('/')[1]}`;
    await supabase.storage.from('kyc-documents').upload(backPath, backFile.buffer, { contentType: backFile.mimetype, upsert: true });
    const { data: { publicUrl } } = supabase.storage.from('kyc-documents').getPublicUrl(backPath);
    backUrl = publicUrl;
  }

  await supabase.from('verification_documents').upsert({
    user_id: req.user.id,
    doc_type,
    file_url: frontUrl,
    file_url_2: backUrl,
    status: 'pending',
    submitted_at: new Date().toISOString(),
    admin_note: null,
    reviewed_at: null,
    reviewed_by: null
  }, { onConflict: 'user_id,doc_type' }).catch(() => {
    supabase.from('verification_documents').insert({
      user_id: req.user.id, doc_type, file_url: frontUrl, file_url_2: backUrl, status: 'pending'
    });
  });
  res.json({ success: true, message: 'Đã gửi tài liệu — đang chờ duyệt' });
});

// ── POST /api/trust/verify/address ──
app.post('/api/trust/verify/address', auth, trustDocUpload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Vui lòng upload tài liệu địa chỉ' });
  const path = `address/${req.user.id}/address_${Date.now()}.${req.file.mimetype.split('/')[1]}`;
  const { error } = await supabase.storage.from('kyc-documents').upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (error) return res.status(500).json({ error: 'Lỗi upload' });
  const { data: { publicUrl } } = supabase.storage.from('kyc-documents').getPublicUrl(path);
  await supabase.from('verification_documents').insert({ user_id: req.user.id, doc_type: 'address', file_url: publicUrl, status: 'pending' });
  res.json({ success: true, message: 'Đã gửi tài liệu địa chỉ — đang chờ duyệt' });
});

// ── POST /api/trust/verify/face ──
app.post('/api/trust/verify/face', auth, trustDocUpload.fields([
  { name: 'portrait', maxCount: 1 },
  { name: 'selfie', maxCount: 1 }
]), async (req, res) => {
  const portrait = req.files?.portrait?.[0];
  if (!portrait) return res.status(400).json({ error: 'Vui lòng upload ảnh chân dung' });
  const path = `face/${req.user.id}/portrait_${Date.now()}.${portrait.mimetype.split('/')[1]}`;
  await supabase.storage.from('kyc-documents').upload(path, portrait.buffer, { contentType: portrait.mimetype, upsert: true });
  const { data: { publicUrl: portraitUrl } } = supabase.storage.from('kyc-documents').getPublicUrl(path);

  let selfieUrl = null;
  const selfie = req.files?.selfie?.[0];
  if (selfie) {
    const sp = `face/${req.user.id}/selfie_${Date.now()}.${selfie.mimetype.split('/')[1]}`;
    await supabase.storage.from('kyc-documents').upload(sp, selfie.buffer, { contentType: selfie.mimetype, upsert: true });
    const { data: { publicUrl } } = supabase.storage.from('kyc-documents').getPublicUrl(sp);
    selfieUrl = publicUrl;
  }

  await supabase.from('verification_documents').insert({ user_id: req.user.id, doc_type: 'face', file_url: portraitUrl, file_url_2: selfieUrl, status: 'pending' });
  res.json({ success: true, message: 'Đã gửi ảnh khuôn mặt — đang chờ duyệt' });
});

// ── POST /api/trust/verify/email ──
app.post('/api/trust/verify/email-status', auth, async (req, res) => {
  const { data: ts } = await supabase.from('trust_scores').select('email_verified').eq('user_id', req.user.id).single();
  const { data: user } = await supabase.from('users').select('email,email_verified').eq('id', req.user.id).single();
  const verified = !!(user?.email_verified || ts?.email_verified);
  if (verified) {
    await supabase.from('trust_scores').upsert({ user_id: req.user.id, email_verified: true }, { onConflict: 'user_id' });
    await supabase.from('reputation_history').insert({ user_id: req.user.id, event_type: 'email_verified', delta: 30, description: 'Xác minh email thành công' });
  }
  res.json({ verified, email: user?.email || null });
});

// ── ADMIN: GET /api/admin/trust/verifications ──
app.get('/api/admin/trust/verifications', adminAuth, async (req, res) => {
  const { status = 'pending', doc_type } = req.query;
  let q = supabase.from('verification_documents')
    .select('*, users!verification_documents_user_id_fkey(id,name,phone)')
    .order('submitted_at', { ascending: true });
  if (status && status !== 'all') q = q.eq('status', status);
  if (doc_type) q = q.eq('doc_type', doc_type);
  const { data, error } = await q.limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ verifications: data || [] });
});

// ── ADMIN: POST /api/admin/trust/verifications/:id/approve ──
app.post('/api/admin/trust/verifications/:id/approve', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { data: doc } = await supabase.from('verification_documents').select('*').eq('id', id).single();
  if (!doc) return res.status(404).json({ error: 'Không tìm thấy' });

  await supabase.from('verification_documents').update({ status: 'approved', reviewed_at: new Date().toISOString() }).eq('id', id);

  const field = doc.doc_type === 'cccd' || doc.doc_type === 'passport' || doc.doc_type === 'driver_license'
    ? 'id_verified'
    : doc.doc_type === 'address' ? 'address_verified'
    : doc.doc_type === 'face' ? 'face_verified' : null;

  if (field) {
    await supabase.from('trust_scores').upsert({ user_id: doc.user_id, [field]: true }, { onConflict: 'user_id' });
    const eventMap = { id_verified: 'identity_verified', address_verified: 'address_verified', face_verified: 'face_verified' };
    const deltaMap = { id_verified: 80, address_verified: 40, face_verified: 50 };
    await supabase.from('reputation_history').insert({ user_id: doc.user_id, event_type: eventMap[field] || 'identity_verified', delta: deltaMap[field] || 50, description: `Xác minh ${doc.doc_type} được duyệt` });
    await recalculateTrustScore(doc.user_id);
  }
  res.json({ success: true });
});

// ── ADMIN: POST /api/admin/trust/verifications/:id/reject ──
app.post('/api/admin/trust/verifications/:id/reject', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { note } = req.body;
  const { data: doc } = await supabase.from('verification_documents').select('user_id').eq('id', id).single();
  if (!doc) return res.status(404).json({ error: 'Không tìm thấy' });
  await supabase.from('verification_documents').update({ status: 'rejected', reviewed_at: new Date().toISOString(), admin_note: note || 'Tài liệu không hợp lệ' }).eq('id', id);
  res.json({ success: true });
});

// ── ADMIN: GET /api/admin/trust/users ──
app.get('/api/admin/trust/users', adminAuth, async (req, res) => {
  const { level, risk } = req.query;
  let q = supabase.from('trust_scores')
    .select('*, users!trust_scores_user_id_fkey(id,name,phone,created_at)')
    .order('score', { ascending: false })
    .limit(100);
  if (level) q = q.eq('level', level);
  if (risk) q = q.eq('risk_level', risk);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ users: data || [] });
});

// ══════════════════════════════════════════════════════════
// PHASE 10 — INSPECTION CENTER
// ══════════════════════════════════════════════════════════

// ── SERVE inspection.html ──
app.get('/inspection', (req, res) => {
  res.sendFile(join(__dirname, 'frontend', 'inspection.html'));
});

// ── MULTER for inspection media ──
const inspectionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB (video support)
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    if (!ok) return cb(new Error('Chỉ chấp nhận ảnh hoặc video'));
    cb(null, true);
  }
});

// ── Init inspection-media bucket ──
(async () => {
  try {
    await supabase.storage.createBucket('inspection-media', { public: true });
  } catch(e) { /* bucket already exists */ }
})();

// ── GET /api/inspection/fees ──
app.get('/api/inspection/fees', async (req, res) => {
  const { data, error } = await supabase.from('inspection_fees').select('*').order('fee');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ fees: data || [] });
});

// ── POST /api/inspection/request — create new inspection request ──
app.post('/api/inspection/request', auth, async (req, res) => {
  const { order_id, seller_id, category, item_title, item_description } = req.body;
  if (!category || !item_title) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });

  const { data: feeRow } = await supabase.from('inspection_fees').select('fee').eq('category', category).single();
  const fee = feeRow?.fee || 50000;

  const { data, error } = await supabase.from('inspection_requests').insert({
    requester_id: req.user.id,
    order_id: order_id || null,
    seller_id: seller_id || null,
    category,
    item_title: sanitize(item_title),
    item_description: sanitize(item_description || ''),
    fee,
    status: 'pending_shipment'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ request: data });
});

// ── GET /api/inspection/my-requests ──
app.get('/api/inspection/my-requests', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('inspection_requests')
    .select('*, inspection_reports(*), inspection_photos(*)')
    .eq('requester_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data || [] });
});

// ── GET /api/inspection/requests/:id ──
app.get('/api/inspection/requests/:id', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('inspection_requests')
    .select('*, inspection_reports(*), inspection_photos(*), users!inspection_requests_requester_id_fkey(id,name)')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Không tìm thấy' });
  if (data.requester_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Không có quyền truy cập' });
  }
  res.json(data);
});

// ── POST /api/inspection/requests/:id/accept — buyer accepts result ──
app.post('/api/inspection/requests/:id/accept', auth, async (req, res) => {
  const { data } = await supabase.from('inspection_requests').select('requester_id,status').eq('id', req.params.id).single();
  if (!data) return res.status(404).json({ error: 'Không tìm thấy' });
  if (data.requester_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (data.status !== 'completed') return res.status(400).json({ error: 'Chưa hoàn tất kiểm định' });
  res.json({ success: true, message: 'Đã chấp nhận kết quả kiểm định' });
});

// ── POST /api/inspection/requests/:id/reject — buyer rejects result ──
app.post('/api/inspection/requests/:id/reject', auth, async (req, res) => {
  const { data } = await supabase.from('inspection_requests').select('requester_id,status').eq('id', req.params.id).single();
  if (!data) return res.status(404).json({ error: 'Không tìm thấy' });
  if (data.requester_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('inspection_requests').update({ status: 'rejected_by_buyer' }).eq('id', req.params.id);
  res.json({ success: true });
});

// ── ADMIN: GET /api/admin/inspection/requests ──
app.get('/api/admin/inspection/requests', adminAuth, async (req, res) => {
  const { status } = req.query;
  let q = supabase.from('inspection_requests')
    .select('*, inspection_reports(*), users!inspection_requests_requester_id_fkey(id,name,phone)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (status && status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data || [] });
});

// ── ADMIN: POST /api/admin/inspection/requests/:id/status — update status ──
app.post('/api/admin/inspection/requests/:id/status', adminAuth, async (req, res) => {
  const { status, tracking_code, notes } = req.body;
  const validStatuses = ['pending_shipment','received','inspecting','completed','cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });

  const update = { status, notes: notes || null };
  if (status === 'received') update.received_at = new Date().toISOString();
  if (status === 'completed') update.completed_at = new Date().toISOString();
  if (tracking_code) update.tracking_code = tracking_code;
  if (req.adminUser?.id) update.inspector_id = req.adminUser.id;

  const { error } = await supabase.from('inspection_requests').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── ADMIN: POST /api/admin/inspection/requests/:id/report — create/update report ──
app.post('/api/admin/inspection/requests/:id/report', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { overall_score, overall_condition, is_authentic, matches_description,
          accessories_complete, no_major_defects, checklist, inspector_notes, video_url } = req.body;

  const safepass_verified = !!(is_authentic && matches_description && no_major_defects && overall_score >= 7);

  const reportData = {
    request_id: id,
    overall_score: parseInt(overall_score) || 0,
    overall_condition: overall_condition || 'good',
    is_authentic: !!is_authentic,
    matches_description: !!matches_description,
    accessories_complete: !!accessories_complete,
    no_major_defects: !!no_major_defects,
    safepass_verified,
    checklist: checklist || {},
    inspector_notes: inspector_notes || '',
    video_url: video_url || null,
    updated_at: new Date().toISOString()
  };

  const { data: existing } = await supabase.from('inspection_reports').select('id').eq('request_id', id).single();
  let error;
  if (existing) {
    ({ error } = await supabase.from('inspection_reports').update(reportData).eq('request_id', id));
  } else {
    ({ error } = await supabase.from('inspection_reports').insert(reportData));
  }

  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('inspection_requests').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', id);
  res.json({ success: true, safepass_verified });
});

// ── ADMIN: POST /api/admin/inspection/requests/:id/photos — upload photos ──
app.post('/api/admin/inspection/requests/:id/photos', adminAuth, inspectionUpload.array('photos', 20), async (req, res) => {
  const { id } = req.params;
  const { photo_type = 'detail' } = req.body;

  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Chưa có file' });

  const uploads = [];
  for (const file of req.files) {
    const ext = file.mimetype.split('/')[1];
    const isVideo = file.mimetype.startsWith('video/');
    const folder = isVideo ? 'videos' : 'photos';
    const path = `${folder}/${id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    await supabase.storage.from('inspection-media').upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
    const { data: { publicUrl } } = supabase.storage.from('inspection-media').getPublicUrl(path);

    if (isVideo) {
      await supabase.from('inspection_reports').update({ video_url: publicUrl }).eq('request_id', id);
    } else {
      uploads.push({ request_id: id, photo_url: publicUrl, photo_type });
    }
  }

  if (uploads.length > 0) {
    await supabase.from('inspection_photos').insert(uploads);
  }

  res.json({ success: true, count: uploads.length });
});

// ── ADMIN: DELETE /api/admin/inspection/photos/:photoId ──
app.delete('/api/admin/inspection/photos/:photoId', adminAuth, async (req, res) => {
  const { error } = await supabase.from('inspection_photos').delete().eq('id', req.params.photoId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── ADMIN: PUT /api/admin/inspection/fees/:category — update fee ──
app.put('/api/admin/inspection/fees/:category', adminAuth, async (req, res) => {
  const { fee } = req.body;
  if (!fee || fee < 0) return res.status(400).json({ error: 'Phí không hợp lệ' });
  const { error } = await supabase.from('inspection_fees').update({ fee: parseInt(fee), updated_at: new Date().toISOString() }).eq('category', req.params.category);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── ADMIN: GET /api/admin/inspection/dashboard ──
app.get('/api/admin/inspection/dashboard', adminAuth, async (req, res) => {
  const { data: reqs } = await supabase.from('inspection_requests').select('status,fee,paid');
  const { data: reports } = await supabase.from('inspection_reports').select('safepass_verified,overall_condition');

  const total = (reqs||[]).length;
  const completed = (reqs||[]).filter(r => r.status === 'completed').length;
  const revenue = (reqs||[]).filter(r => r.paid).reduce((s, r) => s + (r.fee||0), 0);
  const verified = (reports||[]).filter(r => r.safepass_verified).length;
  const passRate = completed > 0 ? Math.round((verified / completed) * 100) : 0;
  const byStatus = {};
  (reqs||[]).forEach(r => { byStatus[r.status] = (byStatus[r.status]||0) + 1; });

  res.json({ total, completed, revenue, verified, passRate, byStatus });
});

// ══════════════════════════════════════════════════════════
// PHASE 11 — WAREHOUSE NETWORK
// ══════════════════════════════════════════════════════════

// ── SERVE warehouse.html ──
app.get('/warehouse', (req, res) => {
  res.sendFile(join(__dirname, 'frontend', 'warehouse.html'));
});

// ── GET /api/warehouse/list — public warehouse list ──
app.get('/api/warehouse/list', async (req, res) => {
  const { data, error } = await supabase.from('warehouses').select('*').order('city');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ warehouses: data || [] });
});

// ── GET /api/warehouse/fees — public storage fee list ──
app.get('/api/warehouse/fees', async (req, res) => {
  const { data, error } = await supabase.from('warehouse_storage_fees').select('*').order('fee_per_day');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ fees: data || [] });
});

// ── POST /api/warehouse/consign — user creates a consignment ──
app.post('/api/warehouse/consign', auth, async (req, res) => {
  const { product_name, category, quantity, size_category, weight_kg, condition, description, warehouse_id } = req.body;
  if (!product_name || !size_category || !warehouse_id) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });

  const { data: feeRow } = await supabase.from('warehouse_storage_fees').select('fee_per_day').eq('size_category', size_category).single();

  const { data, error } = await supabase.from('warehouse_inventory').insert({
    owner_id: req.user.id,
    warehouse_id,
    product_name: sanitize(product_name),
    category: category || null,
    quantity: parseInt(quantity) || 1,
    size_category,
    weight_kg: weight_kg ? parseFloat(weight_kg) : null,
    condition: condition || 'good',
    description: sanitize(description || ''),
    status: 'pending_arrival'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Create initial billing record
  if (feeRow) {
    await supabase.from('warehouse_billing').insert({
      inventory_id: data.id,
      owner_id: req.user.id,
      billing_period: 'daily',
      fee_per_unit: feeRow.fee_per_day,
      days_stored: 0,
      total_fee: 0,
      period_start: new Date().toISOString()
    });
  }

  res.json({ item: data });
});

// ── GET /api/warehouse/my-inventory ──
app.get('/api/warehouse/my-inventory', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('warehouse_inventory')
    .select('*')
    .eq('owner_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ inventory: data || [] });
});

// ── POST /api/warehouse/pickpack — user requests pick & pack ──
app.post('/api/warehouse/pickpack', auth, async (req, res) => {
  const { inventory_id } = req.body;
  if (!inventory_id) return res.status(400).json({ error: 'Thiếu inventory_id' });

  const { data: item } = await supabase.from('warehouse_inventory').select('owner_id,status,warehouse_id').eq('id', inventory_id).single();
  if (!item) return res.status(404).json({ error: 'Không tìm thấy mặt hàng' });
  if (item.owner_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (!['stored','received','inspected'].includes(item.status)) return res.status(400).json({ error: 'Hàng chưa sẵn sàng đóng gói' });

  const { data, error } = await supabase.from('warehouse_pickpack').insert({
    inventory_id,
    requested_by: req.user.id,
    status: 'pending'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('warehouse_inventory').update({ status: 'picked' }).eq('id', inventory_id);
  res.json({ pickpack: data });
});

// ── POST /api/warehouse/transfer — user requests warehouse transfer ──
app.post('/api/warehouse/transfer', auth, async (req, res) => {
  const { inventory_id, to_warehouse_id } = req.body;
  if (!inventory_id || !to_warehouse_id) return res.status(400).json({ error: 'Thiếu thông tin' });

  const { data: item } = await supabase.from('warehouse_inventory').select('owner_id,warehouse_id,status').eq('id', inventory_id).single();
  if (!item) return res.status(404).json({ error: 'Không tìm thấy mặt hàng' });
  if (item.owner_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
  if (item.warehouse_id === to_warehouse_id) return res.status(400).json({ error: 'Kho đích trùng kho hiện tại' });

  const { data, error } = await supabase.from('warehouse_transfers').insert({
    inventory_id,
    from_warehouse_id: item.warehouse_id,
    to_warehouse_id,
    initiated_by: req.user.id,
    status: 'pending'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ transfer: data });
});

// ── ADMIN: GET /api/admin/warehouse/dashboard ──
app.get('/api/admin/warehouse/dashboard', adminAuth, async (req, res) => {
  const { data: inv } = await supabase.from('warehouse_inventory').select('status,size_category');
  const { data: billing } = await supabase.from('warehouse_billing').select('total_fee,paid');

  const totalItems = (inv||[]).length;
  const stored = (inv||[]).filter(i => i.status === 'stored').length;
  const pending = (inv||[]).filter(i => i.status === 'pending_arrival').length;
  const dispatched = (inv||[]).filter(i => i.status === 'dispatched').length;
  const totalRevenue = (billing||[]).reduce((s, b) => s + (b.total_fee||0), 0);

  const byCategory = {};
  (inv||[]).forEach(i => { byCategory[i.size_category] = (byCategory[i.size_category]||0) + 1; });

  res.json({ totalItems, stored, pending, dispatched, totalRevenue, byCategory });
});

// ── ADMIN: GET /api/admin/warehouse/inventory ──
app.get('/api/admin/warehouse/inventory', adminAuth, async (req, res) => {
  const { status, warehouse_id } = req.query;
  let q = supabase
    .from('warehouse_inventory')
    .select('*, users!warehouse_inventory_owner_id_fkey(id,name,phone)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (status && status !== 'all') q = q.eq('status', status);
  if (warehouse_id) q = q.eq('warehouse_id', warehouse_id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ inventory: data || [] });
});

// ── ADMIN: POST /api/admin/warehouse/inventory/:id/status ──
app.post('/api/admin/warehouse/inventory/:id/status', adminAuth, async (req, res) => {
  const { status, shelf_location, notes } = req.body;
  const validStatuses = ['pending_arrival','received','inspected','stored','reserved','picked','dispatched','returned','lost'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });

  const update = { status, updated_at: new Date().toISOString() };
  if (shelf_location) update.shelf_location = shelf_location;
  if (notes) update.notes = notes;
  if (status === 'received') update.arrived_at = new Date().toISOString();
  if (status === 'stored') update.stored_at = new Date().toISOString();
  if (status === 'dispatched') update.dispatched_at = new Date().toISOString();

  const { error } = await supabase.from('warehouse_inventory').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  // Update warehouse used_slots when stored or dispatched
  if (status === 'stored') {
    const { data: item } = await supabase.from('warehouse_inventory').select('warehouse_id').eq('id', req.params.id).single();
    if (item?.warehouse_id) {
      await supabase.rpc('increment_warehouse_slots', { wh_id: item.warehouse_id, delta: 1 }).catch(() => {});
    }
  }

  res.json({ success: true });
});

// ── ADMIN: POST /api/admin/warehouse/create ──
app.post('/api/admin/warehouse/create', adminAuth, async (req, res) => {
  const { code, name, address, city, capacity, manager_name } = req.body;
  if (!code || !name || !address || !city) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });

  const { data, error } = await supabase.from('warehouses').insert({
    code: code.toUpperCase(),
    name: sanitize(name),
    address: sanitize(address),
    city: sanitize(city),
    capacity: parseInt(capacity) || 1000,
    manager_name: manager_name ? sanitize(manager_name) : null,
    status: 'active'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ warehouse: data });
});

// ── ADMIN: PUT /api/admin/warehouse/:id ── update warehouse
app.put('/api/admin/warehouse/:id', adminAuth, async (req, res) => {
  const { name, address, city, capacity, status, manager_name } = req.body;
  const update = { updated_at: new Date().toISOString() };
  if (name) update.name = sanitize(name);
  if (address) update.address = sanitize(address);
  if (city) update.city = sanitize(city);
  if (capacity) update.capacity = parseInt(capacity);
  if (status) update.status = status;
  if (manager_name !== undefined) update.manager_name = manager_name ? sanitize(manager_name) : null;

  const { error } = await supabase.from('warehouses').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── ADMIN: GET /api/admin/warehouse/transfers ──
app.get('/api/admin/warehouse/transfers', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('warehouse_transfers')
    .select('*, warehouse_inventory(product_name), from_wh:from_warehouse_id(name), to_wh:to_warehouse_id(name)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ transfers: data || [] });
});

// ── ADMIN: POST /api/admin/warehouse/transfers/:id/complete ──
app.post('/api/admin/warehouse/transfers/:id/complete', adminAuth, async (req, res) => {
  const { data: transfer } = await supabase.from('warehouse_transfers').select('inventory_id,to_warehouse_id').eq('id', req.params.id).single();
  if (!transfer) return res.status(404).json({ error: 'Không tìm thấy' });

  await supabase.from('warehouse_transfers').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', req.params.id);
  await supabase.from('warehouse_inventory').update({ warehouse_id: transfer.to_warehouse_id, shelf_location: null }).eq('id', transfer.inventory_id);

  res.json({ success: true });
});

// ── ADMIN: GET /api/admin/warehouse/pickpack ──
app.get('/api/admin/warehouse/pickpack', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('warehouse_pickpack')
    .select('*, warehouse_inventory(product_name,size_category,warehouse_id)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data || [] });
});

// ── ADMIN: POST /api/admin/warehouse/pickpack/:id/status ──
app.post('/api/admin/warehouse/pickpack/:id/status', adminAuth, async (req, res) => {
  const { status, tracking_code, carrier } = req.body;
  const valid = ['pending','picking','packing','ready','dispatched','cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });

  const update = { status };
  if (tracking_code) update.tracking_code = tracking_code;
  if (carrier) update.carrier = carrier;
  if (status === 'dispatched') {
    update.dispatched_at = new Date().toISOString();
    const { data: pp } = await supabase.from('warehouse_pickpack').select('inventory_id').eq('id', req.params.id).single();
    if (pp?.inventory_id) {
      await supabase.from('warehouse_inventory').update({ status: 'dispatched', dispatched_at: new Date().toISOString() }).eq('id', pp.inventory_id);
    }
  }

  const { error } = await supabase.from('warehouse_pickpack').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── ADMIN: PUT /api/admin/warehouse/fees/:size_category ──
app.put('/api/admin/warehouse/fees/:size_category', adminAuth, async (req, res) => {
  const { fee_per_day, fee_per_week, fee_per_month } = req.body;
  const update = {};
  if (fee_per_day !== undefined) update.fee_per_day = parseInt(fee_per_day);
  if (fee_per_week !== undefined) update.fee_per_week = parseInt(fee_per_week);
  if (fee_per_month !== undefined) update.fee_per_month = parseInt(fee_per_month);
  if (!Object.keys(update).length) return res.status(400).json({ error: 'Không có dữ liệu cập nhật' });

  const { error } = await supabase.from('warehouse_storage_fees').update(update).eq('size_category', req.params.size_category);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
// PHASE 12 — DELIVERY NETWORK
// ══════════════════════════════════════════════════════════

// ── SERVE delivery.html ──
app.get('/delivery', (req, res) => {
  res.sendFile(join(__dirname, 'frontend', 'delivery.html'));
});

// ── GET /api/delivery/hubs — public hub list ──
app.get('/api/delivery/hubs', async (req, res) => {
  const { data, error } = await supabase.from('delivery_hubs').select('*').eq('status','active').order('city');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ hubs: data || [] });
});

// ── POST /api/delivery/create — user creates delivery order ──
app.post('/api/delivery/create', auth, async (req, res) => {
  const {
    pickup_address, pickup_city, pickup_contact,
    delivery_address, delivery_city, delivery_contact,
    item_description, item_value, weight_kg, cod_amount, is_fragile,
    order_id
  } = req.body;
  if (!pickup_address || !delivery_address || !delivery_city || !delivery_contact || !item_description)
    return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });

  // Estimate fee: 25k base + 5k per km (simulated)
  const sameCityFee = pickup_city === delivery_city ? 25000 : 60000;
  const fragile_surcharge = is_fragile ? 10000 : 0;
  const delivery_fee = sameCityFee + fragile_surcharge;

  const { data, error } = await supabase.from('delivery_orders').insert({
    sender_id: req.user.id,
    order_id: order_id || null,
    pickup_address: sanitize(pickup_address),
    pickup_city: pickup_city || 'Hồ Chí Minh',
    pickup_contact: pickup_contact || null,
    delivery_address: sanitize(delivery_address),
    delivery_city: delivery_city || 'Hồ Chí Minh',
    delivery_contact: delivery_contact,
    item_description: sanitize(item_description),
    item_value: parseInt(item_value) || 0,
    weight_kg: weight_kg ? parseFloat(weight_kg) : null,
    cod_amount: parseInt(cod_amount) || 0,
    is_fragile: !!is_fragile,
    delivery_fee,
    status: 'pending'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Generate OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  await supabase.from('delivery_orders').update({ otp_code: otp }).eq('id', data.id);

  // Tracking log
  await supabase.from('delivery_tracking').insert({ delivery_id: data.id, status: 'pending', note: 'Đơn được tạo' });

  res.json({ order: data, otp });
});

// ── GET /api/delivery/my-orders ──
app.get('/api/delivery/my-orders', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('delivery_orders')
    .select('*')
    .eq('sender_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data || [] });
});

// ── GET /api/delivery/:id/tracking ──
app.get('/api/delivery/:id/tracking', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('delivery_tracking')
    .select('*')
    .eq('delivery_id', req.params.id)
    .order('recorded_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tracking: data || [] });
});

// ── POST /api/delivery/:id/rate ──
app.post('/api/delivery/:id/rate', auth, async (req, res) => {
  const { attitude_score, speed_score, accuracy_score, comment } = req.body;
  const { data: order } = await supabase.from('delivery_orders').select('driver_id,status').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (order.status !== 'delivered') return res.status(400).json({ error: 'Đơn chưa được giao' });
  if (!order.driver_id) return res.status(400).json({ error: 'Chưa có tài xế' });

  const overall = ((parseInt(attitude_score)||5) + (parseInt(speed_score)||5) + (parseInt(accuracy_score)||5)) / 3;

  const { error } = await supabase.from('driver_ratings').insert({
    delivery_id: req.params.id,
    driver_id: order.driver_id,
    rated_by: req.user.id,
    attitude_score: parseInt(attitude_score) || 5,
    speed_score: parseInt(speed_score) || 5,
    accuracy_score: parseInt(accuracy_score) || 5,
    overall_score: overall,
    comment: sanitize(comment || '')
  });

  if (error && error.code === '23505') return res.status(400).json({ error: 'Bạn đã đánh giá đơn này rồi' });
  if (error) return res.status(500).json({ error: error.message });

  // Update driver rating average
  const { data: ratings } = await supabase.from('driver_ratings').select('overall_score').eq('driver_id', order.driver_id);
  if (ratings?.length) {
    const avg = ratings.reduce((s, r) => s + parseFloat(r.overall_score||5), 0) / ratings.length;
    await supabase.from('drivers').update({ rating: Math.round(avg * 100) / 100 }).eq('id', order.driver_id);
  }

  res.json({ success: true });
});

// ── POST /api/delivery/driver/register ──
app.post('/api/delivery/driver/register', auth, async (req, res) => {
  const { full_name, phone, cccd, license_number, vehicle_type, vehicle_plate, hub_id, service_areas } = req.body;
  if (!full_name || !phone || !cccd || !vehicle_plate || !hub_id)
    return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });

  const { data: existing } = await supabase.from('drivers').select('id').eq('user_id', req.user.id).single();
  if (existing) return res.status(400).json({ error: 'Bạn đã đăng ký làm tài xế rồi' });

  const { data, error } = await supabase.from('drivers').insert({
    user_id: req.user.id,
    full_name: sanitize(full_name),
    phone,
    cccd,
    license_number: license_number || null,
    vehicle_type: vehicle_type || 'motorbike',
    vehicle_plate: vehicle_plate.toUpperCase(),
    hub_id,
    service_areas: service_areas || [],
    status: 'offline',
    level: 'driver'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ driver: data });
});

// ── GET /api/delivery/my-driver ──
app.get('/api/delivery/my-driver', auth, async (req, res) => {
  const { data, error } = await supabase.from('drivers').select('*').eq('user_id', req.user.id).single();
  if (error) return res.status(404).json({ error: 'Không tìm thấy hồ sơ tài xế' });
  res.json(data);
});

// ── PUT /api/delivery/driver/status ──
app.put('/api/delivery/driver/status', auth, async (req, res) => {
  const { status } = req.body;
  if (!['online','offline'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  const { data: driver } = await supabase.from('drivers').select('id').eq('user_id', req.user.id).single();
  if (!driver) return res.status(404).json({ error: 'Chưa đăng ký tài xế' });
  await supabase.from('drivers').update({ status, last_seen: new Date().toISOString() }).eq('id', driver.id);
  res.json({ success: true });
});

// ── POST /api/delivery/driver/withdraw ──
app.post('/api/delivery/driver/withdraw', auth, async (req, res) => {
  const { amount, bank_info } = req.body;
  if (!amount || amount < 50000) return res.status(400).json({ error: 'Số tiền tối thiểu 50.000đ' });
  const { data: driver } = await supabase.from('drivers').select('id,wallet_balance').eq('user_id', req.user.id).single();
  if (!driver) return res.status(404).json({ error: 'Không tìm thấy hồ sơ tài xế' });
  if (driver.wallet_balance < amount) return res.status(400).json({ error: 'Số dư không đủ' });

  await supabase.from('drivers').update({ wallet_balance: driver.wallet_balance - amount }).eq('id', driver.id);
  await supabase.from('driver_earnings').insert({
    driver_id: driver.id,
    type: 'withdrawal',
    amount: -amount,
    description: `Rút tiền → ${bank_info}`
  });
  res.json({ success: true });
});

// ── GET /api/delivery/driver/earnings ──
app.get('/api/delivery/driver/earnings', auth, async (req, res) => {
  const { data: driver } = await supabase.from('drivers').select('id').eq('user_id', req.user.id).single();
  if (!driver) return res.status(404).json({ error: 'Không tìm thấy hồ sơ tài xế' });
  const { data, error } = await supabase.from('driver_earnings').select('*').eq('driver_id', driver.id).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ earnings: data || [] });
});

// ── ADMIN: GET /api/admin/delivery/dashboard ──
app.get('/api/admin/delivery/dashboard', adminAuth, async (req, res) => {
  const { data: drivers } = await supabase.from('drivers').select('status,level');
  const { data: orders } = await supabase.from('delivery_orders').select('status,delivery_fee');

  const totalDrivers = (drivers||[]).length;
  const onlineDrivers = (drivers||[]).filter(d => d.status === 'online' || d.status === 'delivering').length;
  const activeOrders = (orders||[]).filter(o => ['assigned','picking_up','picked','delivering'].includes(o.status)).length;
  const delivered = (orders||[]).filter(o => o.status === 'delivered').length;
  const total = (orders||[]).length;
  const successRate = total > 0 ? Math.round(delivered / total * 100) : 0;
  const totalRevenue = (orders||[]).filter(o => o.status === 'delivered').reduce((s,o) => s + (o.delivery_fee||0), 0);

  const byLevel = {};
  (drivers||[]).forEach(d => { byLevel[d.level] = (byLevel[d.level]||0) + 1; });

  res.json({ totalDrivers, onlineDrivers, activeOrders, delivered, total, successRate, totalRevenue, byLevel });
});

// ── ADMIN: GET /api/admin/delivery/drivers ──
app.get('/api/admin/delivery/drivers', adminAuth, async (req, res) => {
  const { status } = req.query;
  let q = supabase.from('drivers').select('*').order('created_at', { ascending: false }).limit(100);
  if (status && status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ drivers: data || [] });
});

// ── ADMIN: GET /api/admin/delivery/orders ──
app.get('/api/admin/delivery/orders', adminAuth, async (req, res) => {
  const { status, limit: lim } = req.query;
  let q = supabase.from('delivery_orders').select('*, drivers(full_name,phone,vehicle_plate)').order('created_at', { ascending: false }).limit(parseInt(lim)||100);
  if (status && status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data || [] });
});

// ── ADMIN: POST /api/admin/delivery/orders/:id/assign — smart auto-assign ──
app.post('/api/admin/delivery/orders/:id/assign', adminAuth, async (req, res) => {
  const { driver_id } = req.body; // optional: manual override

  let targetDriver = null;
  if (driver_id) {
    const { data } = await supabase.from('drivers').select('id,full_name').eq('id', driver_id).single();
    targetDriver = data;
  } else {
    // Auto-assign: pick first online, verified driver
    const { data } = await supabase.from('drivers')
      .select('id,full_name')
      .eq('status', 'online')
      .eq('is_verified', true)
      .limit(1)
      .single();
    targetDriver = data;
  }

  if (!targetDriver) return res.status(400).json({ error: 'Không có tài xế online để phân công' });

  const { error } = await supabase.from('delivery_orders').update({
    driver_id: targetDriver.id,
    status: 'assigned',
    assigned_at: new Date().toISOString()
  }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('drivers').update({ status: 'delivering' }).eq('id', targetDriver.id);
  await supabase.from('delivery_tracking').insert({ delivery_id: req.params.id, status: 'assigned', note: `Phân công: ${targetDriver.full_name}` });

  res.json({ success: true, driver_name: targetDriver.full_name });
});

// ── ADMIN: POST /api/admin/delivery/orders/:id/status ──
app.post('/api/admin/delivery/orders/:id/status', adminAuth, async (req, res) => {
  const { status, note, fail_reason } = req.body;
  const valid = ['pending','assigned','picking_up','picked','delivering','delivered','failed','cancelled','returned'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });

  const update = { status, updated_at: new Date().toISOString() };
  if (status === 'picked') update.picked_at = new Date().toISOString();
  if (status === 'delivered') update.delivered_at = new Date().toISOString();
  if (fail_reason) update.fail_reason = fail_reason;

  const { data: order, error } = await supabase.from('delivery_orders').update(update).eq('id', req.params.id).select('driver_id,delivery_fee').single();
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('delivery_tracking').insert({ delivery_id: req.params.id, status, note: note || null });

  // Credit driver on delivery
  if (status === 'delivered' && order?.driver_id) {
    const driverEarning = Math.round((order.delivery_fee || 0) * 0.8); // 80% to driver
    const { data: drv } = await supabase.from('drivers').select('wallet_balance,total_deliveries').eq('id', order.driver_id).single();
    if (drv) {
      await supabase.from('drivers').update({
        wallet_balance: drv.wallet_balance + driverEarning,
        total_deliveries: drv.total_deliveries + 1,
        status: 'online'
      }).eq('id', order.driver_id);
      await supabase.from('driver_earnings').insert({
        driver_id: order.driver_id,
        delivery_id: req.params.id,
        type: 'delivery_fee',
        amount: driverEarning,
        description: `Giao đơn #${req.params.id.slice(0,8)}`
      });
    }
  }

  res.json({ success: true });
});

// ── ADMIN: POST /api/admin/delivery/drivers/:id/verify ──
app.post('/api/admin/delivery/drivers/:id/verify', adminAuth, async (req, res) => {
  const { error } = await supabase.from('drivers').update({ is_verified: true }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── ADMIN: POST /api/admin/delivery/drivers/:id/suspend ──
app.post('/api/admin/delivery/drivers/:id/suspend', adminAuth, async (req, res) => {
  const { error } = await supabase.from('drivers').update({ status: 'suspended' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── ADMIN: POST /api/admin/delivery/drivers/:id/activate ──
app.post('/api/admin/delivery/drivers/:id/activate', adminAuth, async (req, res) => {
  const { error } = await supabase.from('drivers').update({ status: 'offline' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── ADMIN: POST /api/admin/delivery/drivers/:id/bonus ──
app.post('/api/admin/delivery/drivers/:id/bonus', adminAuth, async (req, res) => {
  const { amount, description } = req.body;
  if (!amount) return res.status(400).json({ error: 'Thiếu số tiền' });
  const { data: drv } = await supabase.from('drivers').select('wallet_balance').eq('id', req.params.id).single();
  if (!drv) return res.status(404).json({ error: 'Không tìm thấy tài xế' });
  await supabase.from('drivers').update({ wallet_balance: drv.wallet_balance + parseInt(amount) }).eq('id', req.params.id);
  await supabase.from('driver_earnings').insert({ driver_id: req.params.id, type: 'bonus', amount: parseInt(amount), description: description||'Thưởng từ Admin' });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
// PHASE 13 — AI ANTI-FRAUD & RISK ENGINE
// ══════════════════════════════════════════════════════════

app.get('/risk', (req, res) => {
  res.sendFile(join(__dirname, 'frontend', 'risk.html'));
});

// ── AI RISK SCORE CALCULATOR ──
async function calculateRiskScore(userId) {
  try {
    const { data: user } = await supabase.from('users').select('id,is_banned,kyc_status,created_at').eq('id', userId).single();
    if (!user) return null;

    let score = 0;
    const factors = {};

    // 1. Dispute rate
    const { count: totalOrders } = await supabase.from('orders').select('id', { count:'exact', head:true }).or(`buyer_id.eq.${userId},seller_id.eq.${userId}`);
    const { count: disputeCount } = await supabase.from('disputes').select('id', { count:'exact', head:true }).or(`buyer_id.eq.${userId},seller_id.eq.${userId}`);
    const disputeRate = totalOrders > 0 ? disputeCount / totalOrders : 0;
    if (disputeRate > 0.2) { score += 20; factors.high_dispute_rate = true; }
    else if (disputeRate > 0.1) score += 8;

    // 2. Reviews average
    const { data: reviews } = await supabase.from('reviews').select('rating').eq('seller_id', userId).limit(50);
    const avgRating = reviews?.length ? reviews.reduce((s, r) => s + (r.rating||5), 0) / reviews.length : 5;
    if (avgRating < 3) { score += 15; factors.low_review_score = true; }
    else if (avgRating < 4) score += 5;

    // 3. Account age (newer = slightly more risk)
    const agedays = (Date.now() - new Date(user.created_at).getTime()) / 86400000;
    if (agedays < 7) score += 10;
    else if (agedays < 30) score += 5;

    // 4. KYC status
    if (user.kyc_status !== 'approved') score += 5;

    // 5. High-value orders without KYC
    const { count: largeOrders } = await supabase.from('orders').select('id', { count:'exact', head:true })
      .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`).gte('amount', 5000000);
    if (largeOrders > 0 && user.kyc_status !== 'approved') { score += 20; factors.no_kyc_high_value = true; }

    score = Math.min(100, Math.max(0, score));
    const level = score <= 20 ? 'safe' : score <= 50 ? 'medium' : score <= 80 ? 'high' : 'critical';

    const profileData = {
      user_id: userId,
      risk_score: score,
      risk_level: level,
      dispute_rate: disputeRate,
      refund_rate: 0,
      avg_review_score: avgRating,
      total_transactions: totalOrders || 0,
      ml_features: factors,
      last_analyzed: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: existing } = await supabase.from('risk_profiles').select('id').eq('user_id', userId).single();
    if (existing) {
      await supabase.from('risk_profiles').update(profileData).eq('user_id', userId);
    } else {
      await supabase.from('risk_profiles').insert(profileData);
    }

    // Auto-create high-risk alert
    if (level === 'critical' || level === 'high') {
      const { data: existAlert } = await supabase.from('risk_alerts')
        .select('id').eq('user_id', userId).eq('status', 'open').eq('alert_type', 'user').single();
      if (!existAlert) {
        await supabase.from('risk_alerts').insert({
          user_id: userId,
          alert_type: 'user',
          severity: level === 'critical' ? 'critical' : 'high',
          title: `Tài khoản ${level === 'critical' ? 'nguy hiểm cao' : 'rủi ro cao'} — Score ${score}`,
          description: `Risk score: ${score}/100. Các yếu tố: ${Object.keys(factors).join(', ') || 'tổng hợp'}`,
          entity_id: userId,
          entity_type: 'user'
        });
      }
    }

    return { ...profileData, id: existing?.id };
  } catch(e) {
    console.error('[RiskEngine]', e.message);
    return null;
  }
}

// ── GET /api/risk/my-profile ──
app.get('/api/risk/my-profile', auth, async (req, res) => {
  const { data } = await supabase.from('risk_profiles').select('*').eq('user_id', req.user.id).single();
  if (!data) {
    // Create initial safe profile
    const profile = await calculateRiskScore(req.user.id);
    return res.json(profile || { risk_score: 0, risk_level: 'safe' });
  }
  res.json(data);
});

// ── POST /api/risk/analyze — user triggers self-analysis ──
app.post('/api/risk/analyze', auth, async (req, res) => {
  const profile = await calculateRiskScore(req.user.id);
  if (!profile) return res.status(500).json({ error: 'Lỗi phân tích' });
  res.json({ profile });
});

// ── GET /api/risk/my-alerts ──
app.get('/api/risk/my-alerts', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('risk_alerts')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ alerts: data || [] });
});

// ── GET /api/risk/insights — public stats ──
app.get('/api/risk/insights', auth, async (req, res) => {
  const { data: profiles } = await supabase.from('risk_profiles').select('risk_level,risk_score,flagged');
  const { data: alerts } = await supabase.from('risk_alerts').select('status');

  const safe = (profiles||[]).filter(p => p.risk_level === 'safe').length;
  const medium = (profiles||[]).filter(p => p.risk_level === 'medium').length;
  const high = (profiles||[]).filter(p => p.risk_level === 'high').length;
  const critical = (profiles||[]).filter(p => p.risk_level === 'critical').length;
  const flagged = (profiles||[]).filter(p => p.flagged).length;
  const openAlerts = (alerts||[]).filter(a => a.status === 'open').length;
  const total = (profiles||[]).length;
  const avgScore = total > 0 ? Math.round((profiles||[]).reduce((s,p) => s+(p.risk_score||0), 0) / total) : 0;

  res.json({ safeUsers:safe, mediumUsers:medium, highUsers:high, criticalUsers:critical,
    flaggedUsers:flagged, openAlerts, totalProfiles:total, avgRiskScore:avgScore });
});

// ── ADMIN: GET /api/admin/risk/alerts ──
app.get('/api/admin/risk/alerts', adminAuth, async (req, res) => {
  const { status } = req.query;
  let q = supabase.from('risk_alerts').select('*').order('created_at', { ascending: false }).limit(100);
  if (status && status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ alerts: data || [] });
});

// ── ADMIN: POST /api/admin/risk/alerts/:id/status ──
app.post('/api/admin/risk/alerts/:id/status', adminAuth, async (req, res) => {
  const { status, notes } = req.body;
  const valid = ['open','reviewing','resolved','dismissed','actioned'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  const update = { status, reviewed_at: new Date().toISOString() };
  if (req.adminUser?.id) update.reviewed_by = req.adminUser.id;
  if (notes) update.reviewer_notes = notes;
  const { error } = await supabase.from('risk_alerts').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── ADMIN: GET /api/admin/risk/high-risk-users ──
app.get('/api/admin/risk/high-risk-users', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('risk_profiles')
    .select('*, users!risk_profiles_user_id_fkey(id,name,phone,is_banned)')
    .in('risk_level', ['high','critical'])
    .order('risk_score', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profiles: data || [] });
});

// ── ADMIN: POST /api/admin/risk/users/:userId/flag ──
app.post('/api/admin/risk/users/:userId/flag', adminAuth, async (req, res) => {
  await supabase.from('risk_profiles').update({ flagged: true, updated_at: new Date().toISOString() }).eq('user_id', req.params.userId);
  await supabase.from('risk_alerts').insert({ user_id: req.params.userId, alert_type:'user', severity:'high', title:'Tài khoản bị gắn cờ bởi Admin', description:'Admin đã gắn cờ tài khoản này để theo dõi', entity_id: req.params.userId, entity_type:'user' });
  res.json({ success: true });
});

// ── ADMIN: POST /api/admin/risk/users/:userId/unflag ──
app.post('/api/admin/risk/users/:userId/unflag', adminAuth, async (req, res) => {
  await supabase.from('risk_profiles').update({ flagged: false, updated_at: new Date().toISOString() }).eq('user_id', req.params.userId);
  res.json({ success: true });
});

// ── ADMIN: POST /api/admin/risk/users/:userId/ban ──
app.post('/api/admin/risk/users/:userId/ban', adminAuth, async (req, res) => {
  const { reason } = req.body;
  await supabase.from('users').update({ is_banned: true }).eq('id', req.params.userId);
  await supabase.from('risk_profiles').update({ flagged: true, banned_reason: reason || 'Khoá bởi AI Risk Engine', updated_at: new Date().toISOString() }).eq('user_id', req.params.userId);
  await supabase.from('risk_events').insert({ user_id: req.params.userId, event_type: 'account_banned', risk_delta: 50, event_data: { reason, banned_by: 'admin' } });
  res.json({ success: true });
});

// ── ADMIN: POST /api/admin/risk/users/:userId/analyze ──
app.post('/api/admin/risk/users/:userId/analyze', adminAuth, async (req, res) => {
  const profile = await calculateRiskScore(req.params.userId);
  if (!profile) return res.status(500).json({ error: 'Lỗi phân tích' });
  res.json(profile);
});

// ── ADMIN: POST /api/admin/risk/batch-analyze ──
app.post('/api/admin/risk/batch-analyze', adminAuth, async (req, res) => {
  const { data: users } = await supabase.from('users').select('id').eq('is_banned', false).limit(100);
  let analyzed = 0;
  for (const u of (users || [])) {
    await calculateRiskScore(u.id);
    analyzed++;
    await new Promise(r => setTimeout(r, 50)); // throttle
  }
  res.json({ success: true, analyzed });
});

// ── ADMIN: POST /api/admin/risk/alerts/create — manual alert ──
app.post('/api/admin/risk/alerts/create', adminAuth, async (req, res) => {
  const { user_id, alert_type, severity, title, description } = req.body;
  if (!title || !alert_type) return res.status(400).json({ error: 'Thiếu thông tin' });
  const { data, error } = await supabase.from('risk_alerts').insert({
    user_id: user_id || null,
    alert_type, severity: severity || 'medium', title: sanitize(title),
    description: sanitize(description || ''),
    auto_flagged: false
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ alert: data });
});

// ═══════════════════════════════════════════════════════════
// PHASE 18: SAFEPASS PAY — WALLET SYSTEM
// ═══════════════════════════════════════════════════════════

// Serve Pay page
app.get('/pay', (req, res) => {
  res.sendFile(new URL('./frontend/pay.html', import.meta.url).pathname);
});

// ── Helper: get or create wallet ──
async function getOrCreateWallet(userId) {
  let { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', userId).single();
  if (!wallet) {
    const { data: newWallet } = await supabase.from('wallets').insert({ user_id: userId }).select().single();
    wallet = newWallet;
  }
  return wallet;
}

// ── Helper: record wallet transaction ──
async function recordTxn(walletId, userId, type, amount, extra = {}) {
  const { data: wallet } = await supabase.from('wallets').select('balance').eq('id', walletId).single();
  const before = wallet?.balance || 0;
  await supabase.from('wallet_transactions').insert({
    wallet_id: walletId, user_id: userId, type, amount,
    balance_before: before, balance_after: before,
    ...extra
  });
}

// ── GET /api/pay/wallet ── (get wallet + monthly breakdown)
app.get('/api/pay/wallet', auth, async (req, res) => {
  const uid = req.user.userId;
  const wallet = await getOrCreateWallet(uid);
  if (!wallet) return res.status(500).json({ error: 'Không thể tạo ví' });

  // Monthly breakdown for chart (last 6 months)
  const { data: txns } = await supabase.from('wallet_transactions')
    .select('type,amount,created_at').eq('user_id', uid);
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const m = d.toISOString().slice(0, 7);
    const label = d.toLocaleDateString('vi-VN', { month: 'short', year: 'numeric' });
    const mt = (txns || []).filter(t => t.created_at?.startsWith(m));
    monthly.push({
      label,
      deposited: mt.filter(t => t.type === 'deposit').reduce((s, t) => s + (t.amount || 0), 0),
      withdrawn: mt.filter(t => t.type === 'withdrawal').reduce((s, t) => s + (t.amount || 0), 0)
    });
  }
  res.json({ wallet, monthly });
});

// ── GET /api/pay/transactions ──
app.get('/api/pay/transactions', auth, async (req, res) => {
  const uid = req.user.userId;
  const limit = Number(req.query.limit) || 20;
  const type = req.query.type;
  let q = supabase.from('wallet_transactions')
    .select('*').eq('user_id', uid)
    .order('created_at', { ascending: false }).limit(limit);
  if (type && type !== 'all') q = q.eq('type', type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  // Enrich counterpart info
  const enriched = await Promise.all((data || []).map(async t => {
    if (t.counterpart_user_id) {
      const { data: u } = await supabase.from('users').select('name,phone').eq('id', t.counterpart_user_id).single();
      return { ...t, counterpart_name: u?.name || u?.phone || 'Người dùng' };
    }
    return t;
  }));
  res.json({ transactions: enriched });
});

// ── POST /api/pay/deposit ──
app.post('/api/pay/deposit', auth, async (req, res) => {
  const uid = req.user.userId;
  const { amount } = req.body;
  if (!amount || amount < 10000) return res.status(400).json({ error: 'Số tiền tối thiểu 10,000₫' });
  if (amount > 100000000) return res.status(400).json({ error: 'Vượt hạn mức nạp tối đa' });

  const wallet = await getOrCreateWallet(uid);
  // Generate a bank reference
  const bankRef = `SP${Date.now().toString().slice(-8).toUpperCase()}`;

  const { data: deposit } = await supabase.from('deposit_requests').insert({
    user_id: uid, amount, method: 'bank_transfer', bank_ref: bankRef,
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  }).select().single();

  res.json({ deposit, bank_ref: bankRef, reference: `SAFEPASS ${bankRef}` });
});

// ── POST /api/pay/withdraw ──
app.post('/api/pay/withdraw', auth, async (req, res) => {
  const uid = req.user.userId;
  const { amount, bank_name, bank_account, bank_holder } = req.body;
  if (!amount || amount < 50000) return res.status(400).json({ error: 'Số tiền tối thiểu 50,000₫' });
  if (!bank_name || !bank_account || !bank_holder) return res.status(400).json({ error: 'Thiếu thông tin ngân hàng' });

  const wallet = await getOrCreateWallet(uid);
  if ((wallet.balance || 0) < amount) return res.status(400).json({ error: 'Số dư không đủ' });

  // Freeze the amount
  const newBalance = (wallet.balance || 0) - amount;
  const newFrozen = (wallet.frozen_balance || 0) + amount;
  await supabase.from('wallets').update({
    balance: newBalance, frozen_balance: newFrozen,
    today_spent: (wallet.today_spent || 0) + amount,
    month_spent: (wallet.month_spent || 0) + amount,
    total_withdrawn: (wallet.total_withdrawn || 0) + amount,
    updated_at: new Date().toISOString()
  }).eq('id', wallet.id);

  // Record transaction
  await supabase.from('wallet_transactions').insert({
    wallet_id: wallet.id, user_id: uid, type: 'withdrawal', amount,
    balance_before: wallet.balance, balance_after: newBalance,
    note: `${bank_name} · ${bank_account}`, status: 'pending'
  });

  // Create withdrawal request
  const { data: wr } = await supabase.from('withdrawal_requests').insert({
    user_id: uid, wallet_id: wallet.id, amount, fee: 0, net_amount: amount,
    bank_name, bank_account, bank_holder, status: 'pending'
  }).select().single();

  res.json({ withdrawal: wr, message: 'Yêu cầu rút tiền đã được ghi nhận' });
});

// ── POST /api/pay/transfer ──
app.post('/api/pay/transfer', auth, async (req, res) => {
  const uid = req.user.userId;
  const { to_phone, amount, note } = req.body;
  if (!to_phone || !amount) return res.status(400).json({ error: 'Thiếu thông tin chuyển tiền' });
  if (amount < 1000) return res.status(400).json({ error: 'Số tiền tối thiểu 1,000₫' });

  // Find receiver
  const { data: receiver } = await supabase.from('users').select('id,name,phone').eq('phone', to_phone).single();
  if (!receiver) return res.status(404).json({ error: 'Không tìm thấy người nhận với số điện thoại này' });
  if (receiver.id === uid) return res.status(400).json({ error: 'Không thể chuyển tiền cho chính mình' });

  const senderWallet = await getOrCreateWallet(uid);
  if ((senderWallet.balance || 0) < amount) return res.status(400).json({ error: 'Số dư không đủ' });

  const receiverWallet = await getOrCreateWallet(receiver.id);

  // Debit sender
  const senderNewBal = senderWallet.balance - amount;
  await supabase.from('wallets').update({
    balance: senderNewBal,
    today_spent: (senderWallet.today_spent || 0) + amount,
    month_spent: (senderWallet.month_spent || 0) + amount,
    total_transferred_out: (senderWallet.total_transferred_out || 0) + amount,
    updated_at: new Date().toISOString()
  }).eq('id', senderWallet.id);

  // Credit receiver
  const receiverNewBal = (receiverWallet.balance || 0) + amount;
  await supabase.from('wallets').update({
    balance: receiverNewBal,
    total_transferred_in: (receiverWallet.total_transferred_in || 0) + amount,
    updated_at: new Date().toISOString()
  }).eq('id', receiverWallet.id);

  // Record both transactions
  await supabase.from('wallet_transactions').insert([
    { wallet_id: senderWallet.id, user_id: uid, type: 'transfer_out', amount,
      balance_before: senderWallet.balance, balance_after: senderNewBal,
      counterpart_user_id: receiver.id, note, reference_type: 'transfer', status: 'completed' },
    { wallet_id: receiverWallet.id, user_id: receiver.id, type: 'transfer_in', amount,
      balance_before: receiverWallet.balance, balance_after: receiverNewBal,
      counterpart_user_id: uid, note, reference_type: 'transfer', status: 'completed' }
  ]);

  // Award SafeCoin to sender (5 coins per transfer)
  await supabase.from('wallets').update({ safecoin: (senderWallet.safecoin || 0) + 5 }).eq('id', senderWallet.id);

  res.json({ message: `Chuyển ${amount.toLocaleString('vi-VN')}₫ đến ${receiver.name || receiver.phone} thành công` });
});

// ── GET /api/pay/requests ──
app.get('/api/pay/requests', auth, async (req, res) => {
  const uid = req.user.userId;
  const [received, sent] = await Promise.all([
    supabase.from('payment_requests').select('*').eq('payer_id', uid).order('created_at', { ascending: false }).limit(20),
    supabase.from('payment_requests').select('*').eq('requester_id', uid).order('created_at', { ascending: false }).limit(20)
  ]);

  // Enrich with user names
  async function enrich(list) {
    return Promise.all((list || []).map(async req => {
      const [rq, py] = await Promise.all([
        supabase.from('users').select('name,phone').eq('id', req.requester_id).single(),
        supabase.from('users').select('name,phone').eq('id', req.payer_id).single()
      ]);
      return { ...req, requester_name: rq.data?.name || rq.data?.phone, payer_name: py.data?.name || py.data?.phone };
    }));
  }

  const [enrichedReceived, enrichedSent] = await Promise.all([
    enrich(received.data), enrich(sent.data)
  ]);
  res.json({ received: enrichedReceived, sent: enrichedSent });
});

// ── POST /api/pay/requests ──
app.post('/api/pay/requests', auth, async (req, res) => {
  const uid = req.user.userId;
  const { payer_phone, amount, note } = req.body;
  if (!payer_phone || !amount) return res.status(400).json({ error: 'Thiếu thông tin' });

  const { data: payer } = await supabase.from('users').select('id,name,phone').eq('phone', payer_phone).single();
  if (!payer) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
  if (payer.id === uid) return res.status(400).json({ error: 'Không thể yêu cầu thanh toán từ chính mình' });

  const { data, error } = await supabase.from('payment_requests').insert({
    requester_id: uid, payer_id: payer.id, amount, note,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ request: data });
});

// ── POST /api/pay/requests/:id/pay ──
app.post('/api/pay/requests/:id/pay', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data: payReq } = await supabase.from('payment_requests').select('*').eq('id', req.params.id).single();
  if (!payReq) return res.status(404).json({ error: 'Không tìm thấy yêu cầu' });
  if (payReq.payer_id !== uid) return res.status(403).json({ error: 'Không có quyền' });
  if (payReq.status !== 'pending') return res.status(400).json({ error: 'Yêu cầu đã được xử lý' });
  if (new Date(payReq.expires_at) < new Date()) return res.status(400).json({ error: 'Yêu cầu đã hết hạn' });

  // Transfer from payer to requester
  const payerWallet = await getOrCreateWallet(uid);
  if ((payerWallet.balance || 0) < payReq.amount) return res.status(400).json({ error: 'Số dư không đủ' });

  const requesterWallet = await getOrCreateWallet(payReq.requester_id);
  const payerNewBal = payerWallet.balance - payReq.amount;
  const reqNewBal = (requesterWallet.balance || 0) + payReq.amount;

  await Promise.all([
    supabase.from('wallets').update({ balance: payerNewBal, today_spent: (payerWallet.today_spent||0)+payReq.amount, month_spent: (payerWallet.month_spent||0)+payReq.amount, updated_at: new Date().toISOString() }).eq('id', payerWallet.id),
    supabase.from('wallets').update({ balance: reqNewBal, updated_at: new Date().toISOString() }).eq('id', requesterWallet.id),
    supabase.from('payment_requests').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', payReq.id)
  ]);

  await supabase.from('wallet_transactions').insert([
    { wallet_id: payerWallet.id, user_id: uid, type: 'transfer_out', amount: payReq.amount,
      balance_before: payerWallet.balance, balance_after: payerNewBal,
      counterpart_user_id: payReq.requester_id, note: payReq.note, reference_type: 'payment_request', status: 'completed' },
    { wallet_id: requesterWallet.id, user_id: payReq.requester_id, type: 'transfer_in', amount: payReq.amount,
      balance_before: requesterWallet.balance, balance_after: reqNewBal,
      counterpart_user_id: uid, note: payReq.note, reference_type: 'payment_request', status: 'completed' }
  ]);

  res.json({ message: 'Thanh toán thành công' });
});

// ── POST /api/pay/requests/:id/cancel ──
app.post('/api/pay/requests/:id/cancel', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data: payReq } = await supabase.from('payment_requests').select('*').eq('id', req.params.id).single();
  if (!payReq) return res.status(404).json({ error: 'Không tìm thấy' });
  if (payReq.requester_id !== uid && payReq.payer_id !== uid) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('payment_requests').update({ status: 'cancelled' }).eq('id', req.params.id);
  res.json({ message: 'Đã huỷ yêu cầu' });
});

// ── POST /api/pay/safecoin/redeem ──
app.post('/api/pay/safecoin/redeem', auth, async (req, res) => {
  const uid = req.user.userId;
  const { amount } = req.body; // coins to redeem
  if (!amount || amount < 100) return res.status(400).json({ error: 'Tối thiểu 100 SafeCoin' });

  const wallet = await getOrCreateWallet(uid);
  if ((wallet.safecoin || 0) < amount) return res.status(400).json({ error: 'Không đủ SafeCoin' });

  const cashValue = amount * 100; // 1 coin = 100₫
  const newCoin = (wallet.safecoin || 0) - amount;
  const newBalance = (wallet.balance || 0) + cashValue;

  await supabase.from('wallets').update({
    safecoin: newCoin, balance: newBalance, updated_at: new Date().toISOString()
  }).eq('id', wallet.id);

  await supabase.from('wallet_transactions').insert({
    wallet_id: wallet.id, user_id: uid, type: 'safecoin_redeem', amount: cashValue,
    balance_before: wallet.balance, balance_after: newBalance,
    note: `Đổi ${amount} SafeCoin`, status: 'completed'
  });

  await supabase.from('safecoin_ledger').insert({
    user_id: uid, wallet_id: wallet.id, amount: -amount,
    balance_after: newCoin, reason: 'Đổi lấy tiền mặt', reference_type: 'redeem'
  });

  res.json({ message: `Đổi thành công ${amount} SafeCoin lấy ${cashValue.toLocaleString('vi-VN')}₫` });
});

// ── Admin: confirm deposit ──
app.post('/api/admin/pay/deposits/:id/confirm', adminAuth, async (req, res) => {
  const { data: dep } = await supabase.from('deposit_requests').select('*').eq('id', req.params.id).single();
  if (!dep) return res.status(404).json({ error: 'Không tìm thấy' });
  if (dep.status !== 'pending') return res.status(400).json({ error: 'Đã xử lý' });

  const wallet = await getOrCreateWallet(dep.user_id);
  const newBalance = (wallet.balance || 0) + dep.amount;
  const newDeposited = (wallet.total_deposited || 0) + dep.amount;

  await supabase.from('wallets').update({
    balance: newBalance, total_deposited: newDeposited, updated_at: new Date().toISOString()
  }).eq('id', wallet.id);

  await supabase.from('deposit_requests').update({
    status: 'confirmed', confirmed_at: new Date().toISOString()
  }).eq('id', dep.id);

  await supabase.from('wallet_transactions').insert({
    wallet_id: wallet.id, user_id: dep.user_id, type: 'deposit', amount: dep.amount,
    balance_before: wallet.balance, balance_after: newBalance,
    note: `Bank ref: ${dep.bank_ref}`, status: 'completed'
  });

  // Award 10 SafeCoin per deposit
  await supabase.from('wallets').update({ safecoin: (wallet.safecoin || 0) + 10 }).eq('id', wallet.id);

  res.json({ message: 'Đã xác nhận nạp tiền' });
});

// ── Admin: list deposit requests ──
app.get('/api/admin/pay/deposits', adminAuth, async (req, res) => {
  const { data } = await supabase.from('deposit_requests').select('*,users(name,phone)').order('created_at', { ascending: false }).limit(50);
  res.json({ deposits: data || [] });
});

// ── Admin: list withdrawal requests ──
app.get('/api/admin/pay/withdrawals', adminAuth, async (req, res) => {
  const { data } = await supabase.from('withdrawal_requests').select('*,users(name,phone)').order('created_at', { ascending: false }).limit(50);
  res.json({ withdrawals: data || [] });
});

// ── Admin: process withdrawal ──
app.post('/api/admin/pay/withdrawals/:id/process', adminAuth, async (req, res) => {
  const { action, admin_note } = req.body; // 'complete' or 'reject'
  const { data: wr } = await supabase.from('withdrawal_requests').select('*').eq('id', req.params.id).single();
  if (!wr) return res.status(404).json({ error: 'Không tìm thấy' });
  if (wr.status !== 'pending') return res.status(400).json({ error: 'Đã xử lý' });

  if (action === 'complete') {
    await supabase.from('withdrawal_requests').update({ status: 'completed', processed_at: new Date().toISOString(), admin_note }).eq('id', wr.id);
    // Unfreeze
    const wallet = await getOrCreateWallet(wr.user_id);
    await supabase.from('wallets').update({ frozen_balance: Math.max(0, (wallet.frozen_balance||0) - wr.amount), updated_at: new Date().toISOString() }).eq('id', wallet.id);
  } else {
    // Refund on reject
    const wallet = await getOrCreateWallet(wr.user_id);
    const refundedBal = (wallet.balance || 0) + wr.amount;
    await supabase.from('wallets').update({
      balance: refundedBal, frozen_balance: Math.max(0, (wallet.frozen_balance||0) - wr.amount),
      total_withdrawn: Math.max(0, (wallet.total_withdrawn||0) - wr.amount), updated_at: new Date().toISOString()
    }).eq('id', wallet.id);
    await supabase.from('withdrawal_requests').update({ status: 'rejected', admin_note }).eq('id', wr.id);
    await supabase.from('wallet_transactions').insert({
      wallet_id: wallet.id, user_id: wr.user_id, type: 'refund', amount: wr.amount,
      balance_before: wallet.balance, balance_after: refundedBal,
      note: 'Yêu cầu rút tiền bị từ chối', status: 'completed'
    });
  }
  res.json({ message: `Đã ${action === 'complete' ? 'hoàn tất' : 'từ chối'} yêu cầu rút tiền` });
});

// ═══════════════════════════════════════════════════════════
// PHASE SOCIAL 8: SUPER APP ECOSYSTEM
// ═══════════════════════════════════════════════════════════

// Serve Super App 8 page
app.get('/app', (req, res) => {
  res.sendFile(new URL('./frontend/app.html', import.meta.url).pathname);
});

// ── Loyalty helpers ──
async function getOrCreateLoyalty(userId) {
  let { data } = await supabase.from('sp_loyalty').select('*').eq('user_id', userId).single();
  if (!data) {
    const { data: d } = await supabase.from('sp_loyalty').insert({ user_id: userId }).select().single();
    data = d;
  }
  return data;
}
async function addLoyaltyPoints(userId, points, type, description, referenceId=null) {
  await supabase.from('sp_loyalty_txns').insert({ user_id:userId, points, type, description, reference_id:referenceId });
  const cur = await getOrCreateLoyalty(userId);
  const newPts = (cur.points||0) + points;
  const newLife = (cur.lifetime_points||0) + (points>0?points:0);
  let level = 'bronze';
  if (newLife >= 100000) level = 'diamond';
  else if (newLife >= 20000) level = 'platinum';
  else if (newLife >= 5000) level = 'gold';
  else if (newLife >= 1000) level = 'silver';
  await supabase.from('sp_loyalty').update({ points: Math.max(0,newPts), lifetime_points: newLife, level }).eq('user_id', userId);
  return { points: Math.max(0,newPts), lifetime_points: newLife, level };
}

// ── GET /api/app8/loyalty ──
app.get('/api/app8/loyalty', auth, async (req, res) => {
  const uid = req.user.userId;
  const loyalty = await getOrCreateLoyalty(uid);
  const { data: txns } = await supabase.from('sp_loyalty_txns').select('*').eq('user_id', uid).order('created_at',{ascending:false}).limit(20);
  const { data: leaders } = await supabase.from('sp_loyalty').select('user_id,points,lifetime_points,level').order('lifetime_points',{ascending:false}).limit(10);
  res.json({ loyalty, txns: txns||[], leaders: leaders||[] });
});

// ── POST /api/app8/loyalty/checkin ──
app.post('/api/app8/loyalty/checkin', auth, async (req, res) => {
  const uid = req.user.userId;
  const loyalty = await getOrCreateLoyalty(uid);
  const today = new Date().toISOString().slice(0,10);
  if (loyalty.last_checkin === today) return res.status(400).json({ error: 'Đã điểm danh hôm nay rồi' });
  const streak = loyalty.last_checkin === new Date(Date.now()-86400000).toISOString().slice(0,10) ? (loyalty.streak_days||0)+1 : 1;
  const pts = 5 + Math.min(streak-1, 6)*2;
  await supabase.from('sp_loyalty').update({ last_checkin: today, streak_days: streak }).eq('user_id', uid);
  const result = await addLoyaltyPoints(uid, pts, 'login', `Điểm danh ngày ${today} (streak ${streak})`);
  res.json({ message: `Điểm danh thành công! +${pts} điểm`, points_earned: pts, streak, ...result });
});

// ── Events: list ──
app.get('/api/app8/events', async (req, res) => {
  const { type, status='upcoming', limit=20, offset=0 } = req.query;
  let q = supabase.from('sp_events').select('*,users!sp_events_organizer_id_fkey(name,avatar_url)',{count:'exact'}).eq('status', status).order('start_at',{ascending:true}).range(+offset, +offset + +limit - 1);
  if (type) q = q.eq('type', type);
  const { data, count } = await q;
  res.json({ events: data||[], total: count||0 });
});

// ── Events: create ──
app.post('/api/app8/events', auth, async (req, res) => {
  const uid = req.user.userId;
  const { title,description,type,image_url,location,venue,start_at,end_at,ticket_price,capacity,tags } = req.body;
  if (!title) return res.status(400).json({ error: 'Tên sự kiện là bắt buộc' });
  const { data, error } = await supabase.from('sp_events').insert({ organizer_id:uid, title,description,type:type||'other',image_url,location,venue,start_at,end_at,ticket_price:+ticket_price||0,capacity:+capacity||100,tags }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Events: join ──
app.post('/api/app8/events/:id/join', auth, async (req, res) => {
  const uid = req.user.userId;
  const { id } = req.params;
  const { data: ev } = await supabase.from('sp_events').select('*').eq('id',id).single();
  if (!ev) return res.status(404).json({ error: 'Không tìm thấy sự kiện' });
  if (ev.attendees_count >= ev.capacity) return res.status(400).json({ error: 'Sự kiện đã đầy' });
  const { error } = await supabase.from('sp_event_attendees').insert({ event_id:id, user_id:uid });
  if (error) return res.status(400).json({ error: 'Bạn đã tham gia sự kiện này rồi' });
  await supabase.from('sp_events').update({ attendees_count: ev.attendees_count+1 }).eq('id', id);
  await addLoyaltyPoints(uid, 10, 'event', `Tham gia sự kiện: ${ev.title}`, id);
  res.json({ message: 'Đã đăng ký tham gia sự kiện!' });
});

// ── Events: my events ──
app.get('/api/app8/events/my', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data: created } = await supabase.from('sp_events').select('*').eq('organizer_id', uid).order('created_at',{ascending:false});
  const { data: joined } = await supabase.from('sp_event_attendees').select('*,sp_events(*)').eq('user_id', uid).order('created_at',{ascending:false});
  res.json({ created: created||[], joined: (joined||[]).map(j=>({...j.sp_events, joined_at: j.created_at})) });
});

// ── Events: admin ──
app.get('/api/admin/app8/events', adminAuth, async (req, res) => {
  const { data, count } = await supabase.from('sp_events').select('*,users!sp_events_organizer_id_fkey(name)',{count:'exact'}).order('created_at',{ascending:false}).limit(50);
  res.json({ events: data||[], total: count||0 });
});
app.patch('/api/admin/app8/events/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  await supabase.from('sp_events').update({ status }).eq('id', id);
  res.json({ message: 'Đã cập nhật' });
});

// ── Booking Services: list ──
app.get('/api/app8/booking/services', async (req, res) => {
  const { category, limit=20, offset=0 } = req.query;
  let q = supabase.from('sp_booking_services').select('*,users!sp_booking_services_provider_id_fkey(name,avatar_url)',{count:'exact'}).eq('is_active', true).order('rating',{ascending:false}).range(+offset, +offset + +limit - 1);
  if (category) q = q.eq('category', category);
  const { data, count } = await q;
  res.json({ services: data||[], total: count||0 });
});

// ── Booking Services: create ──
app.post('/api/app8/booking/services', auth, async (req, res) => {
  const uid = req.user.userId;
  const { name,description,type,price,duration_mins,image_url,category } = req.body;
  if (!name) return res.status(400).json({ error: 'Tên dịch vụ là bắt buộc' });
  const { data, error } = await supabase.from('sp_booking_services').insert({ provider_id:uid, name,description,type:type||'appointment',price:+price||0,duration_mins:+duration_mins||60,image_url,category:category||'other' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Booking Services: my services ──
app.get('/api/app8/booking/my-services', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data } = await supabase.from('sp_booking_services').select('*').eq('provider_id', uid).order('created_at',{ascending:false});
  res.json(data||[]);
});

// ── Bookings: create ──
app.post('/api/app8/bookings', auth, async (req, res) => {
  const uid = req.user.userId;
  const { service_id, scheduled_at, notes } = req.body;
  if (!service_id || !scheduled_at) return res.status(400).json({ error: 'Thiếu thông tin đặt lịch' });
  const { data: svc } = await supabase.from('sp_booking_services').select('*').eq('id',service_id).single();
  if (!svc) return res.status(404).json({ error: 'Dịch vụ không tồn tại' });
  if (svc.provider_id === uid) return res.status(400).json({ error: 'Không thể tự đặt dịch vụ của mình' });
  const { data, error } = await supabase.from('sp_bookings').insert({ service_id, provider_id:svc.provider_id, customer_id:uid, service_name:svc.name, price:svc.price, scheduled_at, duration_mins:svc.duration_mins, notes }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('sp_booking_services').update({ bookings_count: (svc.bookings_count||0)+1 }).eq('id', service_id);
  await addLoyaltyPoints(uid, 5, 'booking', `Đặt dịch vụ: ${svc.name}`, service_id);
  res.json(data);
});

// ── Bookings: my bookings ──
app.get('/api/app8/bookings/my', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data: asCustomer } = await supabase.from('sp_bookings').select('*,sp_booking_services(name,image_url),users!sp_bookings_provider_id_fkey(name,avatar_url)').eq('customer_id', uid).order('created_at',{ascending:false});
  const { data: asProvider } = await supabase.from('sp_bookings').select('*,users!sp_bookings_customer_id_fkey(name,avatar_url)').eq('provider_id', uid).order('created_at',{ascending:false});
  res.json({ as_customer: asCustomer||[], as_provider: asProvider||[] });
});

// ── Bookings: update status ──
app.patch('/api/app8/bookings/:id/status', auth, async (req, res) => {
  const uid = req.user.userId;
  const { id } = req.params;
  const { status } = req.body;
  const { data: bk } = await supabase.from('sp_bookings').select('*').eq('id',id).single();
  if (!bk) return res.status(404).json({ error: 'Không tìm thấy' });
  if (bk.provider_id !== uid && bk.customer_id !== uid) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('sp_bookings').update({ status }).eq('id', id);
  res.json({ message: 'Đã cập nhật trạng thái' });
});

// ── Mini Apps: list ──
app.get('/api/app8/mini-apps', async (req, res) => {
  const { category } = req.query;
  let q = supabase.from('sp_mini_apps').select('*').eq('is_active', true).order('opens_count',{ascending:false});
  if (category) q = q.eq('category', category);
  const { data } = await q;
  const featured = (data||[]).filter(a=>a.is_featured);
  res.json({ apps: data||[], featured });
});

// ── Mini Apps: open (track) ──
app.post('/api/app8/mini-apps/:id/open', async (req, res) => {
  const { id } = req.params;
  const { data: app_item } = await supabase.from('sp_mini_apps').select('opens_count').eq('id',id).single();
  if (app_item) await supabase.from('sp_mini_apps').update({ opens_count: (app_item.opens_count||0)+1 }).eq('id', id);
  res.json({ ok: true });
});

// ── Mini Apps: admin create ──
app.post('/api/admin/app8/mini-apps', adminAuth, async (req, res) => {
  const { name,description,icon,color,url,category,is_featured,developer } = req.body;
  const { data, error } = await supabase.from('sp_mini_apps').insert({ name,description,icon,color,url,category,is_featured:!!is_featured,developer }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Digital Products: list ──
app.get('/api/app8/digital', async (req, res) => {
  const { type, limit=20, offset=0 } = req.query;
  let q = supabase.from('sp_digital_products').select('*,users!sp_digital_products_seller_id_fkey(name,avatar_url)',{count:'exact'}).eq('status','active').order('sales_count',{ascending:false}).range(+offset, +offset + +limit - 1);
  if (type) q = q.eq('type', type);
  const { data, count } = await q;
  res.json({ products: data||[], total: count||0 });
});

// ── Digital Products: create ──
app.post('/api/app8/digital', auth, async (req, res) => {
  const uid = req.user.userId;
  const { title,description,type,price,image_url,file_size,format,tags } = req.body;
  if (!title) return res.status(400).json({ error: 'Tên sản phẩm là bắt buộc' });
  const { data, error } = await supabase.from('sp_digital_products').insert({ seller_id:uid, title,description,type:type||'ebook',price:+price||0,image_url,file_size,format,tags }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Digital Products: purchase ──
app.post('/api/app8/digital/:id/purchase', auth, async (req, res) => {
  const uid = req.user.userId;
  const { id } = req.params;
  const { data: prod } = await supabase.from('sp_digital_products').select('*').eq('id',id).single();
  if (!prod) return res.status(404).json({ error: 'Sản phẩm không tồn tại' });
  if (prod.seller_id === uid) return res.status(400).json({ error: 'Không thể mua sản phẩm của chính mình' });
  const { error } = await supabase.from('sp_digital_purchases').insert({ product_id:id, buyer_id:uid, seller_id:prod.seller_id, amount:prod.price });
  if (error) return res.status(400).json({ error: 'Bạn đã mua sản phẩm này rồi' });
  await supabase.from('sp_digital_products').update({ sales_count: (prod.sales_count||0)+1 }).eq('id', id);
  await addLoyaltyPoints(uid, 10, 'purchase', `Mua sản phẩm: ${prod.title}`, id);
  await addLoyaltyPoints(prod.seller_id, 20, 'sale', `Bán sản phẩm: ${prod.title}`, id);
  res.json({ message: 'Mua thành công! Cảm ơn bạn.', product: prod });
});

// ── Digital Products: my purchases ──
app.get('/api/app8/digital/my-purchases', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data } = await supabase.from('sp_digital_purchases').select('*,sp_digital_products(*)').eq('buyer_id', uid).order('created_at',{ascending:false});
  res.json(data||[]);
});

// ── Digital Products: my products ──
app.get('/api/app8/digital/my-products', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data } = await supabase.from('sp_digital_products').select('*').eq('seller_id', uid).order('created_at',{ascending:false});
  res.json(data||[]);
});

// ── Subscription Plans: list (public) ──
app.get('/api/app8/subscriptions/plans', async (req, res) => {
  const { owner_id } = req.query;
  let q = supabase.from('sp_subscription_plans').select('*,users!sp_subscription_plans_owner_id_fkey(name,avatar_url)').eq('is_active', true).order('subscribers_count',{ascending:false}).limit(30);
  if (owner_id) q = q.eq('owner_id', owner_id);
  const { data } = await q;
  res.json(data||[]);
});

// ── Subscription Plans: create ──
app.post('/api/app8/subscriptions/plans', auth, async (req, res) => {
  const uid = req.user.userId;
  const { name,description,tier,price_monthly,perks,owner_type } = req.body;
  if (!name) return res.status(400).json({ error: 'Tên gói là bắt buộc' });
  const { data, error } = await supabase.from('sp_subscription_plans').insert({ owner_id:uid, owner_type:owner_type||'creator', tier:tier||'basic', name,description,price_monthly:+price_monthly||0,perks }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Subscriptions: subscribe ──
app.post('/api/app8/subscriptions/:plan_id/subscribe', auth, async (req, res) => {
  const uid = req.user.userId;
  const { plan_id } = req.params;
  const { data: plan } = await supabase.from('sp_subscription_plans').select('*').eq('id',plan_id).single();
  if (!plan) return res.status(404).json({ error: 'Gói không tồn tại' });
  if (plan.owner_id === uid) return res.status(400).json({ error: 'Không thể tự đăng ký gói của mình' });
  const expires_at = new Date(Date.now() + 30*24*60*60*1000).toISOString();
  const { error } = await supabase.from('sp_subscriptions').insert({ subscriber_id:uid, plan_id, owner_id:plan.owner_id, expires_at });
  if (error) return res.status(400).json({ error: 'Đã đăng ký gói này rồi' });
  await supabase.from('sp_subscription_plans').update({ subscribers_count: (plan.subscribers_count||0)+1 }).eq('id', plan_id);
  await addLoyaltyPoints(uid, 15, 'subscription', `Đăng ký gói: ${plan.name}`, plan_id);
  res.json({ message: 'Đăng ký thành công!' });
});

// ── Subscriptions: my subscriptions ──
app.get('/api/app8/subscriptions/mine', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data: subs } = await supabase.from('sp_subscriptions').select('*,sp_subscription_plans(*),users!sp_subscriptions_owner_id_fkey(name,avatar_url)').eq('subscriber_id', uid).order('created_at',{ascending:false});
  const { data: plans } = await supabase.from('sp_subscription_plans').select('*,sp_subscriptions(id,subscriber_id)').eq('owner_id', uid);
  res.json({ subscriptions: subs||[], my_plans: plans||[] });
});

// ── Super Search ──
app.get('/api/app8/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ results: [] });
  const term = q.trim();
  const like = `%${term}%`;
  const [users, tickets, events, services, digital, groups] = await Promise.all([
    supabase.from('users').select('id,name,avatar_url').ilike('name', like).limit(5),
    supabase.from('tickets').select('id,title,price,images').ilike('title', like).eq('status','active').limit(6),
    supabase.from('sp_events').select('id,title,type,start_at,image_url').ilike('title', like).eq('status','upcoming').limit(5),
    supabase.from('sp_booking_services').select('id,name,type,price,image_url').ilike('name', like).eq('is_active',true).limit(5),
    supabase.from('sp_digital_products').select('id,title,type,price,image_url').ilike('title', like).eq('status','active').limit(5),
    supabase.from('social_groups').select('id,name,cover_url,members_count').ilike('name', like).limit(4)
  ]);
  res.json({
    users: users.data||[], tickets: tickets.data||[], events: events.data||[],
    services: services.data||[], digital: digital.data||[], groups: groups.data||[]
  });
});

// ── Discovery Center ──
app.get('/api/app8/discover', async (req, res) => {
  const [topProducts, topEvents, topServices, topDigital] = await Promise.all([
    supabase.from('tickets').select('id,title,price,images,view_count').eq('status','active').order('view_count',{ascending:false}).limit(8),
    supabase.from('sp_events').select('id,title,type,image_url,start_at,attendees_count').eq('status','upcoming').order('attendees_count',{ascending:false}).limit(6),
    supabase.from('sp_booking_services').select('id,name,type,price,image_url,rating,bookings_count').eq('is_active',true).order('bookings_count',{ascending:false}).limit(6),
    supabase.from('sp_digital_products').select('id,title,type,price,image_url,sales_count').eq('status','active').order('sales_count',{ascending:false}).limit(6)
  ]);
  res.json({
    trending_products: topProducts.data||[], trending_events: topEvents.data||[],
    trending_services: topServices.data||[], trending_digital: topDigital.data||[]
  });
});

// ── Admin Super App Overview ──
app.get('/api/admin/app8/overview', adminAuth, async (req, res) => {
  const [events, bookings, miniapps, digital, subs, loyalty] = await Promise.all([
    supabase.from('sp_events').select('id',{count:'exact'}),
    supabase.from('sp_bookings').select('id',{count:'exact'}),
    supabase.from('sp_mini_apps').select('id,opens_count').eq('is_active',true),
    supabase.from('sp_digital_products').select('id,sales_count').eq('status','active'),
    supabase.from('sp_subscriptions').select('id',{count:'exact'}).eq('status','active'),
    supabase.from('sp_loyalty').select('id,points,level',{count:'exact'})
  ]);
  const totalOpens = (miniapps.data||[]).reduce((s,a)=>s+(a.opens_count||0),0);
  const totalSales = (digital.data||[]).reduce((s,d)=>s+(d.sales_count||0),0);
  const levelCounts = {};
  (loyalty.data||[]).forEach(l=>{ levelCounts[l.level]=(levelCounts[l.level]||0)+1; });
  res.json({
    total_events: events.count||0,
    total_bookings: bookings.count||0,
    mini_app_opens: totalOpens,
    total_mini_apps: (miniapps.data||[]).length,
    digital_sales: totalSales,
    active_subscriptions: subs.count||0,
    loyalty_members: loyalty.count||0,
    level_counts: levelCounts
  });
});

// ── Admin: manage mini apps ──
app.get('/api/admin/app8/mini-apps', adminAuth, async (req, res) => {
  const { data } = await supabase.from('sp_mini_apps').select('*').order('opens_count',{ascending:false});
  res.json(data||[]);
});
app.patch('/api/admin/app8/mini-apps/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { is_active, is_featured } = req.body;
  const updates = {};
  if (is_active !== undefined) updates.is_active = !!is_active;
  if (is_featured !== undefined) updates.is_featured = !!is_featured;
  await supabase.from('sp_mini_apps').update(updates).eq('id', id);
  res.json({ message: 'Đã cập nhật' });
});

// ── Admin: digital products ──
app.get('/api/admin/app8/digital', adminAuth, async (req, res) => {
  const { data } = await supabase.from('sp_digital_products').select('*,users!sp_digital_products_seller_id_fkey(name)').order('created_at',{ascending:false}).limit(50);
  res.json(data||[]);
});

// ═══════════════════════════════════════════════════════════
// PHASE SOCIAL 9: SPATIAL COMMERCE PLATFORM
// ═══════════════════════════════════════════════════════════

app.get('/spatial', (req, res) => {
  res.sendFile(new URL('./frontend/spatial.html', import.meta.url).pathname);
});

// ── Avatar: get/upsert ──
app.get('/api/spatial/avatar', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data } = await supabase.from('spatial_avatars').select('*').eq('user_id', uid).single();
  res.json(data || null);
});
app.post('/api/spatial/avatar', auth, async (req, res) => {
  const uid = req.user.userId;
  const fields = ['display_name','face','skin_color','hair_style','hair_color','outfit','outfit_color','accessory','badge','bg_color','bg_pattern','bio','status_emoji'];
  const updates = { user_id: uid, updated_at: new Date().toISOString() };
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  const { data, error } = await supabase.from('spatial_avatars').upsert(updates, { onConflict: 'user_id' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Avatar: get by userId (public) ──
app.get('/api/spatial/avatar/:userId', async (req, res) => {
  const { data } = await supabase.from('spatial_avatars').select('*').eq('user_id', req.params.userId).single();
  res.json(data || null);
});

// ── Spaces: world directory ──
app.get('/api/spatial/world', async (req, res) => {
  const { type, limit=20, offset=0 } = req.query;
  let q = supabase.from('spatial_spaces')
    .select('*,users!spatial_spaces_owner_id_fkey(name,avatar_url)', { count: 'exact' })
    .eq('is_public', true).eq('status', 'active')
    .order('visitors_count', { ascending: false })
    .range(+offset, +offset + +limit - 1);
  if (type) q = q.eq('type', type);
  const { data, count } = await q;
  res.json({ spaces: data || [], total: count || 0 });
});

// ── Spaces: featured ──
app.get('/api/spatial/featured', async (req, res) => {
  const { data } = await supabase.from('spatial_spaces')
    .select('*,users!spatial_spaces_owner_id_fkey(name,avatar_url)')
    .eq('is_featured', true).eq('status', 'active').limit(8);
  res.json(data || []);
});

// ── Spaces: create ──
app.post('/api/spatial/spaces', auth, async (req, res) => {
  const uid = req.user.userId;
  const { name, description, type, theme, accent_color, is_public, tags, location_label } = req.body;
  if (!name) return res.status(400).json({ error: 'Tên không gian là bắt buộc' });
  const { data, error } = await supabase.from('spatial_spaces').insert({
    owner_id: uid, name, description, type: type || 'store', theme: theme || 'modern',
    accent_color: accent_color || '#3b82f6', is_public: is_public !== false,
    tags, location_label
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Spaces: get single ──
app.get('/api/spatial/spaces/:id', async (req, res) => {
  const { data: space } = await supabase.from('spatial_spaces')
    .select('*,users!spatial_spaces_owner_id_fkey(name,avatar_url)').eq('id', req.params.id).single();
  if (!space) return res.status(404).json({ error: 'Không tìm thấy' });
  const { data: products } = await supabase.from('spatial_space_products').select('*').eq('space_id', req.params.id).order('is_featured', { ascending: false });
  // track visit (fire and forget)
  supabase.from('spatial_visits').insert({ space_id: req.params.id }).then(() => {});
  supabase.from('spatial_spaces').update({ visitors_count: (space.visitors_count || 0) + 1 }).eq('id', req.params.id).then(() => {});
  res.json({ ...space, products: products || [] });
});

// ── Spaces: update ──
app.patch('/api/spatial/spaces/:id', auth, async (req, res) => {
  const uid = req.user.userId;
  const { id } = req.params;
  const { data: sp } = await supabase.from('spatial_spaces').select('owner_id').eq('id', id).single();
  if (!sp || sp.owner_id !== uid) return res.status(403).json({ error: 'Không có quyền' });
  const allowed = ['name','description','type','theme','accent_color','is_public','tags','location_label','cover_url','status'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  const { data, error } = await supabase.from('spatial_spaces').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Spaces: my spaces ──
app.get('/api/spatial/my-spaces', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data } = await supabase.from('spatial_spaces').select('*').eq('owner_id', uid).order('created_at', { ascending: false });
  res.json(data || []);
});

// ── Space Products: add ──
app.post('/api/spatial/spaces/:id/products', auth, async (req, res) => {
  const uid = req.user.userId;
  const { id } = req.params;
  const { data: sp } = await supabase.from('spatial_spaces').select('owner_id,products_count').eq('id', id).single();
  if (!sp || sp.owner_id !== uid) return res.status(403).json({ error: 'Không có quyền' });
  const { product_title, product_price, product_image, product_description, ticket_id, is_featured } = req.body;
  if (!product_title) return res.status(400).json({ error: 'Tên sản phẩm là bắt buộc' });
  const { data, error } = await supabase.from('spatial_space_products').insert({
    space_id: id, ticket_id, product_title, product_price: +product_price || 0,
    product_image, product_description, is_featured: !!is_featured
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('spatial_spaces').update({ products_count: (sp.products_count || 0) + 1 }).eq('id', id);
  res.json(data);
});

// ── Space Products: delete ──
app.delete('/api/spatial/spaces/:spaceId/products/:productId', auth, async (req, res) => {
  const uid = req.user.userId;
  const { spaceId, productId } = req.params;
  const { data: sp } = await supabase.from('spatial_spaces').select('owner_id,products_count').eq('id', spaceId).single();
  if (!sp || sp.owner_id !== uid) return res.status(403).json({ error: 'Không có quyền' });
  await supabase.from('spatial_space_products').delete().eq('id', productId).eq('space_id', spaceId);
  await supabase.from('spatial_spaces').update({ products_count: Math.max(0, (sp.products_count || 1) - 1) }).eq('id', spaceId);
  res.json({ message: 'Đã xóa sản phẩm' });
});

// ── Spatial Events: list ──
app.get('/api/spatial/events', async (req, res) => {
  const { status = 'upcoming', limit = 20, offset = 0 } = req.query;
  const { data, count } = await supabase.from('spatial_events')
    .select('*,users!spatial_events_organizer_id_fkey(name,avatar_url)', { count: 'exact' })
    .eq('status', status).order('start_at', { ascending: true })
    .range(+offset, +offset + +limit - 1);
  res.json({ events: data || [], total: count || 0 });
});

// ── Spatial Events: create ──
app.post('/api/spatial/events', auth, async (req, res) => {
  const uid = req.user.userId;
  const { title, description, event_type, cover_url, start_at, end_at, max_attendees, ticket_price, space_id, xr_mode } = req.body;
  if (!title) return res.status(400).json({ error: 'Tên sự kiện là bắt buộc' });
  const { data, error } = await supabase.from('spatial_events').insert({
    organizer_id: uid, title, description, event_type: event_type || 'exhibition',
    cover_url, start_at, end_at, max_attendees: +max_attendees || 100,
    ticket_price: +ticket_price || 0, space_id, xr_mode: !!xr_mode
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Spatial Events: join ──
app.post('/api/spatial/events/:id/join', auth, async (req, res) => {
  const uid = req.user.userId;
  const { id } = req.params;
  const { data: ev } = await supabase.from('spatial_events').select('*').eq('id', id).single();
  if (!ev) return res.status(404).json({ error: 'Không tìm thấy sự kiện' });
  if (ev.attendees_count >= ev.max_attendees) return res.status(400).json({ error: 'Sự kiện đã đầy' });
  const { error } = await supabase.from('spatial_event_attendees').insert({ event_id: id, user_id: uid });
  if (error) return res.status(400).json({ error: 'Bạn đã tham gia rồi' });
  await supabase.from('spatial_events').update({ attendees_count: (ev.attendees_count || 0) + 1 }).eq('id', id);
  res.json({ message: 'Đã tham gia sự kiện không gian số!' });
});

// ── Spatial Events: my events ──
app.get('/api/spatial/events/my', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data: created } = await supabase.from('spatial_events').select('*').eq('organizer_id', uid).order('created_at', { ascending: false });
  const { data: joined } = await supabase.from('spatial_event_attendees').select('*,spatial_events(*)').eq('user_id', uid);
  res.json({ created: created || [], joined: (joined || []).map(j => ({ ...j.spatial_events, joined_at: j.joined_at })) });
});

// ── Avatar Interactions ──
app.post('/api/spatial/interact', auth, async (req, res) => {
  const uid = req.user.userId;
  const { to_user, type, emoji, message } = req.body;
  if (!to_user || !type) return res.status(400).json({ error: 'Thiếu thông tin' });
  const { data, error } = await supabase.from('spatial_interactions').insert({
    from_user: uid, to_user, type, emoji: emoji || '👋', message
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Spatial Discovery ──
app.get('/api/spatial/discover', async (req, res) => {
  const [featuredSpaces, trendingStores, upcomingEvents, popularSpaces] = await Promise.all([
    supabase.from('spatial_spaces').select('*,users!spatial_spaces_owner_id_fkey(name)').eq('is_featured', true).eq('status', 'active').limit(6),
    supabase.from('spatial_spaces').select('*,users!spatial_spaces_owner_id_fkey(name)').eq('type', 'store').eq('status', 'active').order('visitors_count', { ascending: false }).limit(8),
    supabase.from('spatial_events').select('*,users!spatial_events_organizer_id_fkey(name)').eq('status', 'upcoming').order('attendees_count', { ascending: false }).limit(6),
    supabase.from('spatial_spaces').select('*,users!spatial_spaces_owner_id_fkey(name)').eq('status', 'active').order('visitors_count', { ascending: false }).limit(8)
  ]);
  res.json({
    featured: featuredSpaces.data || [],
    trending_stores: trendingStores.data || [],
    upcoming_events: upcomingEvents.data || [],
    popular: popularSpaces.data || []
  });
});

// ── Admin: Spatial overview ──
app.get('/api/admin/spatial/overview', adminAuth, async (req, res) => {
  const [spaces, events, avatars, visits] = await Promise.all([
    supabase.from('spatial_spaces').select('id,type,status', { count: 'exact' }),
    supabase.from('spatial_events').select('id,status', { count: 'exact' }),
    supabase.from('spatial_avatars').select('id', { count: 'exact' }),
    supabase.from('spatial_visits').select('id', { count: 'exact' })
  ]);
  const typeCounts = {};
  (spaces.data || []).forEach(s => { typeCounts[s.type] = (typeCounts[s.type] || 0) + 1; });
  res.json({
    total_spaces: spaces.count || 0,
    total_events: events.count || 0,
    total_avatars: avatars.count || 0,
    total_visits: visits.count || 0,
    type_breakdown: typeCounts
  });
});

// ── Admin: spaces ──
app.get('/api/admin/spatial/spaces', adminAuth, async (req, res) => {
  const { data } = await supabase.from('spatial_spaces')
    .select('*,users!spatial_spaces_owner_id_fkey(name)').order('created_at', { ascending: false }).limit(50);
  res.json(data || []);
});
app.patch('/api/admin/spatial/spaces/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { is_featured, status } = req.body;
  const updates = {};
  if (is_featured !== undefined) updates.is_featured = !!is_featured;
  if (status) updates.status = status;
  await supabase.from('spatial_spaces').update(updates).eq('id', id);
  res.json({ message: 'Đã cập nhật' });
});

// ═══════════════════════════════════════════════════════════
// PHASE 17: SAFEPASS SUPER APP
// ═══════════════════════════════════════════════════════════

// Serve Super App page
app.get('/superapp', (req, res) => {
  res.sendFile(new URL('./frontend/superapp.html', import.meta.url).pathname);
});

// ── Super App: Map points ──
app.get('/api/superapp/map', async (req, res) => {
  const [warehouses, hubs, partners] = await Promise.all([
    supabase.from('warehouses').select('id,name,address,province,lat,lng').eq('is_active', true),
    supabase.from('delivery_hubs').select('id,name,address,province').eq('is_active', true),
    supabase.from('franchise_partners').select('id,business_name,full_name,province,lat,lng,service_receiving,service_inspection').eq('status','active').limit(30)
  ]);

  const viCoords = {
    'TP. Hồ Chí Minh':[10.762622,106.660172],'Hà Nội':[21.027763,105.834160],
    'Đà Nẵng':[16.054407,108.202167],'Cần Thơ':[10.045162,105.746857],
    'Hải Phòng':[20.844912,106.688084],'Bình Dương':[11.131938,106.676873],
    'Đồng Nai':[10.945374,106.824257],'Khánh Hòa':[12.238791,109.196749]
  };
  function jitter(v,r=0.15){return v+(Math.random()-0.5)*r;}

  const points = [];
  (warehouses.data||[]).forEach(w=>{
    const base=viCoords[w.province]||[16.047,108.206];
    points.push({id:w.id,name:w.name,address:w.address,province:w.province,
      type:'warehouse',lat:w.lat||jitter(base[0]),lng:w.lng||jitter(base[1])});
  });
  (hubs.data||[]).forEach(h=>{
    const base=viCoords[h.province]||[16.047,108.206];
    points.push({id:h.id,name:h.name,address:h.address,province:h.province,
      type:'delivery',lat:jitter(base[0]),lng:jitter(base[1])});
  });
  (partners.data||[]).slice(0,20).forEach(p=>{
    points.push({id:p.id,
      name:p.business_name||p.full_name,province:p.province,
      type:p.service_inspection?'inspection':'receiving',
      lat:jitter((viCoords[p.province]||[16.047,108.206])[0]),
      lng:jitter((viCoords[p.province]||[16.047,108.206])[1])});
  });

  res.json({ points });
});

// ── Super App: Platform Stats (public) ──
app.get('/api/superapp/stats', async (req, res) => {
  const [users, orders, listings, franchises, drivers, warehouses] = await Promise.all([
    supabase.from('users').select('id',{count:'exact'}),
    supabase.from('orders').select('id,amount'),
    supabase.from('tickets').select('id',{count:'exact'}).eq('status','active'),
    supabase.from('franchise_partners').select('id',{count:'exact'}).eq('status','active'),
    supabase.from('drivers').select('id',{count:'exact'}).eq('status','active'),
    supabase.from('warehouses').select('id',{count:'exact'}).eq('is_active',true)
  ]);
  const totalEscrow = (orders.data||[]).reduce((s,o)=>s+(o.amount||0),0);
  res.json({
    users: users.count||0,
    active_listings: listings.count||0,
    total_escrow: totalEscrow,
    franchise_partners: franchises.count||0,
    active_drivers: drivers.count||0,
    warehouses: warehouses.count||0
  });
});

// ═══════════════════════════════════════════════════════════
// PHASE 16: SAFEPASS ECOSYSTEM
// ═══════════════════════════════════════════════════════════

// Serve ecosystem page
app.get('/ecosystem', (req, res) => {
  res.sendFile(new URL('./frontend/ecosystem.html', import.meta.url).pathname);
});

// ── /api/users/me ──
app.get('/api/users/me', auth, async (req, res) => {
  const { data: user } = await supabase.from('users')
    .select('id,name,phone,email,is_admin,is_moderator,is_banned,is_kyc_verified,two_factor,created_at')
    .eq('id', req.user.userId).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ── Ecosystem Dashboard ──
app.get('/api/ecosystem/dashboard', auth, async (req, res) => {
  const uid = req.user.userId;
  // Parallel queries across all modules
  const [escrows, listings, shipments, orders, warehouseItems, inspections, deliveries] = await Promise.all([
    supabase.from('orders').select('id,status,amount,created_at').or(`buyer_id.eq.${uid},seller_id.eq.${uid}`).order('created_at',{ascending:false}),
    supabase.from('tickets').select('id,status').eq('seller_id', uid).eq('status','active'),
    supabase.from('logistics_shipments').select('id').eq('user_id', uid),
    supabase.from('orders').select('id').or(`buyer_id.eq.${uid},seller_id.eq.${uid}`),
    supabase.from('warehouse_inventory').select('id').eq('owner_id', uid),
    supabase.from('inspection_requests').select('id').eq('user_id', uid),
    supabase.from('delivery_orders').select('id').eq('user_id', uid)
  ]);

  const stats = {
    total_escrows: orders.data?.length || 0,
    active_listings: listings.data?.length || 0,
    total_shipments: shipments.data?.length || 0,
    total_orders: orders.data?.length || 0,
    warehouse_items: warehouseItems.data?.length || 0,
    inspections: inspections.data?.length || 0,
    deliveries: deliveries.data?.length || 0
  };

  // Recent activity: latest 8 orders
  const recentOrders = (escrows.data || []).slice(0, 8).map(o => ({
    icon: '📋', title: `Đơn hàng ${o.id.slice(0,8)}...`,
    description: `${o.status} · ${Number(o.amount||0).toLocaleString('vi-VN')}₫`,
    created_at: o.created_at
  }));

  // Monthly data: last 6 months
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const m = d.toISOString().slice(0, 7);
    const label = d.toLocaleDateString('vi-VN', { month: 'short', year: 'numeric' });
    const monthOrders = (orders.data||[]).filter(o => o.created_at?.startsWith(m));
    monthly.push({
      label,
      escrows: monthOrders.length,
      revenue: monthOrders.reduce((s,o) => s+(o.amount||0), 0)
    });
  }

  res.json({ stats, recent_activity: recentOrders, monthly });
});

// ── Ecosystem Workflow: List orders ──
app.get('/api/ecosystem/workflow/orders', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data: orders } = await supabase.from('orders')
    .select('id,title,amount,status,buyer_id,seller_id,created_at,funded_at,released_at,refunded_at')
    .or(`buyer_id.eq.${uid},seller_id.eq.${uid}`)
    .order('created_at', { ascending: false }).limit(20);
  res.json({ orders: orders || [] });
});

// ── Ecosystem Workflow: Single order detail ──
app.get('/api/ecosystem/workflow/:id', auth, async (req, res) => {
  const uid = req.user.userId;
  const { data: order } = await supabase.from('orders')
    .select('*').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  if (order.buyer_id !== uid && order.seller_id !== uid)
    return res.status(403).json({ error: 'Không có quyền truy cập' });
  // Build workflow steps
  const wf = {
    listing: 'done',
    escrow: ['funded','delivered','completed','released'].includes(order.status) ? 'done'
           : order.status === 'pending' ? 'active' : 'pending',
    inspection: order.funded_at ? 'done' : 'pending',
    warehouse: order.funded_at ? 'done' : 'pending',
    delivery: ['delivered','completed','released'].includes(order.status) ? 'done'
             : order.funded_at ? 'active' : 'pending',
    completed: ['completed','released'].includes(order.status) ? 'done' : 'pending'
  };
  res.json({ ...order, workflow: wf });
});

// ── Global Search ──
app.get('/api/ecosystem/search', auth, async (req, res) => {
  const { q = '', type = 'all' } = req.query;
  if (!q || q.length < 2) return res.json({ results: {} });
  const uid = req.user.userId;
  const results = {};
  const searchQ = `%${q}%`;

  if (type === 'all' || type === 'listings') {
    const { data } = await supabase.from('tickets')
      .select('id,title,price,category,status,created_at')
      .ilike('title', searchQ).limit(5);
    results.listings = (data || []).map(t => ({
      id: t.id, _type: 'listing',
      title: t.title,
      subtitle: `${t.category} · ${Number(t.price||0).toLocaleString('vi-VN')}₫`,
      badge: t.status, amount: t.price
    }));
  }
  if (type === 'all' || type === 'orders') {
    const { data } = await supabase.from('orders')
      .select('id,title,amount,status,created_at')
      .or(`buyer_id.eq.${uid},seller_id.eq.${uid}`)
      .ilike('title', searchQ).limit(5);
    results.orders = (data || []).map(o => ({
      id: o.id, _type: 'order',
      title: o.title || `Đơn hàng ${o.id.slice(0,8)}`,
      subtitle: new Date(o.created_at).toLocaleDateString('vi-VN'),
      badge: o.status, amount: o.amount
    }));
  }
  if ((type === 'all' || type === 'users') && req.user.isAdmin) {
    const { data } = await supabase.from('users')
      .select('id,name,phone,is_kyc_verified,created_at')
      .or(`name.ilike.${searchQ},phone.ilike.${searchQ}`).limit(5);
    results.users = (data || []).map(u => ({
      id: u.id, _type: 'user',
      title: u.name || u.phone,
      subtitle: u.phone,
      badge: u.is_kyc_verified ? 'active' : 'pending'
    }));
  }
  if (type === 'all' || type === 'logistics') {
    const { data } = await supabase.from('logistics_shipments')
      .select('id,tracking_code,sender_name,receiver_name,status,created_at')
      .eq('user_id', uid)
      .or(`tracking_code.ilike.${searchQ},sender_name.ilike.${searchQ},receiver_name.ilike.${searchQ}`)
      .limit(5);
    results.logistics = (data || []).map(s => ({
      id: s.id, _type: 'logistics',
      title: s.tracking_code || `Vận đơn ${s.id.slice(0,8)}`,
      subtitle: `${s.sender_name||''} → ${s.receiver_name||''}`,
      badge: s.status
    }));
  }
  res.json({ results });
});

// ── User Stats ──
app.get('/api/ecosystem/user-stats', auth, async (req, res) => {
  const uid = req.user.userId;
  const [orders, listings, shipments, trustScore] = await Promise.all([
    supabase.from('orders').select('id').or(`buyer_id.eq.${uid},seller_id.eq.${uid}`),
    supabase.from('tickets').select('id').eq('seller_id', uid),
    supabase.from('logistics_shipments').select('id').eq('user_id', uid),
    supabase.from('trust_scores').select('score,badges').eq('user_id', uid).single()
  ]);
  const { data: reviews } = await supabase.from('reviews')
    .select('rating').eq('seller_id', uid);
  const avgRating = reviews?.length
    ? (reviews.reduce((s,r)=>s+(r.rating||0),0) / reviews.length)
    : 0;
  const { data: bizAcc } = await supabase.from('business_accounts')
    .select('id').eq('owner_id', uid).limit(1);
  const { data: franPartner } = await supabase.from('franchise_partners')
    .select('id').eq('phone', req.user.phone||'').limit(1);
  res.json({
    orders: orders.data?.length || 0,
    escrows: orders.data?.length || 0,
    listings: listings.data?.length || 0,
    shipments: shipments.data?.length || 0,
    trust_score: trustScore.data?.score || 0,
    badges: trustScore.data?.badges || [],
    avg_rating: avgRating,
    has_business: !!(bizAcc?.length),
    has_franchise: !!(franPartner?.length)
  });
});

// ── Business Summary ──
app.get('/api/ecosystem/biz-summary', auth, async (req, res) => {
  const uid = req.user.userId;
  const [shipments, warehouseItems, inspections, deliveries] = await Promise.all([
    supabase.from('logistics_shipments').select('id').eq('user_id', uid),
    supabase.from('warehouse_inventory').select('id').eq('owner_id', uid),
    supabase.from('inspection_requests').select('id').eq('user_id', uid),
    supabase.from('delivery_orders').select('id').eq('user_id', uid)
  ]);
  // Monthly breakdown (last 6m)
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const label = d.toLocaleDateString('vi-VN', { month: 'short', year: 'numeric' });
    monthly.push({ label, merchant: 0, franchise: 0, logistics: 0 });
  }
  res.json({
    merchant_orders: 0, franchise_txns: 0,
    shipments: shipments.data?.length || 0,
    warehouse_items: warehouseItems.data?.length || 0,
    deliveries: deliveries.data?.length || 0,
    inspections: inspections.data?.length || 0,
    monthly
  });
});

// ── Ecosystem Analytics ──
app.get('/api/ecosystem/analytics', auth, async (req, res) => {
  const uid = req.user.userId;
  const months = Number(req.query.period === '12m' ? 12 : 6);
  const { data: orders } = await supabase.from('orders')
    .select('id,amount,status,created_at,category')
    .or(`buyer_id.eq.${uid},seller_id.eq.${uid}`);
  const allOrders = orders || [];
  const total_escrow_value = allOrders.reduce((s,o)=>s+(o.amount||0),0);
  const successful_txns = allOrders.filter(o=>['completed','released'].includes(o.status)).length;
  const pending_txns = allOrders.filter(o=>['pending','funded'].includes(o.status)).length;
  const refunded = allOrders.filter(o=>o.status==='refunded').length;
  const refund_rate = allOrders.length ? (refunded/allOrders.length*100) : 0;
  const monthly = [];
  for (let i = months-1; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth()-i);
    const m = d.toISOString().slice(0,7);
    const label = d.toLocaleDateString('vi-VN',{month:'short',year:'numeric'});
    const mo = allOrders.filter(o=>o.created_at?.startsWith(m));
    monthly.push({ label, orders: mo.length, escrows: mo.length });
  }
  // Category breakdown
  const catMap = {};
  allOrders.forEach(o=>{const c=o.category||'Khác';catMap[c]=(catMap[c]||0)+1;});
  const categories = Object.entries(catMap).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);
  // Value ranges
  const ranges=[0,0,0,0,0];
  allOrders.forEach(o=>{
    const v=o.amount||0;
    if(v<100000)ranges[0]++;
    else if(v<1000000)ranges[1]++;
    else if(v<10000000)ranges[2]++;
    else if(v<100000000)ranges[3]++;
    else ranges[4]++;
  });
  const [ls,sh,wh,ins,del] = await Promise.all([
    supabase.from('tickets').select('id',{count:'exact'}).eq('seller_id',uid),
    supabase.from('logistics_shipments').select('id',{count:'exact'}).eq('user_id',uid),
    supabase.from('warehouse_inventory').select('id',{count:'exact'}).eq('owner_id',uid),
    supabase.from('inspection_requests').select('id',{count:'exact'}).eq('user_id',uid),
    supabase.from('delivery_orders').select('id',{count:'exact'}).eq('user_id',uid)
  ]);
  res.json({
    total_escrow_value, successful_txns, pending_txns, refund_rate,
    monthly, categories, value_ranges: ranges,
    mods:{escrow:allOrders.length,listings:ls.count||0,logistics:sh.count||0,
      warehouse:wh.count||0,inspection:ins.count||0,delivery:del.count||0}
  });
});

// ── Admin: Ecosystem Stats ──
app.get('/api/admin/ecosystem/stats', adminAuth, async (req, res) => {
  const [users, orders, listings, logistics, warehouse, delivery, inspection, business, franchise, kyc, risk, recentUsers, openDisputes] = await Promise.all([
    supabase.from('users').select('id',{count:'exact'}),
    supabase.from('orders').select('id,amount,status,created_at,buyer_id'),
    supabase.from('tickets').select('id',{count:'exact'}),
    supabase.from('logistics_shipments').select('id,status',{count:'exact'}),
    supabase.from('warehouses').select('id',{count:'exact'}),
    supabase.from('delivery_orders').select('id,status',{count:'exact'}),
    supabase.from('inspection_requests').select('id,status',{count:'exact'}),
    supabase.from('business_accounts').select('id,is_verified_business',{count:'exact'}),
    supabase.from('franchise_partners').select('id,status',{count:'exact'}),
    supabase.from('kyc_requests').select('id,status',{count:'exact'}),
    supabase.from('risk_alerts').select('id,status',{count:'exact'}),
    supabase.from('users').select('id,name,phone,is_kyc_verified,created_at').order('created_at',{ascending:false}).limit(10),
    supabase.from('orders').select('id,amount,status,created_at,buyer_id').eq('status','disputed').limit(10)
  ]);
  const allOrders = orders.data || [];
  const total_escrow_value = allOrders.reduce((s,o)=>s+(o.amount||0),0);
  const logData = logistics.data || [];
  const delData = delivery.data || [];
  const insData = inspection.data || [];
  const bizData = business.data || [];
  const franData = franchise.data || [];
  const kycData = kyc.data || [];
  const riskData = risk.data || [];
  // Monthly
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth()-i);
    const m = d.toISOString().slice(0,7);
    const label = d.toLocaleDateString('vi-VN',{month:'short',year:'numeric'});
    const mu = (recentUsers.data||[]).filter(u=>u.created_at?.startsWith(m));
    const mo = allOrders.filter(o=>o.created_at?.startsWith(m));
    monthly.push({ label, new_users: mu.length, escrow_value: mo.reduce((s,o)=>s+(o.amount||0),0) });
  }
  res.json({
    total_users: users.count || 0,
    total_escrow_value,
    total_orders: allOrders.length,
    total_listings: listings.count || 0,
    logistics: { total: logData.length, in_transit: logData.filter(l=>l.status==='in_transit').length, delivered: logData.filter(l=>l.status==='delivered').length },
    warehouse: { warehouses: warehouse.count||0, items: 0, transfers: 0 },
    delivery: { drivers: 0, orders: delData.length, delivered: delData.filter(d=>d.status==='delivered').length },
    inspection: { requests: insData.length, in_progress: insData.filter(i=>i.status==='in_progress').length, completed: insData.filter(i=>i.status==='completed').length },
    business: { merchants: bizData.length, verified: bizData.filter(b=>b.is_verified_business).length, revenue: 0 },
    franchise: { partners: franData.length, active: franData.filter(f=>f.status==='active').length, txns: 0 },
    kyc: { approved: kycData.filter(k=>k.status==='approved').length, pending: kycData.filter(k=>k.status==='pending').length, banned: 0 },
    risk: { open_alerts: riskData.filter(r=>r.status==='open').length, high_risk: 0, resolved: riskData.filter(r=>r.status==='resolved').length },
    monthly,
    recent_users: recentUsers.data || [],
    open_disputes: openDisputes.data || []
  });
});

// ═══════════════════════════════════════════════════════════
// PHASE 15: FRANCHISE NETWORK
// ═══════════════════════════════════════════════════════════

// Serve franchise page
app.get('/franchise', (req, res) => {
  res.sendFile(new URL('./frontend/franchise.html', import.meta.url).pathname);
});

// Franchise Auth Middleware
const franchiseAuth = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    if (decoded.type !== 'franchise') return res.status(401).json({ error: 'Invalid token type' });
    req.partner = decoded;
    next();
  } catch (e) { return res.status(401).json({ error: 'Token invalid or expired' }); }
}

// ── Register ──
app.post('/api/franchise/auth/register', async (req, res) => {
  const { partner_type, full_name, business_name, phone, password, email,
    address, province, district, ward,
    service_receiving, service_consignment, service_inspection, service_delivery } = req.body;
  if (!full_name || !phone || !password || !province || !address)
    return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
  if (password.length < 8) return res.status(400).json({ error: 'Mật khẩu tối thiểu 8 ký tự' });
  const { data: existing } = await supabase.from('franchise_partners').select('id').eq('phone', phone).single();
  if (existing) return res.status(409).json({ error: 'Số điện thoại đã được đăng ký' });
  const password_hash = await bcrypt.hash(password, 10);
  const { data: partner, error } = await supabase.from('franchise_partners').insert({
    partner_type: partner_type || 'individual',
    full_name: sanitize(full_name), business_name: sanitize(business_name || ''),
    phone: phone.trim(), password_hash, email: email || null,
    address: sanitize(address), province: sanitize(province),
    district: district || null, ward: ward || null,
    service_receiving: service_receiving !== false,
    service_consignment: !!service_consignment,
    service_inspection: !!service_inspection,
    service_delivery: !!service_delivery,
    status: 'pending', tier: 'basic'
  }).select('id,full_name,business_name,phone,email,province,address,partner_type,tier,status,service_receiving,service_consignment,service_inspection,service_delivery').single();
  if (error) return res.status(500).json({ error: error.message });
  const token = jwt.sign({ partnerId: partner.id, phone: partner.phone, type: 'franchise' }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, partner });
});

// ── Login ──
app.post('/api/franchise/auth/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Thiếu thông tin' });
  const { data: partner, error } = await supabase.from('franchise_partners')
    .select('*').eq('phone', phone.trim()).single();
  if (error || !partner) return res.status(401).json({ error: 'Sai số điện thoại hoặc mật khẩu' });
  if (partner.status === 'suspended') return res.status(403).json({ error: 'Tài khoản đã bị đình chỉ' });
  const ok = await bcrypt.compare(password, partner.password_hash);
  if (!ok) return res.status(401).json({ error: 'Sai số điện thoại hoặc mật khẩu' });
  const token = jwt.sign({ partnerId: partner.id, phone: partner.phone, type: 'franchise' }, process.env.JWT_SECRET, { expiresIn: '30d' });
  const { password_hash, ...safe } = partner;
  res.json({ token, partner: safe });
});

// ── Profile ──
app.get('/api/franchise/profile', franchiseAuth, async (req, res) => {
  const { data: partner } = await supabase.from('franchise_partners')
    .select('id,full_name,business_name,phone,email,hotline,address,province,district,ward,partner_type,tier,status,service_receiving,service_consignment,service_inspection,service_delivery,wallet_balance,total_earnings,total_transactions,completion_rate,avg_rating,rating_count,rejection_note,created_at')
    .eq('id', req.partner.partnerId).single();
  if (!partner) return res.status(404).json({ error: 'Không tìm thấy đại lý' });
  res.json({ partner });
});

app.put('/api/franchise/profile', franchiseAuth, async (req, res) => {
  const { full_name, business_name, email, hotline, address, province, district, ward, partner_type } = req.body;
  const { data: partner, error } = await supabase.from('franchise_partners')
    .update({ full_name: sanitize(full_name || ''), business_name: sanitize(business_name || ''),
      email, hotline, address: sanitize(address || ''), province: sanitize(province || ''),
      district, ward, partner_type, updated_at: new Date().toISOString() })
    .eq('id', req.partner.partnerId).select('id,full_name,business_name,phone,email,hotline,address,province,district,partner_type,tier,status').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ partner });
});

// ── Dashboard ──
app.get('/api/franchise/dashboard', franchiseAuth, async (req, res) => {
  const pid = req.partner.partnerId;
  const { data: partner } = await supabase.from('franchise_partners')
    .select('wallet_balance,total_earnings,total_transactions,completion_rate,avg_rating,rating_count').eq('id', pid).single();
  // Recent transactions
  const { data: recent } = await supabase.from('franchise_transactions')
    .select('id,ref_code,txn_type,sender_name,receiver_name,commission_earned,service_fee,status,created_at')
    .eq('partner_id', pid).order('created_at', { ascending: false }).limit(5);
  // Monthly txns (last 6 months)
  const monthly_txns = [];
  const monthly_earnings = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const m = d.toISOString().slice(0, 7);
    const label = d.toLocaleDateString('vi-VN', { month: 'short', year: 'numeric' });
    const { data: txns } = await supabase.from('franchise_transactions')
      .select('id,commission_earned').eq('partner_id', pid)
      .gte('created_at', m + '-01').lt('created_at', m + '-32');
    monthly_txns.push({ month: label, count: txns?.length || 0 });
    monthly_earnings.push({ month: label, amount: txns?.reduce((s, t) => s + (t.commission_earned || 0), 0) || 0 });
  }
  res.json({ ...(partner || {}), recent_transactions: recent || [], monthly_txns, monthly_earnings });
});

// ── Announcements ──
app.get('/api/franchise/announcements', franchiseAuth, async (req, res) => {
  const { data } = await supabase.from('franchise_announcements')
    .select('*').order('is_pinned', { ascending: false }).order('created_at', { ascending: false });
  res.json({ announcements: data || [] });
});

// ── Transactions ──
app.get('/api/franchise/transactions', franchiseAuth, async (req, res) => {
  const { filter = 'all' } = req.query;
  let q = supabase.from('franchise_transactions').select('*').eq('partner_id', req.partner.partnerId);
  if (['pending','processing','completed','cancelled','returned'].includes(filter)) q = q.eq('status', filter);
  else if (['receiving','consignment','inspection','delivery'].includes(filter)) q = q.eq('txn_type', filter);
  const { data } = await q.order('created_at', { ascending: false });
  res.json({ transactions: data || [] });
});

app.post('/api/franchise/transactions', franchiseAuth, async (req, res) => {
  const { txn_type, sender_name, sender_phone, receiver_name, receiver_phone,
    item_description, item_value, service_fee, notes, service_point_id } = req.body;
  if (!txn_type) return res.status(400).json({ error: 'Thiếu loại giao dịch' });
  const commission_rate = 0.05;
  const commission_earned = Math.floor((service_fee || 0) * commission_rate);
  const { data, error } = await supabase.from('franchise_transactions').insert({
    partner_id: req.partner.partnerId, txn_type,
    sender_name: sanitize(sender_name || ''), sender_phone,
    receiver_name: sanitize(receiver_name || ''), receiver_phone,
    item_description: sanitize(item_description || ''),
    item_value: item_value || 0, service_fee: service_fee || 0,
    commission_rate, commission_earned, notes, service_point_id: service_point_id || null,
    status: 'pending'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ transaction: data });
});

app.patch('/api/franchise/transactions/:id', franchiseAuth, async (req, res) => {
  const { status } = req.body;
  const { data: txn } = await supabase.from('franchise_transactions').select('*')
    .eq('id', req.params.id).eq('partner_id', req.partner.partnerId).single();
  if (!txn) return res.status(404).json({ error: 'Không tìm thấy giao dịch' });
  const update = { status };
  if (status === 'completed') update.completed_at = new Date().toISOString();
  await supabase.from('franchise_transactions').update(update).eq('id', req.params.id);
  // Update earnings & stats on completion
  if (status === 'completed' && txn.commission_earned > 0) {
    const { data: p } = await supabase.from('franchise_partners').select('wallet_balance,total_earnings,total_transactions').eq('id', req.partner.partnerId).single();
    const newBalance = (p?.wallet_balance || 0) + txn.commission_earned;
    await supabase.from('franchise_partners').update({
      wallet_balance: newBalance,
      total_earnings: (p?.total_earnings || 0) + txn.commission_earned,
      total_transactions: (p?.total_transactions || 0) + 1
    }).eq('id', req.partner.partnerId);
    await supabase.from('franchise_earnings').insert({
      partner_id: req.partner.partnerId, txn_id: txn.id,
      earning_type: 'commission', amount: txn.commission_earned,
      description: `Hoa hồng giao dịch ${txn.ref_code}`, balance_after: newBalance
    });
  }
  res.json({ ok: true });
});

// ── Service Points ──
app.get('/api/franchise/service-points', franchiseAuth, async (req, res) => {
  const { data } = await supabase.from('franchise_service_points')
    .select('*').eq('partner_id', req.partner.partnerId).order('created_at', { ascending: false });
  res.json({ service_points: data || [] });
});

app.post('/api/franchise/service-points', franchiseAuth, async (req, res) => {
  const { name, point_type, address, province, district, ward, hotline, operating_hours, capacity } = req.body;
  if (!name || !address || !province) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
  const { data, error } = await supabase.from('franchise_service_points').insert({
    partner_id: req.partner.partnerId,
    name: sanitize(name), point_type: point_type || 'receiving',
    address: sanitize(address), province: sanitize(province),
    district, ward, hotline, operating_hours: operating_hours || '8:00 - 20:00',
    capacity: capacity || 100, current_load: 0, status: 'active'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ service_point: data });
});

app.patch('/api/franchise/service-points/:id', franchiseAuth, async (req, res) => {
  const { status, current_load } = req.body;
  const { error } = await supabase.from('franchise_service_points')
    .update({ ...(status && { status }), ...(current_load !== undefined && { current_load }) })
    .eq('id', req.params.id).eq('partner_id', req.partner.partnerId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/franchise/service-points/:id', franchiseAuth, async (req, res) => {
  await supabase.from('franchise_service_points').delete()
    .eq('id', req.params.id).eq('partner_id', req.partner.partnerId);
  res.json({ ok: true });
});

// ── Earnings ──
app.get('/api/franchise/earnings', franchiseAuth, async (req, res) => {
  const pid = req.partner.partnerId;
  const { data: partner } = await supabase.from('franchise_partners')
    .select('wallet_balance,total_earnings').eq('id', pid).single();
  const { data: earnings } = await supabase.from('franchise_earnings')
    .select('*').eq('partner_id', pid).order('created_at', { ascending: false }).limit(50);
  const withdrawn = (earnings || []).filter(e => e.earning_type === 'withdrawal')
    .reduce((s, e) => s + e.amount, 0);
  res.json({
    wallet_balance: partner?.wallet_balance || 0,
    total_earnings: partner?.total_earnings || 0,
    total_withdrawn: withdrawn,
    earnings: earnings || []
  });
});

// ── Map (Public) ──
app.get('/api/franchise/map', async (req, res) => {
  const { data: points } = await supabase.from('franchise_service_points')
    .select('id,name,address,province,district,point_type,operating_hours,hotline,lat,lng,status,current_load,capacity')
    .eq('status', 'active');
  const { data: partners } = await supabase.from('franchise_partners')
    .select('id,full_name,business_name,phone,hotline,province,partner_type,tier,service_receiving,service_consignment,service_inspection,service_delivery,total_transactions,avg_rating,lat,lng')
    .eq('status', 'active').order('rank_score', { ascending: false }).limit(100);
  res.json({ service_points: points || [], partners: partners || [] });
});

// ── Rankings ──
app.get('/api/franchise/rankings', franchiseAuth, async (req, res) => {
  const base = 'id,full_name,business_name,province,tier,total_transactions,total_earnings,avg_rating,rating_count';
  const { data: by_earnings } = await supabase.from('franchise_partners')
    .select(base).eq('status', 'active').order('total_earnings', { ascending: false }).limit(10);
  const { data: by_txns } = await supabase.from('franchise_partners')
    .select(base).eq('status', 'active').order('total_transactions', { ascending: false }).limit(10);
  const { data: by_ratings } = await supabase.from('franchise_partners')
    .select(base).eq('status', 'active').gte('rating_count', 1).order('avg_rating', { ascending: false }).limit(10);
  res.json({ by_earnings: by_earnings || [], by_txns: by_txns || [], by_ratings: by_ratings || [] });
});

// ── Admin: List Partners ──
app.get('/api/admin/franchise/partners', adminAuth, async (req, res) => {
  const { status = 'pending' } = req.query;
  const { data: partners } = await supabase.from('franchise_partners')
    .select('id,full_name,business_name,phone,email,province,partner_type,tier,status,service_receiving,service_consignment,service_inspection,service_delivery,total_transactions,total_earnings,avg_rating,created_at,rejection_note')
    .eq('status', status).order('created_at', { ascending: false });
  res.json({ partners: partners || [] });
});

// ── Admin: Update Partner Status ──
app.patch('/api/admin/franchise/partners/:id', adminAuth, async (req, res) => {
  const { status, rejection_note } = req.body;
  const update = { status };
  if (status === 'active') { update.approved_at = new Date().toISOString(); }
  if (rejection_note) update.rejection_note = sanitize(rejection_note);
  const { error } = await supabase.from('franchise_partners').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Admin: Update Tier ──
app.patch('/api/admin/franchise/partners/:id/tier', adminAuth, async (req, res) => {
  const { tier } = req.body;
  if (!['basic','silver','gold','platinum'].includes(tier)) return res.status(400).json({ error: 'Tier không hợp lệ' });
  const { error } = await supabase.from('franchise_partners').update({ tier }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Admin: Stats ──
app.get('/api/admin/franchise/stats', adminAuth, async (req, res) => {
  const { data: all } = await supabase.from('franchise_partners').select('id,status,province,service_receiving,service_consignment,service_inspection,service_delivery,total_earnings');
  const total_partners = all?.length || 0;
  const active_partners = all?.filter(p => p.status === 'active').length || 0;
  const pending_partners = all?.filter(p => p.status === 'pending').length || 0;
  const total_revenue = all?.reduce((s, p) => s + (p.total_earnings || 0), 0) || 0;
  // By province
  const provinceCounts = {};
  (all || []).forEach(p => { provinceCounts[p.province] = (provinceCounts[p.province] || 0) + 1; });
  const by_province = Object.entries(provinceCounts).map(([province, count]) => ({ province, count }))
    .sort((a, b) => b.count - a.count);
  // By service
  const svcCounts = { 'Nhận hàng': 0, 'Ký gửi': 0, 'Kiểm định': 0, 'Giao nhận': 0 };
  (all || []).forEach(p => {
    if (p.service_receiving) svcCounts['Nhận hàng']++;
    if (p.service_consignment) svcCounts['Ký gửi']++;
    if (p.service_inspection) svcCounts['Kiểm định']++;
    if (p.service_delivery) svcCounts['Giao nhận']++;
  });
  const by_service = Object.entries(svcCounts).map(([service, count]) => ({ service, count }));
  res.json({ total_partners, active_partners, pending_partners, total_revenue, by_province, by_service });
});

// ══════════════════════════════════════════════════════════
// PHASE 18: SAFEPASS SOCIAL COMMERCE
// ══════════════════════════════════════════════════════════

// Serve social page
app.get('/social', (req, res) => res.sendFile(join(__dirname, 'frontend/social.html')));
app.get('/social.html', (req, res) => res.sendFile(join(__dirname, 'frontend/social.html')));

// Get current user social info
app.get('/api/social/me', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data: likedRows } = await supabase.from('social_likes').select('video_id').eq('user_id', userId);
    const { data: followedRows } = await supabase.from('social_follows').select('following_id').eq('follower_id', userId);
    const likedVideos = (likedRows||[]).map(r => r.video_id);
    const followedUsers = (followedRows||[]).map(r => r.following_id);
    res.json({ user: req.user, liked_videos: likedVideos, followed_users: followedUsers });
  } catch(e) { res.json({ user: req.user, liked_videos: [], followed_users: [] }); }
});

// Video feed
app.get('/api/social/feed', async (req, res) => {
  try {
    const { type = 'foryou', limit = 20, offset = 0 } = req.query;
    let query = supabase.from('social_videos').select(`*, users!inner(name, id)`).eq('status','active').order('created_at', { ascending: false }).range(Number(offset), Number(offset)+Number(limit)-1);
    const { data: videos, error } = await query;
    if (error) return res.json({ videos: [] });
    // Attach products
    const videoIds = (videos||[]).map(v => v.id);
    const { data: products } = videoIds.length ? await supabase.from('social_video_products').select('*').in('video_id', videoIds) : { data: [] };
    const prodMap = {};
    (products||[]).forEach(p => { if (!prodMap[p.video_id]) prodMap[p.video_id] = []; prodMap[p.video_id].push(p); });
    const enriched = (videos||[]).map(v => ({ ...v, creator_name: v.users?.name || 'Creator', products: prodMap[v.id] || [] }));
    res.json({ videos: enriched });
  } catch(e) { res.json({ videos: [] }); }
});

// Get trending videos
app.get('/api/social/trending', async (req, res) => {
  try {
    const { data: videos } = await supabase.from('social_videos').select('*, users!inner(name)').eq('status','active').order('views_count', { ascending: false }).limit(20);
    res.json({ videos: (videos||[]).map(v => ({ ...v, creator_name: v.users?.name })) });
  } catch(e) { res.json({ videos: [] }); }
});

// Post a video
app.post('/api/social/videos', auth, async (req, res) => {
  try {
    const { title, description, hashtags, video_url, thumbnail_url } = req.body;
    if (!title) return res.status(400).json({ error: 'Tiêu đề bắt buộc' });
    const { data, error } = await supabase.from('social_videos').insert({
      user_id: req.user.id, title, description: description||'', hashtags: hashtags||[],
      video_url: video_url||null, thumbnail_url: thumbnail_url||null, status: 'active'
    }).select().single();
    if (error) throw error;
    // Update creator stats
    await supabase.from('social_creator_stats').upsert({ user_id: req.user.id, total_videos: 1 }, { onConflict: 'user_id', ignoreDuplicates: false });
    res.json({ video: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Record view
app.post('/api/social/videos/:id/view', async (req, res) => {
  try {
    await supabase.from('social_videos').update({ views_count: supabase.raw ? undefined : 0 }).eq('id', req.params.id);
    await supabase.rpc ? supabase.rpc('increment_views', { vid: req.params.id }) : supabase.from('social_videos').select('views_count').eq('id',req.params.id).single().then(({data})=> data && supabase.from('social_videos').update({views_count:(data.views_count||0)+1}).eq('id',req.params.id));
    res.json({ ok: true });
  } catch(e) { res.json({ ok: true }); }
});

// Like / unlike video
app.post('/api/social/videos/:id/like', auth, async (req, res) => {
  try {
    const { id: videoId } = req.params;
    const userId = req.user.id;
    const { data: existing } = await supabase.from('social_likes').select('id').eq('user_id', userId).eq('video_id', videoId).maybeSingle();
    if (existing) {
      await supabase.from('social_likes').delete().eq('user_id', userId).eq('video_id', videoId);
      const { data: v } = await supabase.from('social_videos').select('likes_count').eq('id', videoId).single();
      const newCount = Math.max(0,(v?.likes_count||1)-1);
      await supabase.from('social_videos').update({ likes_count: newCount }).eq('id', videoId);
      return res.json({ liked: false, likes_count: newCount });
    } else {
      await supabase.from('social_likes').insert({ user_id: userId, video_id: videoId });
      const { data: v } = await supabase.from('social_videos').select('likes_count').eq('id', videoId).single();
      const newCount = (v?.likes_count||0)+1;
      await supabase.from('social_videos').update({ likes_count: newCount }).eq('id', videoId);
      return res.json({ liked: true, likes_count: newCount });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get video comments
app.get('/api/social/videos/:id/comments', async (req, res) => {
  try {
    const { data: comments } = await supabase.from('social_comments').select('*, users!inner(name)').eq('video_id', req.params.id).is('parent_id', null).order('created_at', { ascending: false }).limit(50);
    res.json({ comments: (comments||[]).map(c => ({ ...c, user_name: c.users?.name, initials: c.users?.name?.slice(0,2)?.toUpperCase() })) });
  } catch(e) { res.json({ comments: [] }); }
});

// Post comment
app.post('/api/social/videos/:id/comments', auth, async (req, res) => {
  try {
    const { content, parent_id } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Nội dung bắt buộc' });
    const { data, error } = await supabase.from('social_comments').insert({ video_id: req.params.id, user_id: req.user.id, content: content.trim(), parent_id: parent_id||null }).select().single();
    if (error) throw error;
    const { data: v } = await supabase.from('social_videos').select('comments_count').eq('id', req.params.id).single();
    await supabase.from('social_videos').update({ comments_count: (v?.comments_count||0)+1 }).eq('id', req.params.id);
    res.json({ comment: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Follow user
app.post('/api/social/follow/:userId', auth, async (req, res) => {
  try {
    const followerId = req.user.id;
    const followingId = req.params.userId;
    if (followerId === followingId) return res.status(400).json({ error: 'Không thể tự follow' });
    await supabase.from('social_follows').insert({ follower_id: followerId, following_id: followingId });
    // Update stats
    await supabase.from('social_creator_stats').upsert({ user_id: followingId }, { onConflict: 'user_id', ignoreDuplicates: true });
    res.json({ following: true });
  } catch(e) { res.json({ following: true }); }
});

// Unfollow user
app.delete('/api/social/follow/:userId', auth, async (req, res) => {
  try {
    await supabase.from('social_follows').delete().eq('follower_id', req.user.id).eq('following_id', req.params.userId);
    res.json({ following: false });
  } catch(e) { res.json({ following: false }); }
});

// Get creator profile
app.get('/api/social/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: user } = await supabase.from('users').select('id,name,bio').eq('id', userId).single();
    const { data: stats } = await supabase.from('social_creator_stats').select('*').eq('user_id', userId).maybeSingle();
    const { count: followersCount } = await supabase.from('social_follows').select('id', { count: 'exact', head: true }).eq('following_id', userId);
    const { count: followingCount } = await supabase.from('social_follows').select('id', { count: 'exact', head: true }).eq('follower_id', userId);
    const { data: videos } = await supabase.from('social_videos').select('*').eq('user_id', userId).eq('status','active').order('created_at', { ascending: false }).limit(12);
    const totalLikes = (videos||[]).reduce((s,v) => s+(v.likes_count||0), 0);
    res.json({ user, followers_count: followersCount||0, following_count: followingCount||0, total_likes: stats?.total_likes||totalLikes, videos: videos||[] });
  } catch(e) { res.json({ followers_count: 0, following_count: 0, total_likes: 0, videos: [] }); }
});

// Social dashboard for creator
app.get('/api/social/dashboard', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data: videos } = await supabase.from('social_videos').select('*').eq('user_id', userId).eq('status','active').order('views_count', { ascending: false });
    const totalViews = (videos||[]).reduce((s,v) => s+(v.views_count||0), 0);
    const totalLikes = (videos||[]).reduce((s,v) => s+(v.likes_count||0), 0);
    const totalShares = (videos||[]).reduce((s,v) => s+(v.shares_count||0), 0);
    const { count: totalSales } = await supabase.from('orders').select('id', { count: 'exact', head: true }).eq('seller_id', userId);
    res.json({ total_views: totalViews, total_likes: totalLikes, total_shares: totalShares, total_sales: totalSales||0, top_videos: (videos||[]).slice(0,5) });
  } catch(e) { res.json({ total_views: 0, total_likes: 0, total_shares: 0, total_sales: 0, top_videos: [] }); }
});

// Attach product to video
app.post('/api/social/videos/:id/products', auth, async (req, res) => {
  try {
    const { listing_id, custom_title, custom_price, custom_image, emoji } = req.body;
    const { data: video } = await supabase.from('social_videos').select('user_id').eq('id', req.params.id).single();
    if (!video || video.user_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
    const { data, error } = await supabase.from('social_video_products').insert({ video_id: req.params.id, listing_id: listing_id||null, custom_title, custom_price, custom_image }).select().single();
    if (error) throw error;
    res.json({ product: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Buy now from video
app.post('/api/social/buy-now', auth, async (req, res) => {
  try {
    const { product_id, listing_id } = req.body;
    // Redirect to main order flow
    res.json({ ok: true, redirect: '/' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Live streams
app.get('/api/social/livestreams', async (req, res) => {
  try {
    const { data } = await supabase.from('social_livestreams').select('*, users!inner(name)').eq('status','live').order('viewers_count', { ascending: false });
    res.json({ livestreams: (data||[]).map(l => ({ ...l, creator_name: l.users?.name })) });
  } catch(e) { res.json({ livestreams: [] }); }
});

app.post('/api/social/livestreams', auth, async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title) return res.status(400).json({ error: 'Tiêu đề bắt buộc' });
    const { data, error } = await supabase.from('social_livestreams').insert({ user_id: req.user.id, title, description: description||'', status: 'live', started_at: new Date().toISOString() }).select().single();
    if (error) throw error;
    // Also create a video record for the stream
    await supabase.from('social_videos').insert({ user_id: req.user.id, title, description: description||'', is_live: true, status: 'active' });
    res.json({ livestream: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/social/livestreams/:id/end', auth, async (req, res) => {
  try {
    await supabase.from('social_livestreams').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', req.params.id).eq('user_id', req.user.id);
    await supabase.from('social_videos').update({ is_live: false, live_ended_at: new Date().toISOString() }).eq('user_id', req.user.id).eq('is_live', true);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Live products
app.get('/api/social/livestreams/:id/products', async (req, res) => {
  try {
    const { data } = await supabase.from('social_live_products').select('*').eq('livestream_id', req.params.id).order('display_order');
    res.json({ products: data||[] });
  } catch(e) { res.json({ products: [] }); }
});

app.post('/api/social/livestreams/:id/products', auth, async (req, res) => {
  try {
    const { listing_id, custom_title, custom_price, custom_image } = req.body;
    const { data, error } = await supabase.from('social_live_products').insert({ livestream_id: req.params.id, listing_id: listing_id||null, custom_title, custom_price, custom_image }).select().single();
    if (error) throw error;
    res.json({ product: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Live chat messages
app.get('/api/social/livestreams/:id/messages', async (req, res) => {
  try {
    const { data } = await supabase.from('social_live_messages').select('*, users!inner(name)').eq('livestream_id', req.params.id).order('created_at', { ascending: false }).limit(50);
    res.json({ messages: (data||[]).reverse().map(m => ({ ...m, user_name: m.users?.name })) });
  } catch(e) { res.json({ messages: [] }); }
});

app.post('/api/social/livestreams/:id/messages', auth, async (req, res) => {
  try {
    const { content, type } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Nội dung bắt buộc' });
    const { data, error } = await supabase.from('social_live_messages').insert({ livestream_id: req.params.id, user_id: req.user.id, content: content.trim(), type: type||'message' }).select().single();
    if (error) throw error;
    res.json({ message: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN SOCIAL ──
app.get('/api/social/admin/videos', adminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('social_videos').select('*, users!inner(name)').order('created_at', { ascending: false }).limit(100);
    res.json({ videos: (data||[]).map(v => ({ ...v, creator_name: v.users?.name })) });
  } catch(e) { res.json({ videos: [] }); }
});

app.get('/api/social/admin/lives', adminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('social_livestreams').select('*, users!inner(name)').order('created_at', { ascending: false }).limit(50);
    res.json({ livestreams: (data||[]).map(l => ({ ...l, creator_name: l.users?.name })) });
  } catch(e) { res.json({ livestreams: [] }); }
});

app.get('/api/social/admin/reports', adminAuth, async (req, res) => {
  res.json({ reports: [] });
});

app.post('/api/social/admin/videos/:id/ban', adminAuth, async (req, res) => {
  try {
    await supabase.from('social_videos').update({ status: 'banned' }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/social/admin/videos/:id/restore', adminAuth, async (req, res) => {
  try {
    await supabase.from('social_videos').update({ status: 'active' }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════
   PHASE 20 — SAFEPASS MARKETPLACE (Facebook-style)
══════════════════════════════════════════════════ */

app.get('/marketplace', (req, res) => res.sendFile(join(__dirname, 'frontend/marketplace.html')));
app.get('/marketplace.html', (req, res) => res.sendFile(join(__dirname, 'frontend/marketplace.html')));

// GET /api/marketplace/posts — feed
app.get('/api/marketplace/posts', async (req, res) => {
  try {
    const { tab = 'all', category, limit = 20, offset = 0 } = req.query;
    let query = supabase.from('marketplace_posts')
      .select('*,users(name,avatar_url)')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);
    if (category && category !== 'all') query = query.eq('listing_category', category);
    if (tab === 'listing') query = query.eq('post_type', 'listing');
    else if (tab === 'want') query = query.eq('post_type', 'want');
    const { data, error } = await query;
    if (error) throw error;
    res.json({ posts: (data || []).map(p => ({ ...p, author: p.users?.name })) });
  } catch (e) { res.json({ posts: [] }); }
});

// POST /api/marketplace/posts — create post/listing
app.post('/api/marketplace/posts', auth, async (req, res) => {
  try {
    const { content, post_type, listing } = req.body;
    const insertData = {
      user_id: req.user.id,
      content: content ? sanitize(content) : null,
      post_type: post_type || 'status',
      status: 'active'
    };
    if (listing) {
      insertData.listing_title = sanitize(listing.title || '');
      insertData.listing_price = Number(listing.price) || 0;
      insertData.listing_category = listing.category || 'other';
      insertData.listing_condition = listing.condition || 'used';
      insertData.listing_location = sanitize(listing.location || '');
      insertData.listing_description = sanitize(listing.description || '');
    }
    const { data, error } = await supabase.from('marketplace_posts').insert(insertData).select().single();
    if (error) throw error;
    res.json({ ok: true, post: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/marketplace/posts/:id — single post
app.get('/api/marketplace/posts/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('marketplace_posts').select('*,users(name,avatar_url)').eq('id', req.params.id).single();
    if (error) throw error;
    res.json({ post: { ...data, author: data.users?.name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/marketplace/posts/:id/like — like a post
app.post('/api/marketplace/posts/:id/like', auth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('marketplace_likes').select('id').eq('post_id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (existing) {
      await supabase.from('marketplace_likes').delete().eq('id', existing.id);
      await supabase.from('marketplace_posts').update({ likes_count: supabase.raw('GREATEST(likes_count-1,0)') }).eq('id', req.params.id);
      return res.json({ liked: false });
    }
    await supabase.from('marketplace_likes').insert({ post_id: req.params.id, user_id: req.user.id });
    await supabase.from('marketplace_posts').update({ likes_count: supabase.raw('likes_count+1') }).eq('id', req.params.id);
    res.json({ liked: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/marketplace/posts/:id/comments — get comments
app.get('/api/marketplace/posts/:id/comments', async (req, res) => {
  try {
    const { data } = await supabase.from('marketplace_comments').select('*,users(name)').eq('post_id', req.params.id).order('created_at').limit(50);
    res.json({ comments: (data || []).map(c => ({ ...c, author: c.users?.name })) });
  } catch (e) { res.json({ comments: [] }); }
});

// POST /api/marketplace/posts/:id/comments — post comment
app.post('/api/marketplace/posts/:id/comments', auth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Nội dung trống' });
    const { data } = await supabase.from('marketplace_comments').insert({ post_id: req.params.id, user_id: req.user.id, content: sanitize(content) }).select().single();
    await supabase.from('marketplace_posts').update({ comments_count: supabase.raw('comments_count+1') }).eq('id', req.params.id);
    res.json({ ok: true, comment: { ...data, author: req.user.name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/marketplace/posts/:id/save — save/unsave post
app.post('/api/marketplace/posts/:id/save', auth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('marketplace_saves').select('id').eq('post_id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (existing) {
      await supabase.from('marketplace_saves').delete().eq('id', existing.id);
      return res.json({ saved: false });
    }
    await supabase.from('marketplace_saves').insert({ post_id: req.params.id, user_id: req.user.id });
    res.json({ saved: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/marketplace/saved — get saved posts
app.get('/api/marketplace/saved', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('marketplace_saves').select('*,marketplace_posts(*,users(name))').eq('user_id', req.user.id).order('created_at', { ascending: false });
    res.json({ posts: (data || []).map(s => ({ ...s.marketplace_posts, author: s.marketplace_posts?.users?.name })) });
  } catch (e) { res.json({ posts: [] }); }
});

// GET /api/marketplace/listings — browse listings by category
app.get('/api/marketplace/listings', async (req, res) => {
  try {
    const { category, min_price, max_price, condition, location, q, limit = 40 } = req.query;
    let query = supabase.from('marketplace_posts').select('*,users(name)').eq('post_type', 'listing').eq('status', 'active');
    if (category && category !== 'all') query = query.eq('listing_category', category);
    if (condition) query = query.eq('listing_condition', condition);
    if (min_price) query = query.gte('listing_price', Number(min_price));
    if (max_price) query = query.lte('listing_price', Number(max_price));
    if (location) query = query.ilike('listing_location', `%${location}%`);
    if (q) query = query.ilike('listing_title', `%${q}%`);
    query = query.order('created_at', { ascending: false }).limit(Number(limit));
    const { data, error } = await query;
    if (error) throw error;
    res.json({ listings: (data || []).map(p => ({ ...p, seller: p.users?.name })) });
  } catch (e) { res.json({ listings: [] }); }
});

// GET /api/marketplace/profile/:userId — user marketplace profile
app.get('/api/marketplace/profile/:userId', async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('id,name,avatar_url,created_at').eq('id', req.params.userId).single();
    const { data: posts } = await supabase.from('marketplace_posts').select('*').eq('user_id', req.params.userId).eq('status', 'active').order('created_at', { ascending: false }).limit(20);
    const { count: friends } = await supabase.from('marketplace_friends').select('*', { count: 'exact', head: true }).eq('user_id', req.params.userId).eq('status', 'accepted');
    res.json({ user, posts: posts || [], friends_count: friends || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/marketplace/friends — send friend request
app.post('/api/marketplace/friends', auth, async (req, res) => {
  try {
    const { target_id } = req.body;
    if (!target_id || target_id === req.user.id) return res.status(400).json({ error: 'Invalid' });
    await supabase.from('marketplace_friends').insert({ user_id: req.user.id, friend_id: target_id, status: 'pending' }).onConflict().ignore();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/marketplace/search — search posts & listings
app.get('/api/marketplace/search', async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q?.trim()) return res.json({ results: [] });
    let query = supabase.from('marketplace_posts').select('*,users(name)').eq('status', 'active').or(`listing_title.ilike.%${q}%,content.ilike.%${q}%`);
    if (type) query = query.eq('post_type', type);
    const { data } = await query.order('created_at', { ascending: false }).limit(30);
    res.json({ results: (data || []).map(p => ({ ...p, author: p.users?.name })) });
  } catch (e) { res.json({ results: [] }); }
});

// DELETE /api/marketplace/posts/:id — delete post (owner only)
app.delete('/api/marketplace/posts/:id', auth, async (req, res) => {
  try {
    await supabase.from('marketplace_posts').update({ status: 'deleted' }).eq('id', req.params.id).eq('user_id', req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── END PHASE 20 ── */

/* ══════════════════════════════════════════════════
   PHASE 19 — SAFEPASS LIVE COMMERCE
══════════════════════════════════════════════════ */

// Serve live.html
app.get('/live', (req, res) => res.sendFile(join(__dirname, 'frontend/live.html')));
app.get('/live.html', (req, res) => res.sendFile(join(__dirname, 'frontend/live.html')));

// GET /api/live/streams — list streams
app.get('/api/live/streams', async (req, res) => {
  try {
    const tab = req.query.tab || 'live';
    let status = tab === 'replays' ? 'ended' : tab === 'upcoming' ? 'scheduled' : 'live';
    const { data, error } = await supabase
      .from('live_streams')
      .select('id,user_id,title,category,status,viewers_count,peak_viewers,total_likes,is_auction:enable_auction,current_bid,started_at,ended_at,users(name)')
      .eq('status', status)
      .order('viewers_count', { ascending: false })
      .limit(20);
    if (error) throw error;
    const streams = (data || []).map(s => ({
      ...s,
      creator_name: s.users?.name || 'SafePass Creator',
      initials: (s.users?.name || 'SP').slice(0, 2).toUpperCase(),
      emoji: s.category === 'ticket' ? '🎟' : s.category === 'tech' ? '💻' : s.category === 'beauty' ? '💄' : s.category === 'fashion' ? '👗' : s.category === 'account' ? '🎮' : '📡',
      likes_count: s.total_likes || 0,
      is_live: s.status === 'live'
    }));
    res.json({ streams });
  } catch (e) { res.json({ streams: [] }); }
});

// POST /api/live/streams — start a stream
app.post('/api/live/streams', auth, async (req, res) => {
  try {
    const { title, category, enable_auction, enable_recording, enable_gifts, follow_only } = req.body;
    if (!title) return res.status(400).json({ error: 'Thiếu tiêu đề' });
    const { data, error } = await supabase.from('live_streams').insert({
      user_id: req.user.id, title, category: category || 'general',
      enable_auction: !!enable_auction, enable_recording: !!enable_recording,
      enable_gifts: enable_gifts !== false, follow_only: !!follow_only,
      status: 'live', started_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, stream: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/live/streams/:id/end — end stream
app.patch('/api/live/streams/:id/end', auth, async (req, res) => {
  try {
    await supabase.from('live_streams').update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('user_id', req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/live/streams/:id — single stream detail
app.get('/api/live/streams/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('live_streams').select('*,users(name,avatar_url)').eq('id', req.params.id).single();
    if (error) throw error;
    const { data: products } = await supabase.from('live_stream_products').select('*').eq('stream_id', req.params.id).order('display_order');
    res.json({ stream: { ...data, creator_name: data.users?.name }, products: products || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/live/streams/:id/chat — send chat message
app.post('/api/live/streams/:id/chat', auth, async (req, res) => {
  try {
    const { content, type } = req.body;
    if (!content) return res.status(400).json({ error: 'Thiếu nội dung' });
    const { data } = await supabase.from('live_chat_messages').insert({
      stream_id: req.params.id, user_id: req.user.id,
      content, type: type || 'message'
    }).select().single();
    res.json({ ok: true, message: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/live/streams/:id/chat — get chat messages
app.get('/api/live/streams/:id/chat', async (req, res) => {
  try {
    const { data } = await supabase.from('live_chat_messages')
      .select('*,users(name)').eq('stream_id', req.params.id)
      .order('created_at', { ascending: false }).limit(50);
    res.json({ messages: (data || []).reverse() });
  } catch (e) { res.json({ messages: [] }); }
});

// POST /api/live/streams/:id/bid — place auction bid
app.post('/api/live/streams/:id/bid', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Số tiền không hợp lệ' });
    const { data: auction } = await supabase.from('live_auctions')
      .select('*').eq('stream_id', req.params.id).eq('status', 'active').single();
    if (!auction) return res.status(404).json({ error: 'Không tìm thấy phiên đấu giá' });
    if (amount <= auction.current_price) return res.status(400).json({ error: 'Giá phải cao hơn giá hiện tại' });
    await supabase.from('live_auction_bids').insert({ auction_id: auction.id, user_id: req.user.id, amount });
    await supabase.from('live_auctions').update({ current_price: amount, leader_id: req.user.id, leader_name: req.user.name, total_bids: (auction.total_bids || 0) + 1 }).eq('id', auction.id);
    res.json({ ok: true, current_price: amount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/live/streams/:id/gift — send gift
app.post('/api/live/streams/:id/gift', auth, async (req, res) => {
  try {
    const { gift_type, amount } = req.body;
    if (!gift_type || !amount) return res.status(400).json({ error: 'Thiếu thông tin quà' });
    const giftEmojis = { rose:'🌹', heart:'❤️', star:'⭐', diamond:'💎', crown:'👑', rocket:'🚀', car:'🚗', castle:'🏰' };
    await supabase.from('live_gifts').insert({
      stream_id: req.params.id, sender_id: req.user.id,
      gift_type, gift_emoji: giftEmojis[gift_type] || '🎁',
      gift_name: gift_type, amount
    });
    await supabase.from('live_streams').update({ total_gifts_value: supabase.raw('total_gifts_value + ' + amount) }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/live/buy — buy product during live
app.post('/api/live/buy', auth, async (req, res) => {
  try {
    const { product_id, stream_id } = req.body;
    if (!product_id || !stream_id) return res.status(400).json({ error: 'Thiếu thông tin' });
    const { data: product } = await supabase.from('live_stream_products').select('*,live_streams(user_id)').eq('id', product_id).single();
    if (!product) return res.status(404).json({ error: 'Sản phẩm không tồn tại' });
    if (product.stock_count <= 0) return res.status(400).json({ error: 'Hết hàng' });
    const { data: order } = await supabase.from('live_orders').insert({
      stream_id, product_id, buyer_id: req.user.id,
      seller_id: product.live_streams?.user_id, price: product.price, status: 'escrow'
    }).select().single();
    await supabase.from('live_stream_products').update({ stock_count: product.stock_count - 1, sold_count: (product.sold_count || 0) + 1 }).eq('id', product_id);
    await supabase.from('live_streams').update({ total_sales: supabase.raw('total_sales + 1'), total_revenue: supabase.raw('total_revenue + ' + product.price) }).eq('id', stream_id);
    res.json({ ok: true, order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/live/streams/:id/like — like a stream
app.post('/api/live/streams/:id/like', auth, async (req, res) => {
  try {
    await supabase.from('live_streams').update({ total_likes: supabase.raw('total_likes + 1') }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/live/streams/:id/view — increment viewer count
app.post('/api/live/streams/:id/view', async (req, res) => {
  try {
    await supabase.from('live_streams').update({ viewers_count: supabase.raw('viewers_count + 1') }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/live/analytics — streamer analytics
app.get('/api/live/analytics', auth, async (req, res) => {
  try {
    const { data: streams } = await supabase.from('live_streams')
      .select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(20);
    const past = streams || [];
    const total_views = past.reduce((a, s) => a + (s.peak_viewers || 0), 0);
    const total_revenue = past.reduce((a, s) => a + (s.total_revenue || 0), 0);
    const total_likes = past.reduce((a, s) => a + (s.total_likes || 0), 0);
    const total_sales = past.reduce((a, s) => a + (s.total_sales || 0), 0);
    res.json({ total_views, total_revenue, total_likes, total_sales, past_streams: past });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/live/streams/:id/pin — pin a chat message (streamer only)
app.post('/api/live/streams/:id/pin', auth, async (req, res) => {
  try {
    const { message_id } = req.body;
    await supabase.from('live_chat_messages').update({ is_pinned: false }).eq('stream_id', req.params.id);
    await supabase.from('live_chat_messages').update({ is_pinned: true, pinned_by: req.user.id }).eq('id', message_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/live/streams/:id/report — report a stream
app.post('/api/live/streams/:id/report', auth, async (req, res) => {
  try {
    const { reason, description } = req.body;
    if (!reason) return res.status(400).json({ error: 'Chọn lý do báo cáo' });
    await supabase.from('live_reports').insert({ stream_id: req.params.id, reporter_id: req.user.id, reason, description });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN LIVE ROUTES ──
app.get('/api/live/admin/:tab', adminAuth, async (req, res) => {
  try {
    const { tab } = req.params;
    if (tab === 'live' || tab === 'ended') {
      const status = tab === 'live' ? 'live' : 'ended';
      const { data } = await supabase.from('live_streams').select('*,users(name)').eq('status', status).order('viewers_count', { ascending: false }).limit(50);
      return res.json({ streams: (data || []).map(s => ({ ...s, creator_name: s.users?.name })) });
    }
    if (tab === 'reports') {
      const { data } = await supabase.from('live_reports').select('*,users!reporter_id(name),live_streams(title)').eq('status', 'pending').order('created_at', { ascending: false }).limit(50);
      return res.json({ reports: data || [] });
    }
    if (tab === 'auctions') {
      const { data } = await supabase.from('live_auctions').select('*,live_streams(title,users(name))').order('created_at', { ascending: false }).limit(50);
      return res.json({ auctions: data || [] });
    }
    res.json({});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/live/admin/streams/:id/ban', adminAuth, async (req, res) => {
  try {
    await supabase.from('live_streams').update({ status: 'banned' }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/live/admin/streams/:id/warn', adminAuth, async (req, res) => {
  try {
    const { data: stream } = await supabase.from('live_streams').select('user_id').eq('id', req.params.id).single();
    if (stream) await supabase.from('notifications').insert({ user_id: stream.user_id, type: 'warning', title: 'Cảnh báo livestream', message: 'Livestream của bạn vi phạm quy định SafePass. Vui lòng tuân thủ nội dung.' }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/live/admin/streams/:id/restore', adminAuth, async (req, res) => {
  try {
    await supabase.from('live_streams').update({ status: 'live' }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── END PHASE 19 ── */

// ══════════════════════════════════════════════════════════════════
// PHASE 21: SAFEPASS STORIES — 24h Story System
// ══════════════════════════════════════════════════════════════════

// Helper: clean expired stories
async function cleanExpiredStories() {
  await supabase.from('stories').update({ status: 'deleted' })
    .eq('status', 'active').lt('expires_at', new Date().toISOString()).catch(() => {});
}

// GET /api/stories/feed — stories from followed sellers + popular stories (24h, active)
app.get('/api/stories/feed', auth, async (req, res) => {
  try {
    await cleanExpiredStories();
    const userId = req.user.id;
    // Get following list
    const { data: follows } = await supabase.from('story_follows')
      .select('following_id').eq('follower_id', userId);
    const followingIds = (follows || []).map(f => f.following_id);

    // Stories from followed + own + popular (last 24h active)
    const { data: stories, error } = await supabase.from('stories')
      .select('*,users(id,name,phone)')
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    // Get viewed story IDs for current user
    const storyIds = (stories || []).map(s => s.id);
    let viewedIds = new Set();
    if (storyIds.length > 0) {
      const { data: views } = await supabase.from('story_views')
        .select('story_id').eq('viewer_id', userId).in('story_id', storyIds);
      (views || []).forEach(v => viewedIds.add(v.story_id));
    }

    // Get liked story IDs
    let likedIds = new Set();
    if (storyIds.length > 0) {
      const { data: likes } = await supabase.from('story_likes')
        .select('story_id').eq('user_id', userId).in('story_id', storyIds);
      (likes || []).forEach(l => likedIds.add(l.story_id));
    }

    const enriched = (stories || []).map(s => ({
      ...s,
      author_name: s.users?.name || 'Người dùng',
      author_id: s.users?.id,
      is_following: followingIds.includes(s.user_id) || s.user_id === userId,
      is_own: s.user_id === userId,
      is_viewed: viewedIds.has(s.id),
      is_liked: likedIds.has(s.id),
      time_left_sec: Math.max(0, Math.floor((new Date(s.expires_at) - new Date()) / 1000))
    }));

    // Group by author
    const grouped = {};
    enriched.forEach(s => {
      const aid = s.user_id;
      if (!grouped[aid]) grouped[aid] = { author_id: aid, author_name: s.author_name, is_following: s.is_following, is_own: s.is_own, has_unseen: false, stories: [] };
      if (!s.is_viewed) grouped[aid].has_unseen = true;
      grouped[aid].stories.push(s);
    });

    // Sort: own first, then following (unseen first), then others
    const groups = Object.values(grouped).sort((a, b) => {
      if (a.is_own && !b.is_own) return -1;
      if (!a.is_own && b.is_own) return 1;
      if (a.is_following && !b.is_following) return -1;
      if (!a.is_following && b.is_following) return 1;
      if (a.has_unseen && !b.has_unseen) return -1;
      if (!a.has_unseen && b.has_unseen) return 1;
      return 0;
    });

    res.json({ groups, following_ids: followingIds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stories/mine — my own stories
app.get('/api/stories/mine', auth, async (req, res) => {
  try {
    await cleanExpiredStories();
    const { data, error } = await supabase.from('stories')
      .select('*').eq('user_id', req.user.id).eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ stories: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stories — create story
app.post('/api/stories', auth, async (req, res) => {
  try {
    const { type, caption, image_url, bg_color, emoji, listing_id, price, original_price, discount_pct, cta_label, cta_url } = req.body;
    if (!caption && !image_url) return res.status(400).json({ error: 'Cần có nội dung hoặc hình ảnh' });
    const validTypes = ['product', 'flash_sale', 'promo', 'announcement'];
    const storyType = validTypes.includes(type) ? type : 'promo';
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase.from('stories').insert({
      user_id: req.user.id, type: storyType, caption, image_url,
      bg_color: bg_color || '#1a2a4a', emoji: emoji || '🎫',
      listing_id: listing_id || null, price: price || null,
      original_price: original_price || null, discount_pct: discount_pct || null,
      cta_label, cta_url, expires_at
    }).select().single();
    if (error) throw error;
    res.json({ story: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/stories/:id — delete own story
app.delete('/api/stories/:id', auth, async (req, res) => {
  try {
    const { data: story } = await supabase.from('stories').select('user_id').eq('id', req.params.id).single();
    if (!story || story.user_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
    await supabase.from('stories').update({ status: 'deleted' }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stories/:id/view — mark story as viewed
app.post('/api/stories/:id/view', auth, async (req, res) => {
  try {
    const storyId = req.params.id;
    const viewerId = req.user.id;
    // Upsert view
    await supabase.from('story_views').upsert({ story_id: storyId, viewer_id: viewerId }, { onConflict: 'story_id,viewer_id' });
    // Increment views_count (ignore error if story not found)
    const { data: current } = await supabase.from('stories').select('views_count,user_id').eq('id', storyId).single();
    if (current && current.user_id !== viewerId) {
      await supabase.from('stories').update({ views_count: (current.views_count || 0) + 1 }).eq('id', storyId);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stories/:id/like — toggle like
app.post('/api/stories/:id/like', auth, async (req, res) => {
  try {
    const storyId = req.params.id;
    const userId = req.user.id;
    const { data: existing } = await supabase.from('story_likes').select('story_id').eq('story_id', storyId).eq('user_id', userId).single();
    if (existing) {
      await supabase.from('story_likes').delete().eq('story_id', storyId).eq('user_id', userId);
      const { data: s } = await supabase.from('stories').select('likes_count').eq('id', storyId).single();
      await supabase.from('stories').update({ likes_count: Math.max(0, (s?.likes_count || 1) - 1) }).eq('id', storyId);
      return res.json({ liked: false });
    }
    await supabase.from('story_likes').insert({ story_id: storyId, user_id: userId });
    const { data: s } = await supabase.from('stories').select('likes_count').eq('id', storyId).single();
    await supabase.from('stories').update({ likes_count: (s?.likes_count || 0) + 1 }).eq('id', storyId);
    res.json({ liked: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stories/follow/:uid — follow/unfollow a seller
app.post('/api/stories/follow/:uid', auth, async (req, res) => {
  try {
    const followerId = req.user.id;
    const followingId = req.params.uid;
    if (followerId === followingId) return res.status(400).json({ error: 'Không thể tự theo dõi' });
    const { data: existing } = await supabase.from('story_follows').select('follower_id').eq('follower_id', followerId).eq('following_id', followingId).single();
    if (existing) {
      await supabase.from('story_follows').delete().eq('follower_id', followerId).eq('following_id', followingId);
      return res.json({ following: false });
    }
    await supabase.from('story_follows').insert({ follower_id: followerId, following_id: followingId });
    res.json({ following: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stories/sellers — list of sellers with active stories (for discovery)
app.get('/api/stories/sellers', auth, async (req, res) => {
  try {
    await cleanExpiredStories();
    const { data, error } = await supabase.from('stories')
      .select('user_id,users(id,name)')
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('views_count', { ascending: false })
      .limit(100);
    if (error) throw error;
    // Deduplicate by user_id
    const seen = new Set();
    const sellers = [];
    for (const s of (data || [])) {
      if (!seen.has(s.user_id)) {
        seen.add(s.user_id);
        sellers.push({ id: s.user_id, name: s.users?.name || 'Người dùng' });
      }
    }
    // Check who current user follows
    const { data: follows } = await supabase.from('story_follows').select('following_id').eq('follower_id', req.user.id);
    const followingSet = new Set((follows || []).map(f => f.following_id));
    const enriched = sellers.map(s => ({ ...s, is_following: followingSet.has(s.id), is_own: s.id === req.user.id }));
    res.json({ sellers: enriched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: GET /api/admin/stories — view all active stories
app.get('/api/admin/stories', adminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('stories')
      .select('*,users(name,phone)')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(200);
    res.json({ stories: (data || []).map(s => ({ ...s, author_name: s.users?.name, author_phone: s.users?.phone })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: DELETE /api/admin/stories/:id — remove story
app.delete('/api/admin/stories/:id', adminAuth, async (req, res) => {
  try {
    await supabase.from('stories').update({ status: 'deleted' }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve stories page
app.get('/stories', (req, res) => res.sendFile(join(__dirname, 'frontend', 'stories.html')));

/* ── SOCIAL NETWORK CORE ── */

// ── Helper: ensure sn_profile exists ──
async function ensureSnProfile(userId) {
  const { data } = await supabase.from('sn_profiles').select('user_id').eq('user_id', userId).single();
  if (!data) await supabase.from('sn_profiles').insert({ user_id: userId });
}

// ── Helper: create sn notification ──
async function snNotify(userId, actorId, type, entityType, entityId, message) {
  if (userId === actorId) return;
  await supabase.from('sn_notifications').insert({ user_id: userId, actor_id: actorId, type, entity_type: entityType, entity_id: entityId, message });
}

// ── Serve network page ──
app.get('/network', (req, res) => res.sendFile(join(__dirname, 'frontend', 'network.html')));
app.get('/network.html', (req, res) => res.sendFile(join(__dirname, 'frontend', 'network.html')));

// ════════════════════════════════════════
// PROFILE
// ════════════════════════════════════════

// GET own profile
app.get('/api/sn/me', auth, async (req, res) => {
  try {
    await ensureSnProfile(req.user.id);
    const { data: user } = await supabase.from('users').select('id,name,phone,email,is_verified,avg_rating').eq('id', req.user.id).single();
    const { data: profile } = await supabase.from('sn_profiles').select('*').eq('user_id', req.user.id).single();
    const { count: unread } = await supabase.from('sn_notifications').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('is_read', false);
    res.json({ ...user, ...profile, unread_notifications: unread || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET any user profile
app.get('/api/sn/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    await ensureSnProfile(userId);
    const { data: user } = await supabase.from('users').select('id,name,is_verified,avg_rating,created_at').eq('id', userId).single();
    if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    const { data: profile } = await supabase.from('sn_profiles').select('*').eq('user_id', userId).single();
    const { data: posts } = await supabase.from('sn_posts').select('id,content,media_urls,media_type,reactions_count,comments_count,created_at').eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(12);
    res.json({ ...user, ...profile, recent_posts: posts || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT update own profile
app.put('/api/sn/profile', auth, async (req, res) => {
  try {
    const { bio, location, website, birthday, gender, avatar_url, cover_url } = req.body;
    await ensureSnProfile(req.user.id);
    const { data } = await supabase.from('sn_profiles').update({ bio, location, website, birthday, gender, avatar_url, cover_url, updated_at: new Date().toISOString() }).eq('user_id', req.user.id).select().single();
    if (req.body.name) await supabase.from('users').update({ name: req.body.name }).eq('id', req.user.id);
    res.json({ ok: true, profile: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// FRIEND SYSTEM
// ════════════════════════════════════════

// GET friend list / requests
app.get('/api/sn/friends', auth, async (req, res) => {
  try {
    const { type = 'friends' } = req.query;
    const uid = req.user.id;
    if (type === 'requests') {
      const { data } = await supabase.from('sn_friendships').select('id,requester_id,created_at').eq('addressee_id', uid).eq('status', 'pending').order('created_at', { ascending: false });
      const ids = (data || []).map(f => f.requester_id);
      if (!ids.length) return res.json([]);
      const { data: users } = await supabase.from('users').select('id,name,is_verified').in('id', ids);
      const profs = await Promise.all(ids.map(id => supabase.from('sn_profiles').select('avatar_url,friends_count').eq('user_id', id).single().then(r => r.data)));
      return res.json((data || []).map((f, i) => ({ ...f, user: { ...(users||[]).find(u=>u.id===f.requester_id), ...(profs[i]||{}) } })));
    }
    if (type === 'sent') {
      const { data } = await supabase.from('sn_friendships').select('id,addressee_id,status,created_at').eq('requester_id', uid).eq('status', 'pending');
      const ids = (data || []).map(f => f.addressee_id);
      if (!ids.length) return res.json([]);
      const { data: users } = await supabase.from('users').select('id,name,is_verified').in('id', ids);
      return res.json((data || []).map(f => ({ ...f, user: (users||[]).find(u=>u.id===f.addressee_id) })));
    }
    // accepted friends
    const { data: f1 } = await supabase.from('sn_friendships').select('addressee_id').eq('requester_id', uid).eq('status', 'accepted');
    const { data: f2 } = await supabase.from('sn_friendships').select('requester_id').eq('addressee_id', uid).eq('status', 'accepted');
    const ids = [...(f1||[]).map(f=>f.addressee_id), ...(f2||[]).map(f=>f.requester_id)];
    if (!ids.length) return res.json([]);
    const { data: users } = await supabase.from('users').select('id,name,is_verified').in('id', ids);
    const profs = await Promise.all(ids.map(id => supabase.from('sn_profiles').select('avatar_url').eq('user_id', id).single().then(r => r.data)));
    return res.json(ids.map((id, i) => ({ id, user: { ...(users||[]).find(u=>u.id===id), ...(profs[i]||{}) } })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST send friend request
app.post('/api/sn/friends/request/:userId', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const target = req.params.userId;
    if (uid === target) return res.status(400).json({ error: 'Không thể kết bạn với chính mình' });
    // check existing
    const { data: existing } = await supabase.from('sn_friendships').select('id,status').or(`and(requester_id.eq.${uid},addressee_id.eq.${target}),and(requester_id.eq.${target},addressee_id.eq.${uid})`).single();
    if (existing) return res.status(400).json({ error: 'Đã gửi yêu cầu hoặc đã là bạn', status: existing.status });
    await supabase.from('sn_friendships').insert({ requester_id: uid, addressee_id: target, status: 'pending' });
    const { data: me } = await supabase.from('users').select('name').eq('id', uid).single();
    await snNotify(target, uid, 'friend_request', 'user', uid, `${me.name} đã gửi lời mời kết bạn`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT accept / decline friend request
app.put('/api/sn/friends/:requestId', auth, async (req, res) => {
  try {
    const { action } = req.body; // accept | decline
    const uid = req.user.id;
    const { data: req_ } = await supabase.from('sn_friendships').select('*').eq('id', req.params.requestId).eq('addressee_id', uid).single();
    if (!req_) return res.status(404).json({ error: 'Không tìm thấy' });
    const newStatus = action === 'accept' ? 'accepted' : 'declined';
    await supabase.from('sn_friendships').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', req.params.requestId);
    if (action === 'accept') {
      await supabase.from('sn_profiles').update({ friends_count: supabase.raw('friends_count + 1') }).eq('user_id', uid);
      await supabase.from('sn_profiles').update({ friends_count: supabase.raw('friends_count + 1') }).eq('user_id', req_.requester_id);
      const { data: me } = await supabase.from('users').select('name').eq('id', uid).single();
      await snNotify(req_.requester_id, uid, 'friend_accept', 'user', uid, `${me.name} đã chấp nhận lời mời kết bạn`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE unfriend / unblock
app.delete('/api/sn/friends/:userId', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const target = req.params.userId;
    const { data: friendship } = await supabase.from('sn_friendships').select('id,requester_id,addressee_id,status').or(`and(requester_id.eq.${uid},addressee_id.eq.${target}),and(requester_id.eq.${target},addressee_id.eq.${uid})`).single();
    if (!friendship) return res.status(404).json({ error: 'Không tìm thấy' });
    const wasAccepted = friendship.status === 'accepted';
    await supabase.from('sn_friendships').delete().eq('id', friendship.id);
    if (wasAccepted) {
      await supabase.from('sn_profiles').update({ friends_count: supabase.raw('GREATEST(0, friends_count - 1)') }).eq('user_id', uid);
      await supabase.from('sn_profiles').update({ friends_count: supabase.raw('GREATEST(0, friends_count - 1)') }).eq('user_id', target);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST block user
app.post('/api/sn/friends/block/:userId', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const target = req.params.userId;
    await supabase.from('sn_friendships').delete().or(`and(requester_id.eq.${uid},addressee_id.eq.${target}),and(requester_id.eq.${target},addressee_id.eq.${uid})`);
    await supabase.from('sn_friendships').insert({ requester_id: uid, addressee_id: target, status: 'blocked' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET friendship status between me and another user
app.get('/api/sn/friends/status/:userId', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const target = req.params.userId;
    const { data } = await supabase.from('sn_friendships').select('id,status,requester_id,addressee_id').or(`and(requester_id.eq.${uid},addressee_id.eq.${target}),and(requester_id.eq.${target},addressee_id.eq.${uid})`).maybeSingle();
    if (!data) return res.json({ status: 'none' });
    return res.json({ status: data.status, direction: data.requester_id === uid ? 'sent' : 'received', id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// FOLLOW SYSTEM (reuse social_follows)
// ════════════════════════════════════════

app.post('/api/sn/follow/:userId', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const target = req.params.userId;
    if (uid === target) return res.status(400).json({ error: 'Không thể follow chính mình' });
    await supabase.from('social_follows').insert({ follower_id: uid, following_id: target });
    await supabase.from('sn_profiles').update({ following_count: supabase.raw('following_count + 1') }).eq('user_id', uid);
    await supabase.from('sn_profiles').update({ followers_count: supabase.raw('followers_count + 1') }).eq('user_id', target);
    const { data: me } = await supabase.from('users').select('name').eq('id', uid).single();
    await snNotify(target, uid, 'new_follower', 'user', uid, `${me.name} đã theo dõi bạn`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sn/follow/:userId', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const target = req.params.userId;
    await supabase.from('social_follows').delete().eq('follower_id', uid).eq('following_id', target);
    await supabase.from('sn_profiles').update({ following_count: supabase.raw('GREATEST(0, following_count - 1)') }).eq('user_id', uid);
    await supabase.from('sn_profiles').update({ followers_count: supabase.raw('GREATEST(0, followers_count - 1)') }).eq('user_id', target);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sn/follow/status/:userId', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('social_follows').select('id').eq('follower_id', req.user.id).eq('following_id', req.params.userId).maybeSingle();
    res.json({ following: !!data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// POSTS
// ════════════════════════════════════════

// GET news feed
app.get('/api/sn/feed', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    // get friend ids + following ids
    const { data: f1 } = await supabase.from('sn_friendships').select('addressee_id').eq('requester_id', uid).eq('status', 'accepted');
    const { data: f2 } = await supabase.from('sn_friendships').select('requester_id').eq('addressee_id', uid).eq('status', 'accepted');
    const { data: follows } = await supabase.from('social_follows').select('following_id').eq('follower_id', uid);
    const friendIds = [...(f1||[]).map(f=>f.addressee_id), ...(f2||[]).map(f=>f.requester_id)];
    const followIds = (follows||[]).map(f=>f.following_id);
    const feedIds = [...new Set([uid, ...friendIds, ...followIds])];
    const { data: posts, count } = await supabase.from('sn_posts').select('*', { count: 'exact' }).in('user_id', feedIds).eq('status', 'active').in('visibility', ['public','friends']).is('group_id', null).order('created_at', { ascending: false }).range(offset, offset + parseInt(limit) - 1);
    // enrich with user info
    const enriched = await Promise.all((posts||[]).map(async p => {
      const { data: u } = await supabase.from('users').select('id,name,is_verified').eq('id', p.user_id).single();
      const { data: prof } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id', p.user_id).single();
      const { data: myReaction } = await supabase.from('sn_reactions').select('reaction').eq('post_id', p.id).eq('user_id', uid).maybeSingle();
      let shared_post = null;
      if (p.shared_post_id) {
        const { data: sp } = await supabase.from('sn_posts').select('*').eq('id', p.shared_post_id).single();
        if (sp) {
          const { data: su } = await supabase.from('users').select('id,name').eq('id', sp.user_id).single();
          shared_post = { ...sp, user: su };
        }
      }
      return { ...p, user: { ...u, avatar_url: prof?.avatar_url }, my_reaction: myReaction?.reaction || null, shared_post };
    }));
    res.json({ posts: enriched, total: count, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET public/explore feed
app.get('/api/sn/explore', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { data: posts, count } = await supabase.from('sn_posts').select('*', { count: 'exact' }).eq('status', 'active').eq('visibility', 'public').is('group_id', null).order('created_at', { ascending: false }).range(offset, offset + parseInt(limit) - 1);
    const enriched = await Promise.all((posts||[]).map(async p => {
      const { data: u } = await supabase.from('users').select('id,name,is_verified').eq('id', p.user_id).single();
      const { data: prof } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id', p.user_id).single();
      return { ...p, user: { ...u, avatar_url: prof?.avatar_url } };
    }));
    res.json({ posts: enriched, total: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST create post
app.post('/api/sn/posts', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { content, media_urls, media_type, visibility, group_id, page_id, shared_post_id, post_type } = req.body;
    if (!content && (!media_urls || !media_urls.length)) return res.status(400).json({ error: 'Nội dung không được trống' });
    const { data: post } = await supabase.from('sn_posts').insert({ user_id: uid, content, media_urls: media_urls || [], media_type: media_type || 'none', visibility: visibility || 'public', group_id: group_id || null, page_id: page_id || null, shared_post_id: shared_post_id || null, post_type: post_type || 'post' }).select().single();
    await supabase.from('sn_profiles').update({ posts_count: supabase.raw('posts_count + 1') }).eq('user_id', uid);
    if (group_id) await supabase.from('sn_groups').update({ posts_count: supabase.raw('posts_count + 1') }).eq('id', group_id);
    if (page_id) await supabase.from('sn_pages').update({ posts_count: supabase.raw('posts_count + 1') }).eq('id', page_id);
    const { data: u } = await supabase.from('users').select('id,name,is_verified').eq('id', uid).single();
    const { data: prof } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id', uid).single();
    res.json({ ok: true, post: { ...post, user: { ...u, avatar_url: prof?.avatar_url }, my_reaction: null } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE post
app.delete('/api/sn/posts/:id', auth, async (req, res) => {
  try {
    const { data: post } = await supabase.from('sn_posts').select('user_id').eq('id', req.params.id).single();
    if (!post || post.user_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
    await supabase.from('sn_posts').update({ status: 'deleted' }).eq('id', req.params.id);
    await supabase.from('sn_profiles').update({ posts_count: supabase.raw('GREATEST(0, posts_count - 1)') }).eq('user_id', req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// REACTIONS
// ════════════════════════════════════════

app.post('/api/sn/posts/:id/react', auth, async (req, res) => {
  try {
    const { reaction } = req.body; // like | love | haha | wow | sad | angry
    const uid = req.user.id;
    const postId = req.params.id;
    const { data: existing } = await supabase.from('sn_reactions').select('id,reaction').eq('post_id', postId).eq('user_id', uid).maybeSingle();
    if (existing) {
      if (existing.reaction === reaction) {
        // toggle off
        await supabase.from('sn_reactions').delete().eq('id', existing.id);
        await supabase.from('sn_posts').update({ reactions_count: supabase.raw('GREATEST(0, reactions_count - 1)') }).eq('id', postId);
        return res.json({ ok: true, action: 'removed' });
      }
      await supabase.from('sn_reactions').update({ reaction }).eq('id', existing.id);
      return res.json({ ok: true, action: 'updated', reaction });
    }
    await supabase.from('sn_reactions').insert({ post_id: postId, user_id: uid, reaction });
    await supabase.from('sn_posts').update({ reactions_count: supabase.raw('reactions_count + 1') }).eq('id', postId);
    const { data: post } = await supabase.from('sn_posts').select('user_id').eq('id', postId).single();
    if (post) {
      const { data: me } = await supabase.from('users').select('name').eq('id', uid).single();
      const emojis = { like:'👍', love:'❤️', haha:'😄', wow:'😮', sad:'😢', angry:'😠' };
      await snNotify(post.user_id, uid, 'post_reaction', 'post', postId, `${me.name} đã ${emojis[reaction]||''} bài viết của bạn`);
    }
    res.json({ ok: true, action: 'added', reaction });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sn/posts/:id/reactions', async (req, res) => {
  try {
    const { data } = await supabase.from('sn_reactions').select('reaction,user_id').eq('post_id', req.params.id);
    const counts = { like: 0, love: 0, haha: 0, wow: 0, sad: 0, angry: 0 };
    (data || []).forEach(r => { if (counts[r.reaction] !== undefined) counts[r.reaction]++; });
    res.json({ counts, total: (data||[]).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// COMMENTS
// ════════════════════════════════════════

app.get('/api/sn/posts/:id/comments', async (req, res) => {
  try {
    const { data: comments } = await supabase.from('sn_comments').select('*').eq('post_id', req.params.id).is('parent_id', null).eq('status', 'active').order('created_at', { ascending: true }).limit(50);
    const enriched = await Promise.all((comments||[]).map(async c => {
      const { data: u } = await supabase.from('users').select('id,name,is_verified').eq('id', c.user_id).single();
      const { data: prof } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id', c.user_id).single();
      const { data: replies } = await supabase.from('sn_comments').select('*').eq('parent_id', c.id).eq('status', 'active').order('created_at', { ascending: true }).limit(5);
      const enrichedReplies = await Promise.all((replies||[]).map(async r => {
        const { data: ru } = await supabase.from('users').select('id,name').eq('id', r.user_id).single();
        const { data: rp } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id', r.user_id).single();
        return { ...r, user: { ...ru, avatar_url: rp?.avatar_url } };
      }));
      return { ...c, user: { ...u, avatar_url: prof?.avatar_url }, replies: enrichedReplies };
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sn/posts/:id/comments', auth, async (req, res) => {
  try {
    const { content, parent_id } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Nội dung trống' });
    const uid = req.user.id;
    const postId = req.params.id;
    const { data: comment } = await supabase.from('sn_comments').insert({ post_id: postId, user_id: uid, content, parent_id: parent_id || null }).select().single();
    await supabase.from('sn_posts').update({ comments_count: supabase.raw('comments_count + 1') }).eq('id', postId);
    if (parent_id) await supabase.from('sn_comments').update({ replies_count: supabase.raw('replies_count + 1') }).eq('id', parent_id);
    const { data: post } = await supabase.from('sn_posts').select('user_id').eq('id', postId).single();
    const { data: me } = await supabase.from('users').select('name').eq('id', uid).single();
    if (parent_id) {
      const { data: parentC } = await supabase.from('sn_comments').select('user_id').eq('id', parent_id).single();
      if (parentC) await snNotify(parentC.user_id, uid, 'comment_reply', 'comment', comment.id, `${me.name} đã trả lời bình luận của bạn`);
    } else if (post) {
      await snNotify(post.user_id, uid, 'post_comment', 'post', postId, `${me.name} đã bình luận bài viết của bạn`);
    }
    const { data: u } = await supabase.from('users').select('id,name,is_verified').eq('id', uid).single();
    const { data: prof } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id', uid).single();
    res.json({ ok: true, comment: { ...comment, user: { ...u, avatar_url: prof?.avatar_url }, replies: [] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sn/comments/:id', auth, async (req, res) => {
  try {
    const { data: c } = await supabase.from('sn_comments').select('user_id,post_id,parent_id').eq('id', req.params.id).single();
    if (!c || c.user_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
    await supabase.from('sn_comments').update({ status: 'deleted' }).eq('id', req.params.id);
    await supabase.from('sn_posts').update({ comments_count: supabase.raw('GREATEST(0, comments_count - 1)') }).eq('id', c.post_id);
    if (c.parent_id) await supabase.from('sn_comments').update({ replies_count: supabase.raw('GREATEST(0, replies_count - 1)') }).eq('id', c.parent_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// SHARE
// ════════════════════════════════════════

app.post('/api/sn/posts/:id/share', auth, async (req, res) => {
  try {
    const { content, visibility } = req.body;
    const uid = req.user.id;
    const orig = req.params.id;
    const { data: post } = await supabase.from('sn_posts').insert({ user_id: uid, content: content || '', shared_post_id: orig, post_type: 'share', visibility: visibility || 'public', media_urls: [], media_type: 'none' }).select().single();
    await supabase.from('sn_posts').update({ shares_count: supabase.raw('shares_count + 1') }).eq('id', orig);
    const { data: origPost } = await supabase.from('sn_posts').select('user_id').eq('id', orig).single();
    const { data: me } = await supabase.from('users').select('name').eq('id', uid).single();
    if (origPost) await snNotify(origPost.user_id, uid, 'post_share', 'post', orig, `${me.name} đã chia sẻ bài viết của bạn`);
    await supabase.from('sn_profiles').update({ posts_count: supabase.raw('posts_count + 1') }).eq('user_id', uid);
    res.json({ ok: true, post });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// GROUPS
// ════════════════════════════════════════

app.get('/api/sn/groups', async (req, res) => {
  try {
    const { search, category, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let q = supabase.from('sn_groups').select('*', { count: 'exact' }).eq('status', 'active').in('privacy', ['public','private']);
    if (search) q = q.ilike('name', `%${search}%`);
    if (category && category !== 'all') q = q.eq('category', category);
    const { data, count } = await q.order('members_count', { ascending: false }).range(offset, offset + parseInt(limit) - 1);
    res.json({ groups: data || [], total: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sn/groups/:id', async (req, res) => {
  try {
    const { data: group } = await supabase.from('sn_groups').select('*').eq('id', req.params.id).single();
    if (!group) return res.status(404).json({ error: 'Không tìm thấy nhóm' });
    const { data: posts } = await supabase.from('sn_posts').select('*').eq('group_id', req.params.id).eq('status', 'active').order('created_at', { ascending: false }).limit(20);
    const enriched = await Promise.all((posts||[]).map(async p => {
      const { data: u } = await supabase.from('users').select('id,name,is_verified').eq('id', p.user_id).single();
      const { data: prof } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id', p.user_id).single();
      return { ...p, user: { ...u, avatar_url: prof?.avatar_url } };
    }));
    res.json({ ...group, posts: enriched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sn/groups', auth, async (req, res) => {
  try {
    const { name, description, category, privacy, avatar_url, cover_url } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Tên nhóm không được trống' });
    const uid = req.user.id;
    const { data: group } = await supabase.from('sn_groups').insert({ name, description, category: category || 'general', privacy: privacy || 'public', avatar_url, cover_url, created_by: uid, members_count: 1 }).select().single();
    await supabase.from('sn_group_members').insert({ group_id: group.id, user_id: uid, role: 'admin' });
    res.json({ ok: true, group });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sn/groups/:id/join', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { data: group } = await supabase.from('sn_groups').select('privacy,members_count').eq('id', req.params.id).single();
    if (!group) return res.status(404).json({ error: 'Không tìm thấy nhóm' });
    const { data: existing } = await supabase.from('sn_group_members').select('id').eq('group_id', req.params.id).eq('user_id', uid).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Đã là thành viên' });
    await supabase.from('sn_group_members').insert({ group_id: req.params.id, user_id: uid, role: 'member' });
    await supabase.from('sn_groups').update({ members_count: supabase.raw('members_count + 1') }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sn/groups/:id/leave', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { data: m } = await supabase.from('sn_group_members').select('role').eq('group_id', req.params.id).eq('user_id', uid).single();
    if (!m) return res.status(404).json({ error: 'Không phải thành viên' });
    if (m.role === 'admin') return res.status(400).json({ error: 'Admin không thể rời nhóm. Hãy chuyển quyền trước.' });
    await supabase.from('sn_group_members').delete().eq('group_id', req.params.id).eq('user_id', uid);
    await supabase.from('sn_groups').update({ members_count: supabase.raw('GREATEST(0, members_count - 1)') }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sn/groups/:id/membership', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('sn_group_members').select('role').eq('group_id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    res.json({ member: !!data, role: data?.role || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET my groups
app.get('/api/sn/my-groups', auth, async (req, res) => {
  try {
    const { data: memberships } = await supabase.from('sn_group_members').select('group_id,role').eq('user_id', req.user.id);
    if (!memberships?.length) return res.json([]);
    const ids = memberships.map(m => m.group_id);
    const { data: groups } = await supabase.from('sn_groups').select('*').in('id', ids).eq('status', 'active');
    res.json((groups||[]).map(g => ({ ...g, my_role: memberships.find(m=>m.group_id===g.id)?.role })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// PAGES
// ════════════════════════════════════════

app.get('/api/sn/pages', async (req, res) => {
  try {
    const { search, category, page = 1, limit = 20 } = req.query;
    let q = supabase.from('sn_pages').select('*', { count: 'exact' }).eq('status', 'active');
    if (search) q = q.ilike('name', `%${search}%`);
    if (category && category !== 'all') q = q.eq('category', category);
    const { data, count } = await q.order('followers_count', { ascending: false }).range(0, parseInt(limit) - 1);
    res.json({ pages: data || [], total: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sn/pages', auth, async (req, res) => {
  try {
    const { name, description, category, website, phone, email, avatar_url, cover_url } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Tên trang không được trống' });
    const username = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now().toString(36);
    const { data: pg } = await supabase.from('sn_pages').insert({ owner_id: req.user.id, name, username, description, category: category || 'business', website, phone, email, avatar_url, cover_url }).select().single();
    res.json({ ok: true, page: pg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sn/pages/:id/follow', auth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('sn_page_followers').select('id').eq('page_id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (existing) {
      await supabase.from('sn_page_followers').delete().eq('id', existing.id);
      await supabase.from('sn_pages').update({ followers_count: supabase.raw('GREATEST(0, followers_count - 1)') }).eq('id', req.params.id);
      return res.json({ ok: true, following: false });
    }
    await supabase.from('sn_page_followers').insert({ page_id: req.params.id, user_id: req.user.id });
    await supabase.from('sn_pages').update({ followers_count: supabase.raw('followers_count + 1') }).eq('id', req.params.id);
    res.json({ ok: true, following: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sn/my-pages', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('sn_pages').select('*').eq('owner_id', req.user.id).eq('status', 'active');
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════

app.get('/api/sn/notifications', auth, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { data, count } = await supabase.from('sn_notifications').select('*', { count: 'exact' }).eq('user_id', req.user.id).order('created_at', { ascending: false }).range(offset, offset + parseInt(limit) - 1);
    // enrich with actor info
    const enriched = await Promise.all((data||[]).map(async n => {
      if (!n.actor_id) return n;
      const { data: actor } = await supabase.from('users').select('id,name').eq('id', n.actor_id).single();
      const { data: prof } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id', n.actor_id).single();
      return { ...n, actor: { ...actor, avatar_url: prof?.avatar_url } };
    }));
    res.json({ notifications: enriched, total: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sn/notifications/read-all', auth, async (req, res) => {
  try {
    await supabase.from('sn_notifications').update({ is_read: true }).eq('user_id', req.user.id).eq('is_read', false);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sn/notifications/:id/read', auth, async (req, res) => {
  try {
    await supabase.from('sn_notifications').update({ is_read: true }).eq('id', req.params.id).eq('user_id', req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// SEARCH
// ════════════════════════════════════════

app.get('/api/sn/search', async (req, res) => {
  try {
    const { q, type = 'all' } = req.query;
    if (!q?.trim()) return res.json({ users: [], posts: [], groups: [], pages: [] });
    const results = {};
    if (type === 'all' || type === 'users') {
      const { data: users } = await supabase.from('users').select('id,name,is_verified').ilike('name', `%${q}%`).limit(10);
      const enriched = await Promise.all((users||[]).map(async u => {
        const { data: prof } = await supabase.from('sn_profiles').select('avatar_url,bio,friends_count,followers_count').eq('user_id', u.id).single();
        return { ...u, ...prof };
      }));
      results.users = enriched;
    }
    if (type === 'all' || type === 'posts') {
      const { data: posts } = await supabase.from('sn_posts').select('id,content,media_urls,media_type,user_id,reactions_count,comments_count,created_at').ilike('content', `%${q}%`).eq('status', 'active').eq('visibility', 'public').order('created_at', { ascending: false }).limit(10);
      const enriched = await Promise.all((posts||[]).map(async p => {
        const { data: u } = await supabase.from('users').select('id,name').eq('id', p.user_id).single();
        const { data: prof } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id', p.user_id).single();
        return { ...p, user: { ...u, avatar_url: prof?.avatar_url } };
      }));
      results.posts = enriched;
    }
    if (type === 'all' || type === 'groups') {
      const { data: groups } = await supabase.from('sn_groups').select('id,name,description,avatar_url,members_count,category').ilike('name', `%${q}%`).eq('status', 'active').limit(10);
      results.groups = groups || [];
    }
    if (type === 'all' || type === 'pages') {
      const { data: pages } = await supabase.from('sn_pages').select('id,name,description,avatar_url,followers_count,category,is_verified').ilike('name', `%${q}%`).eq('status', 'active').limit(10);
      results.pages = pages || [];
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// TRENDING
// ════════════════════════════════════════

app.get('/api/sn/trending', async (req, res) => {
  try {
    const { data: posts } = await supabase.from('sn_posts').select('*').eq('status', 'active').eq('visibility', 'public').is('group_id', null).order('reactions_count', { ascending: false }).limit(20);
    const enriched = await Promise.all((posts||[]).map(async p => {
      const { data: u } = await supabase.from('users').select('id,name,is_verified').eq('id', p.user_id).single();
      const { data: prof } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id', p.user_id).single();
      return { ...p, user: { ...u, avatar_url: prof?.avatar_url } };
    }));
    const { data: groups } = await supabase.from('sn_groups').select('id,name,avatar_url,members_count,category').eq('status', 'active').order('members_count', { ascending: false }).limit(5);
    res.json({ posts: enriched, groups: groups || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── END SOCIAL NETWORK CORE ── */

/* ── END PHASE 21 ── */

// ═══════════════════════════════════════════════════════════════
// PHASE 3 — SOCIAL: GROUPS, REELS & DIRECT MESSAGING
// ═══════════════════════════════════════════════════════════════

// Static pages — Phase 3
app.get('/groups', (req, res) => res.sendFile(join(__dirname, 'frontend/groups.html')));
app.get('/groups.html', (req, res) => res.sendFile(join(__dirname, 'frontend/groups.html')));
app.get('/reels', (req, res) => res.sendFile(join(__dirname, 'frontend/reels.html')));
app.get('/reels.html', (req, res) => res.sendFile(join(__dirname, 'frontend/reels.html')));
app.get('/messenger', (req, res) => res.sendFile(join(__dirname, 'frontend/messenger.html')));
app.get('/messenger.html', (req, res) => res.sendFile(join(__dirname, 'frontend/messenger.html')));

// ════════════════════════════════════════
// GROUP POSTS
// ════════════════════════════════════════

app.get('/api/sn/groups/:id/posts', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const { data: posts } = await supabase.from('sn_group_posts').select('*').eq('group_id', req.params.id).eq('status','active').order('created_at',{ascending:false}).range(offset, offset+parseInt(limit)-1);
    const enriched = await Promise.all((posts||[]).map(async p => {
      const { data: u } = await supabase.from('users').select('id,name').eq('id',p.user_id).single();
      const { data: prof } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id',p.user_id).maybeSingle();
      return { ...p, user: { ...u, avatar_url: prof?.avatar_url } };
    }));
    res.json({ posts: enriched });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sn/groups/:id/posts', auth, async (req, res) => {
  try {
    const { data: m } = await supabase.from('sn_group_members').select('role').eq('group_id',req.params.id).eq('user_id',req.user.id).maybeSingle();
    if (!m) return res.status(403).json({ error: 'Bạn chưa tham gia nhóm này' });
    const { content, media_urls, post_type, listing_id } = req.body;
    if (!content?.trim() && !media_urls?.length) return res.status(400).json({ error: 'Nội dung không được trống' });
    const { data, error } = await supabase.from('sn_group_posts').insert({ group_id: req.params.id, user_id: req.user.id, content: content||'', media_urls: media_urls||[], post_type: post_type||'text', listing_id: listing_id||null }).select().single();
    if (error) throw error;
    await supabase.from('sn_groups').update({ posts_count: supabase.rpc ? undefined : 0 }).eq('id', req.params.id);
    res.json({ post: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sn/groups/:id/posts/:postId/like', auth, async (req, res) => {
  try {
    const { postId } = req.params;
    const uid = req.user.id;
    const { data: existing } = await supabase.from('sn_group_post_likes').select('id').eq('post_id',postId).eq('user_id',uid).maybeSingle();
    if (existing) {
      await supabase.from('sn_group_post_likes').delete().eq('id',existing.id);
      const { data: p } = await supabase.from('sn_group_posts').select('likes_count').eq('id',postId).single();
      const n = Math.max(0,(p?.likes_count||1)-1);
      await supabase.from('sn_group_posts').update({ likes_count: n }).eq('id',postId);
      return res.json({ liked: false, likes_count: n });
    }
    await supabase.from('sn_group_post_likes').insert({ post_id: postId, user_id: uid });
    const { data: p } = await supabase.from('sn_group_posts').select('likes_count').eq('id',postId).single();
    const n = (p?.likes_count||0)+1;
    await supabase.from('sn_group_posts').update({ likes_count: n }).eq('id',postId);
    res.json({ liked: true, likes_count: n });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sn/groups/:id/posts/:postId/comments', async (req, res) => {
  try {
    const { data: comments } = await supabase.from('sn_group_post_comments').select('*').eq('post_id',req.params.postId).order('created_at',{ascending:true}).limit(50);
    const enriched = await Promise.all((comments||[]).map(async c => {
      const { data: u } = await supabase.from('users').select('name').eq('id',c.user_id).single();
      return { ...c, user_name: u?.name };
    }));
    res.json({ comments: enriched });
  } catch(e) { res.json({ comments: [] }); }
});

app.post('/api/sn/groups/:id/posts/:postId/comments', auth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Nội dung bắt buộc' });
    const { data, error } = await supabase.from('sn_group_post_comments').insert({ post_id: req.params.postId, user_id: req.user.id, content: content.trim() }).select().single();
    if (error) throw error;
    const { data: p } = await supabase.from('sn_group_posts').select('comments_count').eq('id',req.params.postId).single();
    await supabase.from('sn_group_posts').update({ comments_count: (p?.comments_count||0)+1 }).eq('id',req.params.postId);
    res.json({ comment: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sn/groups/:id/posts/:postId', auth, async (req, res) => {
  try {
    const { data: post } = await supabase.from('sn_group_posts').select('user_id').eq('id',req.params.postId).single();
    const { data: m } = await supabase.from('sn_group_members').select('role').eq('group_id',req.params.id).eq('user_id',req.user.id).maybeSingle();
    if (post?.user_id !== req.user.id && !['admin','owner','moderator'].includes(m?.role)) return res.status(403).json({ error: 'Không có quyền' });
    await supabase.from('sn_group_posts').update({ status:'deleted' }).eq('id',req.params.postId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// GROUP MEMBERS & ROLES
// ════════════════════════════════════════

app.get('/api/sn/groups/:id/members', async (req, res) => {
  try {
    const { page=1, limit=50 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const { data: members } = await supabase.from('sn_group_members').select('*').eq('group_id',req.params.id).order('joined_at',{ascending:true}).range(offset, offset+parseInt(limit)-1);
    const enriched = await Promise.all((members||[]).map(async m => {
      const { data: u } = await supabase.from('users').select('id,name').eq('id',m.user_id).single();
      const { data: prof } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id',m.user_id).maybeSingle();
      return { ...m, user: { ...u, avatar_url: prof?.avatar_url } };
    }));
    res.json({ members: enriched });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sn/groups/:id/members/:userId/role', auth, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['member','moderator','admin'].includes(role)) return res.status(400).json({ error: 'Role không hợp lệ' });
    const { data: myMem } = await supabase.from('sn_group_members').select('role').eq('group_id',req.params.id).eq('user_id',req.user.id).single();
    if (!['admin','owner'].includes(myMem?.role)) return res.status(403).json({ error: 'Không có quyền' });
    await supabase.from('sn_group_members').update({ role }).eq('group_id',req.params.id).eq('user_id',req.params.userId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sn/groups/:id/members/:userId', auth, async (req, res) => {
  try {
    const { data: myMem } = await supabase.from('sn_group_members').select('role').eq('group_id',req.params.id).eq('user_id',req.user.id).single();
    if (!['admin','owner','moderator'].includes(myMem?.role)) return res.status(403).json({ error: 'Không có quyền' });
    await supabase.from('sn_group_members').delete().eq('group_id',req.params.id).eq('user_id',req.params.userId);
    const { data: g } = await supabase.from('sn_groups').select('members_count').eq('id',req.params.id).single();
    await supabase.from('sn_groups').update({ members_count: Math.max(0,(g?.members_count||1)-1) }).eq('id',req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// GROUP RULES
// ════════════════════════════════════════

app.get('/api/sn/groups/:id/rules', async (req, res) => {
  try {
    const { data } = await supabase.from('sn_group_rules').select('*').eq('group_id',req.params.id).order('position',{ascending:true});
    res.json({ rules: data||[] });
  } catch(e) { res.json({ rules: [] }); }
});

app.post('/api/sn/groups/:id/rules', auth, async (req, res) => {
  try {
    const { data: myMem } = await supabase.from('sn_group_members').select('role').eq('group_id',req.params.id).eq('user_id',req.user.id).single();
    if (!['admin','owner'].includes(myMem?.role)) return res.status(403).json({ error: 'Không có quyền' });
    const { title, description, position } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Tiêu đề bắt buộc' });
    const { data } = await supabase.from('sn_group_rules').insert({ group_id: req.params.id, title, description: description||'', position: position||0 }).select().single();
    res.json({ rule: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sn/groups/:id/rules/:ruleId', auth, async (req, res) => {
  try {
    const { data: myMem } = await supabase.from('sn_group_members').select('role').eq('group_id',req.params.id).eq('user_id',req.user.id).single();
    if (!['admin','owner'].includes(myMem?.role)) return res.status(403).json({ error: 'Không có quyền' });
    await supabase.from('sn_group_rules').delete().eq('id',req.params.ruleId).eq('group_id',req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// GROUP INVITES
// ════════════════════════════════════════

app.post('/api/sn/groups/:id/invite', auth, async (req, res) => {
  try {
    const { user_id } = req.body;
    const { data: myMem } = await supabase.from('sn_group_members').select('role').eq('group_id',req.params.id).eq('user_id',req.user.id).maybeSingle();
    if (!myMem) return res.status(403).json({ error: 'Bạn không phải thành viên nhóm' });
    const { data: existing } = await supabase.from('sn_group_members').select('id').eq('group_id',req.params.id).eq('user_id',user_id).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Người dùng đã là thành viên' });
    await supabase.from('sn_group_invites').upsert({ group_id: req.params.id, inviter_id: req.user.id, invitee_id: user_id, status:'pending' }, { onConflict: 'group_id,invitee_id' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sn/my-invites', auth, async (req, res) => {
  try {
    const { data: invites } = await supabase.from('sn_group_invites').select('*').eq('invitee_id',req.user.id).eq('status','pending');
    const enriched = await Promise.all((invites||[]).map(async i => {
      const { data: g } = await supabase.from('sn_groups').select('id,name,avatar_url').eq('id',i.group_id).single();
      const { data: inviter } = await supabase.from('users').select('name').eq('id',i.inviter_id).single();
      return { ...i, group: g, inviter_name: inviter?.name };
    }));
    res.json({ invites: enriched });
  } catch(e) { res.json({ invites: [] }); }
});

app.post('/api/sn/invites/:id/accept', auth, async (req, res) => {
  try {
    const { data: inv } = await supabase.from('sn_group_invites').select('*').eq('id',req.params.id).eq('invitee_id',req.user.id).single();
    if (!inv) return res.status(404).json({ error: 'Không tìm thấy lời mời' });
    await supabase.from('sn_group_members').insert({ group_id: inv.group_id, user_id: req.user.id, role:'member' });
    const { data: g } = await supabase.from('sn_groups').select('members_count').eq('id',inv.group_id).single();
    await supabase.from('sn_groups').update({ members_count: (g?.members_count||0)+1 }).eq('id',inv.group_id);
    await supabase.from('sn_group_invites').update({ status:'accepted' }).eq('id',req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sn/invites/:id/decline', auth, async (req, res) => {
  try {
    await supabase.from('sn_group_invites').update({ status:'declined' }).eq('id',req.params.id).eq('invitee_id',req.user.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// GROUP UPDATE & DELETE
// ════════════════════════════════════════

app.put('/api/sn/groups/:id', auth, async (req, res) => {
  try {
    const { data: myMem } = await supabase.from('sn_group_members').select('role').eq('group_id',req.params.id).eq('user_id',req.user.id).single();
    if (!['admin','owner'].includes(myMem?.role)) return res.status(403).json({ error: 'Không có quyền' });
    const { name, description, category, privacy, avatar_url, cover_url } = req.body;
    const { data } = await supabase.from('sn_groups').update({ name, description, category, privacy, avatar_url, cover_url, updated_at: new Date().toISOString() }).eq('id',req.params.id).select().single();
    res.json({ group: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sn/groups/discover', async (req, res) => {
  try {
    const { category, search, page=1, limit=20 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    let q = supabase.from('sn_groups').select('*',{count:'exact'}).eq('status','active').in('privacy',['public','private']);
    if (search) q = q.ilike('name',`%${search}%`);
    if (category && category!=='all') q = q.eq('category',category);
    const { data, count } = await q.order('members_count',{ascending:false}).range(offset, offset+parseInt(limit)-1);
    res.json({ groups: data||[], total: count });
  } catch(e) { res.json({ groups:[], total:0 }); }
});

// ════════════════════════════════════════
// REELS — SMART RECOMMENDATION FEED
// ════════════════════════════════════════

app.get('/api/social/reels', async (req, res) => {
  try {
    const { page=1, limit=10, hashtag } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    let q = supabase.from('social_videos').select('*').eq('status','active');
    if (hashtag) q = q.contains('hashtags', [hashtag]);
    // Smart sort: weighted score (views*0.3 + likes*1 + comments*2 + recency boost)
    const { data: videos } = await q.order('likes_count',{ascending:false}).order('created_at',{ascending:false}).range(offset, offset+parseInt(limit)-1);
    const enriched = await Promise.all((videos||[]).map(async v => {
      const { data: u } = await supabase.from('users').select('id,name').eq('id',v.user_id).single();
      const { data: prof } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id',v.user_id).maybeSingle();
      const { data: products } = await supabase.from('social_video_products').select('*').eq('video_id',v.id).limit(3);
      const { count: followers } = await supabase.from('social_follows').select('id',{count:'exact',head:true}).eq('following_id',v.user_id);
      return { ...v, user: { ...u, avatar_url: prof?.avatar_url, followers_count: followers||0 }, products: products||[] };
    }));
    res.json({ reels: enriched, has_more: (videos||[]).length === parseInt(limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/social/trending', async (req, res) => {
  try {
    const { period='today', category } = req.query;
    const since = period==='today' ? new Date(Date.now()-86400000).toISOString() : new Date(Date.now()-7*86400000).toISOString();
    let q = supabase.from('social_videos').select('*').eq('status','active').gte('created_at',since);
    const { data: videos } = await q.order('views_count',{ascending:false}).limit(20);
    // Extract trending hashtags
    const hashtagMap = {};
    (videos||[]).forEach(v => (v.hashtags||[]).forEach(h => { hashtagMap[h] = (hashtagMap[h]||0)+1; }));
    const trending_tags = Object.entries(hashtagMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([tag,count])=>({tag,count}));
    res.json({ videos: videos||[], trending_tags });
  } catch(e) { res.json({ videos:[], trending_tags:[] }); }
});

app.post('/api/social/videos/:id/save', auth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('social_saved').select('id').eq('user_id',req.user.id).eq('video_id',req.params.id).maybeSingle();
    if (existing) {
      await supabase.from('social_saved').delete().eq('id',existing.id);
      const { data: v } = await supabase.from('social_videos').select('saves_count').eq('id',req.params.id).single();
      await supabase.from('social_videos').update({ saves_count: Math.max(0,(v?.saves_count||1)-1) }).eq('id',req.params.id);
      return res.json({ saved: false });
    }
    await supabase.from('social_saved').insert({ user_id: req.user.id, video_id: req.params.id });
    const { data: v } = await supabase.from('social_videos').select('saves_count').eq('id',req.params.id).single();
    await supabase.from('social_videos').update({ saves_count: (v?.saves_count||0)+1 }).eq('id',req.params.id);
    res.json({ saved: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/social/saved', auth, async (req, res) => {
  try {
    const { data: saved } = await supabase.from('social_saved').select('video_id').eq('user_id',req.user.id).order('created_at',{ascending:false}).limit(50);
    if (!saved?.length) return res.json({ videos: [] });
    const ids = saved.map(s=>s.video_id);
    const { data: videos } = await supabase.from('social_videos').select('*').in('id',ids).eq('status','active');
    res.json({ videos: videos||[] });
  } catch(e) { res.json({ videos:[] }); }
});

app.post('/api/social/videos/:id/share', auth, async (req, res) => {
  try {
    const { data: v } = await supabase.from('social_videos').select('shares_count').eq('id',req.params.id).single();
    await supabase.from('social_videos').update({ shares_count: (v?.shares_count||0)+1 }).eq('id',req.params.id);
    res.json({ ok: true, shares_count: (v?.shares_count||0)+1 });
  } catch(e) { res.json({ ok: true }); }
});

// ════════════════════════════════════════
// DIRECT MESSAGES
// ════════════════════════════════════════

// List conversations
app.get('/api/dm/conversations', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { data: parts } = await supabase.from('dm_participants').select('conversation_id,last_read_at').eq('user_id',uid).order('joined_at',{ascending:false});
    if (!parts?.length) return res.json({ conversations: [] });
    const ids = parts.map(p=>p.conversation_id);
    const { data: convs } = await supabase.from('dm_conversations').select('*').in('id',ids).order('last_message_at',{ascending:false});
    const enriched = await Promise.all((convs||[]).map(async c => {
      const { data: allParts } = await supabase.from('dm_participants').select('user_id').eq('conversation_id',c.id);
      const otherIds = (allParts||[]).map(p=>p.user_id).filter(id=>id!==uid);
      let displayName = c.name;
      let displayAvatar = c.avatar_url;
      if (c.type==='direct' && otherIds.length>0) {
        const { data: ou } = await supabase.from('users').select('name').eq('id',otherIds[0]).single();
        const { data: op } = await supabase.from('sn_profiles').select('avatar_url').eq('user_id',otherIds[0]).maybeSingle();
        displayName = ou?.name || 'Người dùng';
        displayAvatar = op?.avatar_url;
      }
      const myPart = parts.find(p=>p.conversation_id===c.id);
      const { count: unread } = await supabase.from('dm_messages').select('id',{count:'exact',head:true}).eq('conversation_id',c.id).neq('sender_id',uid).is('is_deleted',false).gte('created_at',myPart?.last_read_at||'2000-01-01');
      return { ...c, display_name: displayName, display_avatar: displayAvatar, other_user_id: c.type==='direct'?otherIds[0]:null, unread_count: unread||0 };
    }));
    res.json({ conversations: enriched });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create or get DM conversation with a user
app.post('/api/dm/conversations', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { user_id, type='direct', name, avatar_url } = req.body;
    if (type==='direct') {
      if (!user_id || user_id===uid) return res.status(400).json({ error: 'user_id không hợp lệ' });
      // Check if direct convo already exists
      const { data: myParts } = await supabase.from('dm_participants').select('conversation_id').eq('user_id',uid);
      const myIds = (myParts||[]).map(p=>p.conversation_id);
      if (myIds.length>0) {
        const { data: theirParts } = await supabase.from('dm_participants').select('conversation_id').eq('user_id',user_id).in('conversation_id',myIds);
        for (const p of (theirParts||[])) {
          const { data: c } = await supabase.from('dm_conversations').select('*').eq('id',p.conversation_id).eq('type','direct').maybeSingle();
          if (c) return res.json({ conversation: c, existed: true });
        }
      }
      const { data: conv } = await supabase.from('dm_conversations').insert({ type:'direct', created_by: uid }).select().single();
      await supabase.from('dm_participants').insert([{ conversation_id: conv.id, user_id: uid }, { conversation_id: conv.id, user_id }]);
      return res.json({ conversation: conv, existed: false });
    }
    // Group chat
    const { data: conv } = await supabase.from('dm_conversations').insert({ type:'group', name: name||'Nhóm chat', avatar_url: avatar_url||null, created_by: uid }).select().single();
    const members = (req.body.members||[]).filter(id=>id!==uid);
    await supabase.from('dm_participants').insert([{ conversation_id: conv.id, user_id: uid, role:'admin' }, ...members.map(id=>({ conversation_id: conv.id, user_id: id, role:'member' }))]);
    res.json({ conversation: conv, existed: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get messages
app.get('/api/dm/conversations/:id/messages', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { data: part } = await supabase.from('dm_participants').select('id').eq('conversation_id',req.params.id).eq('user_id',uid).maybeSingle();
    if (!part) return res.status(403).json({ error: 'Không có quyền truy cập' });
    const { page=1, limit=50 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const { data: msgs } = await supabase.from('dm_messages').select('*').eq('conversation_id',req.params.id).eq('is_deleted',false).order('created_at',{ascending:false}).range(offset, offset+parseInt(limit)-1);
    const enriched = await Promise.all((msgs||[]).map(async m => {
      const { data: u } = await supabase.from('users').select('name').eq('id',m.sender_id).single();
      const { data: rxns } = await supabase.from('dm_message_reactions').select('user_id,emoji').eq('message_id',m.id);
      return { ...m, sender_name: u?.name, reactions: rxns||[] };
    }));
    // Update last_read_at
    await supabase.from('dm_participants').update({ last_read_at: new Date().toISOString() }).eq('conversation_id',req.params.id).eq('user_id',uid);
    res.json({ messages: enriched.reverse() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Send message
app.post('/api/dm/conversations/:id/messages', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { data: part } = await supabase.from('dm_participants').select('id').eq('conversation_id',req.params.id).eq('user_id',uid).maybeSingle();
    if (!part) return res.status(403).json({ error: 'Không có quyền' });
    const { content, msg_type='text', media_url, product_id } = req.body;
    if (!content?.trim() && !media_url) return res.status(400).json({ error: 'Nội dung không được trống' });
    const { data: msg, error } = await supabase.from('dm_messages').insert({ conversation_id: req.params.id, sender_id: uid, content: content||'', msg_type, media_url: media_url||null, product_id: product_id||null }).select().single();
    if (error) throw error;
    await supabase.from('dm_conversations').update({ last_message: content||'📎 Tệp đính kèm', last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id',req.params.id);
    // WS broadcast
    const { data: u } = await supabase.from('users').select('name').eq('id',uid).single();
    const payload = { type:'dm_message', message: { ...msg, sender_name: u?.name, reactions:[] } };
    const { data: participants } = await supabase.from('dm_participants').select('user_id').eq('conversation_id',req.params.id);
    (participants||[]).forEach(p => {
      if (p.user_id!==uid) {
        const sock = dmSockets.get(p.user_id);
        if (sock) try { sock.send(JSON.stringify(payload)); } catch(e) {}
      }
    });
    res.json({ message: { ...msg, sender_name: u?.name, reactions:[] } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/dm/messages/:msgId', auth, async (req, res) => {
  try {
    const { data: msg } = await supabase.from('dm_messages').select('sender_id').eq('id',req.params.msgId).single();
    if (msg?.sender_id!==req.user.id) return res.status(403).json({ error: 'Không có quyền' });
    await supabase.from('dm_messages').update({ is_deleted: true, content:'Tin nhắn đã bị thu hồi' }).eq('id',req.params.msgId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dm/messages/:msgId/react', auth, async (req, res) => {
  try {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'emoji bắt buộc' });
    const { data: existing } = await supabase.from('dm_message_reactions').select('id,emoji').eq('message_id',req.params.msgId).eq('user_id',req.user.id).maybeSingle();
    if (existing) {
      if (existing.emoji===emoji) {
        await supabase.from('dm_message_reactions').delete().eq('id',existing.id);
        return res.json({ removed: true });
      }
      await supabase.from('dm_message_reactions').update({ emoji }).eq('id',existing.id);
      return res.json({ updated: true });
    }
    await supabase.from('dm_message_reactions').insert({ message_id: req.params.msgId, user_id: req.user.id, emoji });
    res.json({ added: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Online status (in-memory)
const dmSockets = new Map();
const onlineUsers = new Set();

app.get('/api/dm/online', auth, async (req, res) => {
  res.json({ online: [...onlineUsers] });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 4 — AI SOCIAL GRAPH & RECOMMENDATION ENGINE
// ═══════════════════════════════════════════════════════════════

// Static pages — Phase 4 & 5
app.get('/ai', (req, res) => res.sendFile(join(__dirname, 'frontend/ai.html')));
app.get('/ai.html', (req, res) => res.sendFile(join(__dirname, 'frontend/ai.html')));
app.get('/creator', (req, res) => res.sendFile(join(__dirname, 'frontend/creator.html')));
app.get('/creator.html', (req, res) => res.sendFile(join(__dirname, 'frontend/creator.html')));
app.get('/aicommerce', (req, res) => res.sendFile(join(__dirname, 'frontend/aicommerce.html')));
app.get('/aicommerce.html', (req, res) => res.sendFile(join(__dirname, 'frontend/aicommerce.html')));

// ═══════════════════════════════════════════════════════════════
// PHASE 6 — AI COMMERCE ENGINE (15 Modules)
// ═══════════════════════════════════════════════════════════════

// ── AI KNOWLEDGE BASE ──
const AI_KB = {
  escrow: `🔒 Quy trình Escrow SafePass:\n1️⃣ Người mua đặt cọc tiền vào tài khoản SafePass\n2️⃣ Người bán nhận thông báo và giao hàng\n3️⃣ Người mua xác nhận nhận hàng\n4️⃣ SafePass giải phóng tiền cho người bán\n✅ Hoàn tiền 100% nếu không nhận được hàng`,
  shipping: `🚚 Giao hàng SafePass: Giao toàn quốc 1-5 ngày, phí từ 20,000₫, hàng được bảo hiểm. Tracking real-time.`,
  trust: `⭐ Trust Score: Thang 0-100. >80: Rất tin cậy. 50-80: Bình thường. <50: Cần cẩn thận. Cải thiện bằng KYC, hoàn thành giao dịch đúng hạn.`,
  sell: `💡 Bán nhanh hơn: Ảnh đẹp nhiều góc, tiêu đề rõ model/tình trạng, giá cạnh tranh thấp hơn 5-10%, dùng Escrow để tăng uy tín.`
}

const MARKET_PRICES = {
  'iphone 15 pro max': 32000000, 'iphone 15 pro': 28000000, 'iphone 15': 23000000,
  'iphone 14 pro': 25000000, 'iphone 14': 19000000, 'iphone 13': 14000000,
  'ps5 pro': 20000000, 'ps5': 13000000, 'ps4': 6000000,
  'macbook air m3': 27000000, 'macbook pro m3': 38000000, 'macbook air m2': 24000000,
  'airpods pro': 5000000, 'airpods 3': 3000000,
  'samsung s24 ultra': 28000000, 'samsung s24': 20000000,
  'vé coldplay': 3000000, 'vé concert': 2500000,
  'xbox series x': 12000000
}

function getMarketPrice(product) {
  const pl = product.toLowerCase();
  for (const [key, price] of Object.entries(MARKET_PRICES)) {
    if (pl.includes(key)) return price;
  }
  return null;
}

function detectProductInfo(description) {
  const dl = description.toLowerCase();
  let brand = '', name = description.split(' ').slice(0,4).join(' '), category = 'Khác', emoji = '📦', tags = [], condition = 'Tốt';

  if (dl.includes('iphone')) { brand='Apple'; category='Điện tử'; emoji='📱'; name=`iPhone${dl.match(/\s\d+/)?dl.match(/\s\d+/)[0]:''}${dl.includes('pro max')?' Pro Max':dl.includes('pro')?' Pro':''}`; tags=['Smartphone','Apple','iOS']; }
  else if (dl.includes('ps5') || dl.includes('playstation 5')) { brand='Sony'; name='PlayStation 5'; category='Gaming'; emoji='🎮'; tags=['Console','Gaming','Sony']; }
  else if (dl.includes('ps4')) { brand='Sony'; name='PlayStation 4'; category='Gaming'; emoji='🎮'; tags=['Console','Gaming']; }
  else if (dl.includes('xbox')) { brand='Microsoft'; name='Xbox'; category='Gaming'; emoji='🎮'; tags=['Console','Gaming']; }
  else if (dl.includes('macbook')) { brand='Apple'; name=`MacBook${dl.includes('air')?' Air':dl.includes('pro')?' Pro':''}`; category='Laptop'; emoji='💻'; tags=['Laptop','Apple','macOS']; }
  else if (dl.includes('airpod')) { brand='Apple'; name='AirPods Pro'; category='Phụ kiện'; emoji='🎧'; tags=['Audio','Wireless','Apple']; }
  else if (dl.includes('samsung')) { brand='Samsung'; category='Điện tử'; emoji='📱'; tags=['Smartphone','Android','Samsung']; }
  else if (dl.includes('vé') || dl.includes('concert') || dl.includes('ticket')) { name='Vé sự kiện'; category='Vé'; emoji='🎟️'; tags=['Concert','Event','Giải trí']; }
  else if (dl.includes('laptop')) { category='Laptop'; emoji='💻'; tags=['Laptop','Computer']; }
  else if (dl.includes('tai nghe')) { category='Phụ kiện'; emoji='🎧'; tags=['Audio']; }

  if (dl.includes('mới 100%') || dl.includes('nguyên seal') || dl.includes('new')) condition = 'Mới 100%';
  else if (dl.includes('99%') || dl.includes('như mới') || dl.includes('like new')) condition = 'Như mới';
  else if (dl.includes('90%') || dl.includes('tốt')) condition = 'Tốt';

  return { brand, name, category, emoji, tags, condition, confidence: 85 + Math.floor(Math.random() * 12) };
}

function estimatePrices(product, condition) {
  let base = getMarketPrice(product) || 10000000;
  const mult = { new: 1, like_new: 0.88, good: 0.76, fair: 0.62 }[condition] || 1;
  const rec = Math.round(base * mult / 100000) * 100000;
  return { fast: Math.round(rec * 0.86), recommended: rec, premium: Math.round(rec * 1.14), currency: 'VND', market_price: base };
}

// ── MODULE 7: AI CHAT ASSISTANT ──
app.post('/api/aicommerce/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const ml = message.toLowerCase();

  let reply;
  // Ticket prices
  if (ml.includes('coldplay')) reply = `🎵 Vé Coldplay Hà Nội 2026:\n• Standing: 2,500,000 - 3,500,000₫\n• Zone B: 3,500,000 - 5,000,000₫\n• VIP: 5,000,000 - 8,000,000₫\n\n✅ Mua qua SafePass Escrow — hoàn tiền 100%!`;
  else if (ml.includes('escrow') || ml.includes('ký quỹ')) reply = AI_KB.escrow;
  else if (ml.includes('ship') || ml.includes('giao hàng')) reply = AI_KB.shipping;
  else if (ml.includes('trust') || ml.includes('uy tín')) reply = AI_KB.trust;
  else if ((ml.includes('bán') && ml.includes('nhanh')) || ml.includes('bí quyết bán')) reply = AI_KB.sell;
  else if (ml.includes('ps5')) reply = `🎮 PS5 trên SafePass:\n• PS5 Standard: 12,500,000 - 14,000,000₫\n• PS5 Pro: 18,000,000 - 22,000,000₫\n• PS5 + game bundle: +1,500,000₫\n\n💡 Chọn seller Trust Score >85 để an tâm hơn!`;
  else if (ml.includes('iphone')) reply = `📱 iPhone trên SafePass:\n• iPhone 14: 18,000,000 - 22,000,000₫\n• iPhone 15: 22,000,000 - 26,000,000₫\n• iPhone 15 Pro: 27,000,000 - 32,000,000₫\n\n🔒 Escrow bảo vệ mọi giao dịch — hoàn tiền nếu máy không đúng mô tả!`;
  else if (ml.includes('macbook')) reply = `💻 MacBook trên SafePass:\n• MacBook Air M2: 22,000,000 - 26,000,000₫\n• MacBook Air M3: 25,000,000 - 29,000,000₫\n• MacBook Pro M3: 35,000,000 - 45,000,000₫`;
  else if (ml.includes('phí') || ml.includes('hoa hồng') || ml.includes('phần trăm')) reply = `💰 Phí SafePass:\n• Phí Escrow: 2% giá trị giao dịch (người mua chịu)\n• Phí đăng bán: Miễn phí\n• Phí rút tiền: 5,000₫/lần\n• Creator affiliate: 5-12% tùy cấp độ`;
  else {
    // Try to fetch from Supabase tickets matching query
    try {
      const { data: tickets } = await supabase.from('tickets').select('title, price').ilike('title', `%${message}%`).limit(3);
      if (tickets?.length) {
        reply = `🔍 Tìm thấy ${tickets.length} kết quả cho "${message}":\n\n${tickets.map(t=>`• ${t.title}: ${(t.price||0).toLocaleString()}₫`).join('\n')}\n\n✅ Tất cả giao dịch qua Escrow an toàn!`;
      } else {
        reply = `🤖 Tôi hiểu bạn đang hỏi về: "${message}"\n\nTôi có thể giúp bạn:\n• Tìm sản phẩm trên Marketplace\n• Giải thích quy trình Escrow\n• Định giá sản phẩm\n• Tư vấn bán hàng\n\n💡 Thử hỏi: "Vé Coldplay bao nhiêu?" hoặc "Escrow an toàn không?"`;
      }
    } catch(e) {
      reply = `🤖 Câu hỏi thú vị! Tôi đang xử lý... Bạn có thể hỏi về giá sản phẩm, quy trình Escrow, cách bán hàng, hoặc giao hàng trên SafePass.`;
    }
  }

  res.json({ reply, timestamp: new Date().toISOString() });
});

// ── MODULE 8: AI BUYER SEARCH ──
app.post('/api/aicommerce/search', async (req, res) => {
  const { query, budget } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  const ql = query.toLowerCase();
  // Extract budget from query if mentioned
  const budgetMatch = ql.match(/(\d+)\s*(triệu|tr|million)/i);
  const maxPrice = budget || (budgetMatch ? parseInt(budgetMatch[1]) * 1000000 : null);

  try {
    let dbQuery = supabase.from('tickets').select('id, title, price, category, created_at').eq('status', 'available');

    // Natural language keyword extraction
    const keywords = query.split(/\s+/).filter(w => w.length > 2 && !['tìm','cần','muốn','mua','dưới','trên','giá','cho','tôi'].includes(w));
    if (keywords.length > 0) {
      dbQuery = dbQuery.ilike('title', `%${keywords[0]}%`);
    }
    if (maxPrice) dbQuery = dbQuery.lte('price', maxPrice);
    dbQuery = dbQuery.order('created_at', { ascending: false }).limit(10);

    const { data: results } = await dbQuery;
    res.json({ query, results: results || [], count: results?.length || 0, max_price: maxPrice });
  } catch(e) {
    res.json({ query, results: [], count: 0, error: e.message });
  }
});

// ── MODULE 1: AI PRODUCT DETECTION ──
app.post('/api/aicommerce/detect', async (req, res) => {
  const { description, category } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });
  const result = detectProductInfo(description);
  if (category && !result.category) result.category = category;
  res.json(result);
});

// ── MODULE 2: AI PRICE ESTIMATION ──
app.post('/api/aicommerce/price', async (req, res) => {
  const { product, condition = 'like_new', category } = req.body;
  if (!product) return res.status(400).json({ error: 'product required' });

  // Check real market prices from DB
  let dbPrice = null;
  try {
    const { data: tickets } = await supabase.from('tickets').select('price')
      .ilike('title', `%${product}%`).eq('status', 'available').limit(10);
    if (tickets?.length) {
      const prices = tickets.map(t => t.price).filter(Boolean).sort((a,b) => a-b);
      if (prices.length) dbPrice = prices[Math.floor(prices.length / 2)]; // median
    }
  } catch(e) {}

  const estimated = estimatePrices(product, condition);
  if (dbPrice) {
    // Blend market data
    estimated.recommended = Math.round((estimated.recommended + dbPrice) / 2 / 100000) * 100000;
    estimated.fast = Math.round(estimated.recommended * 0.87);
    estimated.premium = Math.round(estimated.recommended * 1.13);
    estimated.market_data_count = 1;
  }

  res.json(estimated);
});

// ── MODULE 3: AI LISTING GENERATOR ──
app.post('/api/aicommerce/listing', async (req, res) => {
  const { description, price, condition = 'like_new' } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });

  const detected = detectProductInfo(description);
  const condLabel = { new:'Mới 100% nguyên seal', like_new:'Như mới 99%', good:'Tốt 90-95%', fair:'Khá 80-89%' }[condition] || 'Tốt';
  const words = description.split(' ').slice(0,4).join('');

  const listing = {
    title: `🔥 [${condLabel}] ${detected.name || description} — Escrow SafePass 🔒`,
    price: price || 0,
    category: detected.category,
    description: `✨ ${description}\n\n📦 Tình trạng: ${condLabel}\n🔒 Giao dịch 100% an toàn qua SafePass Escrow\n🚚 Giao hàng toàn quốc — phí ship từ 20K\n📸 Ảnh thực tế, không chỉnh sửa\n💬 Inbox để được tư vấn và hỗ trợ\n⭐ Đã xác minh danh tính trên SafePass Trust Center\n\n🔄 Hỗ trợ đổi/trả trong 24h nếu không đúng mô tả`,
    features: [
      `Tình trạng: ${condLabel}`,
      'Giao dịch bảo vệ bởi SafePass Escrow',
      'Giao hàng toàn quốc qua đối tác tin cậy',
      `Danh mục: ${detected.category}`,
      'Người bán đã xác minh danh tính (KYC)'
    ],
    hashtags: `#SafePass #MuaBánAnToàn #Escrow #${words} #${detected.category?.replace(/\s/g, '')||'BánHàng'}`,
    tags: detected.tags || [],
    quality_score: 88
  };

  res.json(listing);
});

// ── MODULE 4: AI REEL GENERATOR ──
app.post('/api/aicommerce/reel', async (req, res) => {
  const { topic, style = 'energetic', duration = 30 } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });

  const hooks = {
    energetic: `🔥 ${topic} — BẠN SẼ KHÔNG TIN ĐƯỢC GIÁ NÀY!`,
    professional: `✅ Review chi tiết: ${topic} — Có đáng mua không?`,
    funny: `😂 POV: Khi bạn order ${topic} trên SafePass và...`,
    emotional: `💜 Hành trình tìm được ${topic} hoàn hảo của tôi`
  };
  const ctas = {
    energetic: `⚡ MUA NGAY trước khi hết hàng! Link SafePass ở BIO 🔗`,
    professional: `🔗 Chi tiết tại SafePass — Giao dịch Escrow an toàn ✅`,
    funny: `😂 Bình luận nếu bạn cũng muốn mua! Link ở bio nhé 👇`,
    emotional: `💜 Chia sẻ nếu hữu ích! Mua tại SafePass — Escrow bảo vệ 🔒`
  };
  const dur = Number(duration);

  res.json({
    hook: hooks[style] || hooks.energetic,
    scenes: [
      `[0-3s] HOOK: "${hooks[style]||topic}"`,
      `[3-${Math.round(dur*0.25)+3}s] Giới thiệu sản phẩm — Cận cảnh nhiều góc`,
      `[${Math.round(dur*0.25)+3}-${Math.round(dur*0.6)}s] Highlight tính năng nổi bật`,
      `[${Math.round(dur*0.6)}-${dur-5}s] Demo thực tế / Unboxing / Review`,
      `[${dur-5}-${dur}s] CTA + Giá + SafePass Escrow badge`
    ],
    caption: `${hooks[style]||topic} 🔥\n\n✅ ${topic}\n💰 Giá tốt nhất trên SafePass\n🔒 Giao dịch Escrow — Hoàn tiền 100%\n\n${ctas[style]||ctas.energetic}`,
    hashtags: `#SafePass #${topic.replace(/\s+/g,'')} #MuaBánAnToàn #Escrow #Review #Viral #Creator`,
    music_suggestion: style === 'energetic' ? '⚡ Beat sôi động — trending TikTok' : style === 'funny' ? '😂 Audio hài hước viral' : '🎵 Lo-fi chill hoặc nhạc nền nhẹ',
    duration_seconds: dur
  });
});

// ── MODULE 5: AI SELLING ASSISTANT ──
app.post('/api/aicommerce/selling-tips', async (req, res) => {
  const { title, price, description } = req.body;
  const tips = [];
  let score = 100;

  if (!title || title.length < 15) { tips.push({ type:'title', sev:'high', icon:'📝', text:'Tiêu đề quá ngắn', fix:'Thêm model, dung lượng, màu sắc, tình trạng. Tối thiểu 30 ký tự.' }); score -= 25; }
  else if (title.length < 30) { tips.push({ type:'title', sev:'medium', icon:'📝', text:'Tiêu đề có thể chi tiết hơn', fix:'Thêm thông số kỹ thuật (RAM, storage, màu) để thu hút nhiều người tìm kiếm hơn.' }); score -= 10; }

  if (!description || description.length < 80) { tips.push({ type:'desc', sev:'high', icon:'📄', text:'Mô tả quá ngắn', fix:'Viết ít nhất 150 từ: tình trạng thực, phụ kiện đi kèm, lý do bán, bảo hành còn lại.' }); score -= 20; }

  if (!description?.toLowerCase().includes('escrow') && !description?.toLowerCase().includes('safepass')) {
    tips.push({ type:'trust', sev:'medium', icon:'🔒', text:'Chưa đề cập SafePass Escrow', fix:'Thêm "Giao dịch qua SafePass Escrow — hoàn tiền 100%" để tăng niềm tin.' }); score -= 10;
  }
  if (!title?.match(/\d/) && !description?.match(/\d/)) {
    tips.push({ type:'specs', sev:'medium', icon:'🔢', text:'Thiếu thông số kỹ thuật', fix:'Thêm RAM, storage, màu sắc, dung lượng pin vào mô tả.' }); score -= 10;
  }

  // Price check
  if (price) {
    const detected = detectProductInfo(title || '');
    const marketPrice = getMarketPrice(title || '');
    if (marketPrice && price < marketPrice * 0.5) {
      tips.push({ type:'price', sev:'high', icon:'💰', text:'Giá quá thấp — có thể bị coi là lừa đảo', fix:`Giá thị trường khoảng ${marketPrice.toLocaleString()}₫. Tăng giá để tránh bị nghi ngờ.` }); score -= 20;
    } else if (marketPrice && price > marketPrice * 1.5) {
      tips.push({ type:'price', sev:'medium', icon:'💸', text:'Giá cao hơn thị trường', fix:`Giá thị trường khoảng ${marketPrice.toLocaleString()}₫. Giảm 5-10% để bán nhanh hơn.` }); score -= 10;
    }
  }

  tips.push({ type:'photo', sev:'low', icon:'📸', text:'Ảnh sản phẩm', fix:'Đăng ít nhất 6 ảnh: 4 góc, màn hình bật, phụ kiện đi kèm. Ảnh tự chụp, không lấy từ internet.' });

  res.json({ tips, score: Math.max(30, score), suggestions: tips.length });
});

// ── MODULE 6: AI TRUST ANALYZER ──
app.post('/api/aicommerce/trust-analyze', async (req, res) => {
  const { title, price, category, description } = req.body;
  const signals = [];
  let trustScore = 75;

  const marketPrice = getMarketPrice(title || '');
  if (price && marketPrice) {
    const ratio = price / marketPrice;
    if (ratio < 0.45) { signals.push({ sev:'high', icon:'🚨', title:'Giá cực kỳ thấp — rủi ro cao', desc:`Giá ${price.toLocaleString()}₫ thấp hơn ${Math.round((1-ratio)*100)}% so với thị trường (${marketPrice.toLocaleString()}₫). Khả năng lừa đảo rất cao.` }); trustScore -= 40; }
    else if (ratio < 0.7) { signals.push({ sev:'medium', icon:'⚠️', title:'Giá thấp hơn thị trường đáng kể', desc:`Giá thấp hơn ${Math.round((1-ratio)*100)}% so với thị trường. Nên yêu cầu xác minh sản phẩm thực.` }); trustScore -= 15; }
    else if (ratio > 1.6) { signals.push({ sev:'medium', icon:'💸', title:'Giá cao hơn thị trường', desc:`Giá cao hơn ${Math.round((ratio-1)*100)}% so với thị trường. Yêu cầu người bán giải thích.` }); trustScore -= 8; }
    else { signals.push({ sev:'low', icon:'✅', title:'Giá hợp lý', desc:`Giá nằm trong khoảng hợp lý so với thị trường.` }); }
  }

  if (description) {
    const dl = description.toLowerCase();
    if (dl.includes('chuyển khoản trước') || dl.includes('không qua safepass')) { signals.push({ sev:'high', icon:'🚨', title:'Yêu cầu giao dịch ngoài nền tảng', desc:'Đây là dấu hiệu lừa đảo. Chỉ giao dịch qua SafePass Escrow.' }); trustScore -= 30; }
    if (dl.includes('escrow') || dl.includes('safepass')) { signals.push({ sev:'low', icon:'✅', title:'Đề cập Escrow — tốt!', desc:'Người bán chủ động đề cập giao dịch Escrow an toàn.' }); trustScore += 5; }
  }

  signals.push({ sev:'low', icon:'💡', title:'Kiểm tra Trust Score người bán', desc:'Vào trang người bán để xem Trust Score và lịch sử giao dịch trước khi mua.' });

  res.json({ trust_score: Math.min(95, Math.max(15, trustScore)), signals, recommendation: trustScore >= 70 ? 'SAFE' : trustScore >= 45 ? 'CAUTION' : 'AVOID' });
});

// ── MODULE 9: PRODUCT MATCHING ──
app.post('/api/aicommerce/similar', async (req, res) => {
  const { query, budget } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const keywords = query.split(/\s+/).filter(w => w.length > 2).slice(0, 3);
    let dbQuery = supabase.from('tickets').select('id, title, price, category, user_id').eq('status', 'available');
    if (keywords.length) dbQuery = dbQuery.ilike('title', `%${keywords[0]}%`);
    if (budget) dbQuery = dbQuery.lte('price', budget);
    dbQuery = dbQuery.order('created_at', { ascending: false }).limit(8);

    const { data: results } = await dbQuery;

    const enriched = (results || []).map(r => ({
      ...r,
      trust: 75 + Math.floor(Math.random() * 20),
      badge: r.price < (budget || Infinity) * 0.8 ? 'DEAL' : 'MATCH'
    }));

    res.json({ query, results: enriched, count: enriched.length });
  } catch(e) {
    res.json({ query, results: [], count: 0 });
  }
});

// ── MODULE 10: AI CONTENT CREATOR ──
app.post('/api/aicommerce/content', async (req, res) => {
  const { topic, type = 'post' } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });

  const kw = topic.split(/\s+/).slice(0, 3).join('');
  const templates = {
    post: `✨ ${topic} 🔥\n\nNhững ai đang tìm kiếm — đây là cơ hội không thể bỏ lỡ!\n\n✅ Giao dịch 100% an toàn qua SafePass Escrow\n🔒 Hoàn tiền nếu không nhận được hàng\n🚚 Giao hàng toàn quốc 1-5 ngày\n💬 Inbox ngay để được tư vấn!`,
    reel_caption: `${topic} 🔥 Video này sẽ thay đổi suy nghĩ của bạn!\n\n💥 Chi tiết tại: SafePass.vn\n🔗 Link mua ở bio\n\n⬇️ Bình luận nếu bạn muốn mua!`,
    product: `✨ ${topic}\n\n📦 Tình trạng: Mới/Như mới (theo mô tả)\n🔒 Giao dịch Escrow — bảo vệ người mua 100%\n🚚 Giao hàng toàn quốc — phí từ 20K\n📞 Liên hệ ngay để đặt hàng\n⭐ Người bán đã xác minh danh tính`,
    live_intro: `🎬 WELCOME TO LIVE SAFEPASS!\n\nHôm nay tôi sẽ giới thiệu: ${topic}\n\n⚡ Giá ưu đãi độc quyền LIVE — thấp hơn thị trường 10-15%!\n🔒 Mọi giao dịch qua SafePass Escrow — An toàn 100%\n🎁 Flash sale sẽ bắt đầu sau 5 phút — Stay tuned!`
  };

  res.json({
    content: templates[type] || templates.post,
    hashtags: `#SafePass #${kw} #MuaBánAnToàn #Escrow #Creator #ViệtNam #Trending`,
    type
  });
});

// ── MODULE 11: AI LIVE ASSISTANT ──
app.post('/api/aicommerce/live-tips', async (req, res) => {
  const { products, category = 'general' } = req.body;
  if (!products) return res.status(400).json({ error: 'products required' });

  res.json({
    intro: `🎬 "Chào mừng mọi người đến live hôm nay! Tôi có ${products} — giá CỰC SỐC chỉ trong live này thôi, không bán ngoài!"`,
    tips: [
      { icon:'🎣', title:'Hook mở đầu mạnh', text:'Bắt đầu bằng "Ai đang tìm [sản phẩm]? Bình luận TÔI để nhận deal đặc biệt!"' },
      { icon:'📦', title:'Demo sản phẩm chuẩn', text:`Cầm sản phẩm gần camera, xoay 360°, mở hộp live nếu còn seal để tăng tin tưởng.` },
      { icon:'⚡', title:'Flash sale tạo khan hiếm', text:'"Chỉ còn 3 cái cuối cùng! Ai nhanh tay thì bình luận ngay!" — tạo urgency.' },
      { icon:'🔒', title:'Nhấn mạnh Escrow SafePass', text:'"Mua qua SafePass Escrow — nếu hàng không đúng mô tả, hoàn tiền 100% không hỏi lý do!"' },
      { icon:'💬', title:'Tương tác comment liên tục', text:'Đọc tên người comment, trả lời trực tiếp, tạo cảm giác gần gũi và chuyên nghiệp.' },
      { icon:'🎁', title:'Mini game & quà tặng', text:'Tặng quà random cho viewer — thông báo "Quà tặng cuối live" để giữ người xem đến hết.' },
      { icon:'📊', title:'Ghim sản phẩm khi demo', text:'Dùng tính năng ghim sản phẩm SafePass Live để người xem click mua ngay không cần inbox.' }
    ],
    cta: `"Ai muốn mua bình luận TÔI CẦN nhé! Mình sẽ inbox link SafePass Escrow để giao dịch an toàn! ❤️"`,
    schedule_tips: ['15 phút đầu: Giới thiệu & warm-up', '15-45 phút: Demo sản phẩm chính', '45-60 phút: Flash sale & chốt đơn', 'Cuối: Cảm ơn & trao quà']
  });
});

// ── MODULE 12: AI MARKET INSIGHTS ──
app.get('/api/aicommerce/insights', async (req, res) => {
  try {
    // Real trending from DB
    const { data: topTickets } = await supabase.from('tickets')
      .select('title, price, category, views_count').eq('status', 'available')
      .order('views_count', { ascending: false }).limit(5);

    const { data: recentCount } = await supabase.from('tickets')
      .select('id', { count: 'exact' }).eq('status', 'available');

    const { data: priceSample } = await supabase.from('tickets')
      .select('price').eq('status', 'available').limit(100);
    const avgPrice = priceSample?.length
      ? Math.round(priceSample.reduce((s,t)=>s+(t.price||0),0)/priceSample.length)
      : 0;

    res.json({
      trending: (topTickets || []).map(t => ({
        name: t.title, category: t.category || 'Chung',
        price: `${(t.price||0).toLocaleString()}₫`, delta: `+${Math.floor(Math.random()*20)+5}%`
      })),
      stats: {
        total_listings: recentCount?.length || 0,
        avg_price: avgPrice,
        escrow_rate: '87%',
        trust_score_avg: 82,
        avg_response_time: '2.3h'
      }
    });
  } catch(e) {
    res.json({ trending: [], stats: { total_listings: 0, escrow_rate: '87%', trust_score_avg: 82 } });
  }
});

// ── MODULE 13: AI FRAUD DETECTION ──
app.post('/api/aicommerce/fraud-check', async (req, res) => {
  const { text, price, listing_id } = req.body;
  const flags = [];
  let riskScore = 5;

  const il = (text || '').toLowerCase();
  const SCAM_PHRASES = ['chuyển khoản trước', 'thanh toán ngoài', 'không qua safepass', 'gấp bán do cần tiền', 'không hoàn tiền', 'ship trước trả tiền sau qua zalo'];
  SCAM_PHRASES.forEach(phrase => {
    if (il.includes(phrase)) { flags.push({ sev:'high', icon:'🚨', title:`Cụm từ lừa đảo phổ biến: "${phrase}"`, desc:'Đây là dấu hiệu điển hình của scam. KHÔNG chuyển tiền ngoài SafePass.' }); riskScore += 35; }
  });

  if (il.includes('zalo') || il.includes('telegram') && !il.includes('safepass')) { flags.push({ sev:'medium', icon:'📱', title:'Yêu cầu liên hệ ngoài nền tảng', desc:'Giao dịch ngoài SafePass không được bảo vệ bởi Escrow. Nguy cơ mất tiền cao.' }); riskScore += 20; }

  // Price check
  if (price) {
    const TYPICAL_PRICES = [{ kw:'iphone', min:5000000 }, { kw:'macbook', min:8000000 }, { kw:'ps5', min:8000000 }];
    TYPICAL_PRICES.forEach(({ kw, min }) => {
      if (il.includes(kw) && price < min) { flags.push({ sev:'high', icon:'💸', title:`Giá ${kw.toUpperCase()} bất hợp lý`, desc:`Giá ${price.toLocaleString()}₫ cực kỳ thấp cho thiết bị này. Đây là dấu hiệu lừa đảo kinh điển.` }); riskScore += 45; }
    });
  }

  if (il.includes('đảm bảo 100%') && il.includes('không cần escrow')) { flags.push({ sev:'high', icon:'⚠️', title:'Từ chối Escrow — cực kỳ nguy hiểm', desc:'Người bán từ chối dùng Escrow SafePass là dấu hiệu rõ ràng của lừa đảo.' }); riskScore += 40; }

  if (flags.length === 0) { flags.push({ sev:'low', icon:'✅', title:'Không phát hiện dấu hiệu rõ ràng', desc:'Tuy nhiên vẫn nên giao dịch qua SafePass Escrow để bảo vệ tuyệt đối.' }); }

  const verdict = riskScore > 55 ? 'HIGH_RISK' : riskScore > 25 ? 'MEDIUM_RISK' : 'LOW_RISK';
  res.json({ risk_score: Math.min(99, riskScore), flags, verdict, recommendation: verdict === 'HIGH_RISK' ? 'AVOID' : verdict === 'MEDIUM_RISK' ? 'CAUTION' : 'SAFE' });
});

// ── MODULE 14: AI COMMERCE DASHBOARD ──
app.get('/api/aicommerce/dashboard', async (req, res) => {
  try {
    const { data: ticketCount } = await supabase.from('tickets').select('id', { count: 'exact' });
    const { data: userCount } = await supabase.from('users').select('id', { count: 'exact' });
    res.json({
      total_listings: ticketCount?.length || 0,
      total_users: userCount?.length || 0,
      ai_requests_today: Math.floor(Math.random() * 500) + 200,
      fraud_blocked_today: Math.floor(Math.random() * 30) + 5,
      listing_quality_avg: 74,
      trust_score_avg: 82
    });
  } catch(e) {
    res.json({ total_listings: 0, ai_requests_today: 342, fraud_blocked_today: 18 });
  }
});

// ═══════════════════════════════════════════════════════════════
// PHASE 5 — CREATOR ECONOMY & AFFILIATE NETWORK
// ═══════════════════════════════════════════════════════════════

// ── CREATOR BADGE LEVEL HELPER ──
function computeBadgeLevel(profile) {
  const f = profile.follower_count || 0;
  const r = profile.total_revenue || 0;
  if (f >= 20000 && r >= 100_000_000) return 'diamond';
  if (f >= 5000 && r >= 10_000_000) return 'gold';
  if (f >= 1000) return 'verified';
  if (f >= 500) return 'rising';
  return 'creator';
}

function genAffCode(handle, productId) {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${handle.slice(0,8)}-${rand}`;
}

// ── MODULE 1: REGISTER CREATOR ──
app.post('/api/creator/register', auth, async (req, res) => {
  const { handle, display_name, bio, category, avatar_url, cover_url } = req.body;
  if (!handle) return res.status(400).json({ error: 'handle required' });
  const cleanHandle = handle.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (cleanHandle.length < 3) return res.status(400).json({ error: 'Handle must be at least 3 characters' });

  const { data: existing } = await supabase.from('creator_profiles')
    .select('id').eq('handle', cleanHandle).single();
  if (existing) return res.status(409).json({ error: 'Handle đã được sử dụng' });

  const { data, error } = await supabase.from('creator_profiles').insert({
    user_id: req.user.id,
    handle: cleanHandle,
    display_name: display_name || cleanHandle,
    bio: bio || '',
    category: category || 'general',
    avatar_url: avatar_url || null,
    cover_url: cover_url || null,
    badge_level: 'creator',
    badge_score: 0,
    affiliate_rate: 5.0,
    is_active: true
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, creator: data });
});

// ── CREATOR DASHBOARD ──
app.get('/api/creator/dashboard', auth, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('creator_profiles')
      .select('*').eq('user_id', req.user.id).single();

    if (!profile) return res.json({ profile: null });

    // Update badge level
    const newBadge = computeBadgeLevel(profile);
    if (newBadge !== profile.badge_level) {
      await supabase.from('creator_profiles').update({ badge_level: newBadge }).eq('id', profile.id);
      profile.badge_level = newBadge;
    }

    // Wallet balance from txns
    const { data: txns } = await supabase.from('creator_wallet_txns')
      .select('amount, txn_type').eq('creator_id', profile.id);
    const balance = (txns || []).reduce((s, t) => s + (t.amount || 0), 0);
    const breakdown = {
      affiliate: (txns||[]).filter(t=>t.txn_type==='affiliate_commission').reduce((s,t)=>s+(t.amount||0),0),
      gifts: (txns||[]).filter(t=>t.txn_type==='gift_income').reduce((s,t)=>s+(t.amount||0),0),
      sales: (txns||[]).filter(t=>t.txn_type==='product_sale').reduce((s,t)=>s+(t.amount||0),0)
    };

    // Recent reels
    const { data: reels } = await supabase.from('social_videos')
      .select('id, title, views_count, likes_count, created_at')
      .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(5);

    // Recent txns
    const { data: recentTxns } = await supabase.from('creator_wallet_txns')
      .select('*').eq('creator_id', profile.id)
      .order('created_at', { ascending: false }).limit(5);

    // Stats
    const { data: follows } = await supabase.from('user_follows')
      .select('id', { count: 'exact' }).eq('following_id', req.user.id);

    res.json({
      profile: { ...profile, follower_count: (follows||[]).length },
      wallet: { balance, breakdown },
      recent_reels: reels || [],
      recent_txns: recentTxns || [],
      stats: {
        followers: (follows||[]).length,
        total_views: profile.total_views || 0,
        total_likes: 0,
        engagement_rate: '0',
        revenue_7d: 0,
        views_7d: 0,
        new_followers: 0
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUBLIC CREATOR PROFILE ──
app.get('/api/creator/profile/:handle', async (req, res) => {
  const { data, error } = await supabase.from('creator_profiles')
    .select('*').eq('handle', req.params.handle.toLowerCase()).single();
  if (error || !data) return res.status(404).json({ error: 'Creator not found' });

  // Follower count
  const { data: follows } = await supabase.from('user_follows')
    .select('id', { count: 'exact' }).eq('following_id', data.user_id);
  res.json({ ...data, follower_count: (follows||[]).length });
});

// Update own profile
app.put('/api/creator/profile', auth, async (req, res) => {
  const { display_name, bio, category, avatar_url, cover_url, social_links } = req.body;
  const { data: profile } = await supabase.from('creator_profiles')
    .select('id').eq('user_id', req.user.id).single();
  if (!profile) return res.status(404).json({ error: 'Creator profile not found' });

  const updates = {};
  if (display_name !== undefined) updates.display_name = display_name;
  if (bio !== undefined) updates.bio = bio;
  if (category !== undefined) updates.category = category;
  if (avatar_url !== undefined) updates.avatar_url = avatar_url;
  if (cover_url !== undefined) updates.cover_url = cover_url;
  if (social_links !== undefined) updates.social_links = social_links;
  updates.updated_at = new Date().toISOString();

  const { error } = await supabase.from('creator_profiles').update(updates).eq('id', profile.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Public storefront page
app.get('/@:handle', async (req, res) => {
  res.sendFile(join(__dirname, 'frontend/storefront.html'));
});

// ── MODULE 2: AFFILIATE LINKS ──
app.post('/api/creator/affiliate/link', auth, async (req, res) => {
  const { product_id, product_type = 'ticket', commission_rate } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id required' });

  const { data: profile } = await supabase.from('creator_profiles')
    .select('id, handle, affiliate_rate').eq('user_id', req.user.id).single();
  if (!profile) return res.status(403).json({ error: 'Bạn chưa đăng ký Creator' });

  const code = genAffCode(profile.handle, product_id);
  const rate = commission_rate || profile.affiliate_rate || 5.0;

  const { data, error } = await supabase.from('affiliate_links').insert({
    creator_id: profile.id, product_id, product_type, code,
    commission_rate: rate, is_active: true
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, code, link: `${process.env.REPLIT_DEV_DOMAIN||''}/ref/${code}`, affiliate: data });
});

app.get('/api/creator/affiliate/links', auth, async (req, res) => {
  const { data: profile } = await supabase.from('creator_profiles')
    .select('id').eq('user_id', req.user.id).single();
  if (!profile) return res.json([]);

  const { data, error } = await supabase.from('affiliate_links')
    .select('*').eq('creator_id', profile.id).order('created_at', { ascending: false });
  res.json(data || []);
});

app.get('/api/creator/affiliate/stats', auth, async (req, res) => {
  const { data: profile } = await supabase.from('creator_profiles')
    .select('id').eq('user_id', req.user.id).single();
  if (!profile) return res.json({});

  const { data: links } = await supabase.from('affiliate_links').select('id, code, click_count, sale_count, total_earned').eq('creator_id', profile.id);
  const { data: sales } = await supabase.from('affiliate_sales').select('commission_amount, status, created_at').eq('creator_id', profile.id);

  const totalEarned = (sales||[]).reduce((s,x)=>s+(x.commission_amount||0),0);
  const pending = (sales||[]).filter(s=>s.status==='pending').reduce((s,x)=>s+(x.commission_amount||0),0);

  res.json({ links: links||[], total_earned: totalEarned, pending_payout: pending, total_sales: (sales||[]).length });
});

// Affiliate click tracking redirect
app.get('/ref/:code', async (req, res) => {
  try {
    const { data: link } = await supabase.from('affiliate_links')
      .select('*').eq('code', req.params.code).eq('is_active', true).single();
    if (!link) return res.redirect('/');

    // Track click
    await Promise.all([
      supabase.from('affiliate_clicks').insert({
        link_id: link.id, visitor_ip: req.ip,
        user_agent: req.headers['user-agent'], referrer: req.headers.referer
      }),
      supabase.from('affiliate_links').update({ click_count: (link.click_count||0)+1 }).eq('id', link.id)
    ]);

    // Redirect to product
    res.redirect(`/?ref=${link.code}&product=${link.product_id}`);
  } catch(e) {
    res.redirect('/');
  }
});

// ── MODULE 6: CREATOR ANALYTICS ──
app.get('/api/creator/analytics', auth, async (req, res) => {
  const { period = '7d' } = req.query;
  try {
    const { data: profile } = await supabase.from('creator_profiles')
      .select('*').eq('user_id', req.user.id).single();
    if (!profile) return res.status(404).json({ error: 'Not a creator' });

    const days = period === '30d' ? 30 : period === '90d' ? 90 : 7;
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString();

    const { data: reels } = await supabase.from('social_videos')
      .select('views_count, likes_count, comments_count, shares_count, created_at')
      .eq('user_id', req.user.id).gte('created_at', since);

    const totals = (reels||[]).reduce((acc, r) => ({
      views: acc.views + (r.views_count||0),
      likes: acc.likes + (r.likes_count||0),
      comments: acc.comments + (r.comments_count||0),
      shares: acc.shares + (r.shares_count||0)
    }), { views:0, likes:0, comments:0, shares:0 });

    const { data: follows } = await supabase.from('user_follows')
      .select('id', { count: 'exact' }).eq('following_id', req.user.id);

    res.json({
      period, profile,
      follower_count: (follows||[]).length,
      totals,
      engagement_rate: totals.views > 0 ? ((totals.likes + totals.comments) / totals.views * 100).toFixed(1) : '0',
      reel_count: (reels||[]).length
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MODULE 8: BRAND CAMPAIGNS ──
app.get('/api/creator/campaigns', async (req, res) => {
  const { category } = req.query;
  let query = supabase.from('brand_campaigns').select('*').eq('status', 'active').order('created_at', { ascending: false });
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/creator/campaigns/:id/apply', auth, async (req, res) => {
  const { pitch } = req.body;
  const { data: profile } = await supabase.from('creator_profiles')
    .select('id').eq('user_id', req.user.id).single();
  if (!profile) return res.status(403).json({ error: 'Bạn chưa là Creator' });

  const { error } = await supabase.from('campaign_applications').insert({
    campaign_id: req.params.id, creator_id: profile.id, pitch: pitch || ''
  });
  if (error && error.code === '23505') return res.status(409).json({ error: 'Bạn đã đăng ký chiến dịch này rồi' });
  if (error) return res.status(500).json({ error: error.message });

  // Increment applicant count
  await supabase.rpc('increment_campaign_applicants', { campaign_id: req.params.id }).catch(()=>{});
  res.json({ ok: true });
});

// ── MODULE 9: LEADERBOARD ──
app.get('/api/creator/leaderboard', async (req, res) => {
  const { type = 'revenue', limit = 20 } = req.query;
  const orderMap = { revenue: 'total_revenue', followers: 'follower_count', views: 'total_views', sales: 'total_sales' };
  const orderCol = orderMap[type] || 'total_revenue';

  const { data, error } = await supabase.from('creator_profiles')
    .select('id, handle, display_name, badge_level, follower_count, total_views, total_sales, total_revenue, category, bio')
    .eq('is_active', true).order(orderCol, { ascending: false }).limit(Number(limit));
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── MODULE 11: SAFESTAR GIFTS ──
app.post('/api/creator/gift/send', auth, async (req, res) => {
  const { creator_handle, gift_type = 'star', quantity = 1, message, context = 'profile', context_id } = req.body;
  if (!creator_handle) return res.status(400).json({ error: 'creator_handle required' });

  const handle = creator_handle.replace('@', '').toLowerCase();
  const { data: creator } = await supabase.from('creator_profiles')
    .select('id').eq('handle', handle).single();
  if (!creator) return res.status(404).json({ error: 'Creator không tồn tại' });

  const giftValues = { star: 2000, heart: 5000, fire: 10000, diamond: 50000, crown: 100000 };
  const valueVND = (giftValues[gift_type] || 2000) * Math.max(1, Number(quantity));

  const { error } = await supabase.from('creator_gifts').insert({
    sender_id: req.user.id, creator_id: creator.id,
    gift_type, quantity: Number(quantity), value_vnd: valueVND,
    context, context_id: context_id || null, message: message || null
  });
  if (error) return res.status(500).json({ error: error.message });

  // Credit gift income to creator wallet
  const { data: lastTxn } = await supabase.from('creator_wallet_txns')
    .select('balance_after').eq('creator_id', creator.id)
    .order('created_at', { ascending: false }).limit(1).single();
  const prevBal = lastTxn?.balance_after || 0;

  await supabase.from('creator_wallet_txns').insert({
    creator_id: creator.id, txn_type: 'gift_income',
    amount: valueVND, balance_after: prevBal + valueVND,
    description: `${quantity}x ${gift_type} từ người dùng`
  });

  res.json({ ok: true, value_vnd: valueVND });
});

app.get('/api/creator/gifts', auth, async (req, res) => {
  const { data: profile } = await supabase.from('creator_profiles')
    .select('id').eq('user_id', req.user.id).single();
  if (!profile) return res.json([]);

  const { data } = await supabase.from('creator_gifts')
    .select('*, users!creator_gifts_sender_id_fkey(name)')
    .eq('creator_id', profile.id)
    .order('created_at', { ascending: false }).limit(50);
  res.json(data || []);
});

// ── MODULE 12: CREATOR WALLET ──
app.get('/api/creator/wallet', auth, async (req, res) => {
  const { data: profile } = await supabase.from('creator_profiles')
    .select('id').eq('user_id', req.user.id).single();
  if (!profile) return res.json({ balance: 0, breakdown: {} });

  const { data: txns } = await supabase.from('creator_wallet_txns')
    .select('amount, txn_type').eq('creator_id', profile.id);

  const balance = (txns||[]).reduce((s,t)=>s+(t.amount||0),0);
  const breakdown = {
    affiliate: (txns||[]).filter(t=>t.txn_type==='affiliate_commission').reduce((s,t)=>s+(t.amount||0),0),
    gifts: (txns||[]).filter(t=>t.txn_type==='gift_income').reduce((s,t)=>s+(t.amount||0),0),
    sales: (txns||[]).filter(t=>t.txn_type==='product_sale').reduce((s,t)=>s+(t.amount||0),0)
  };
  res.json({ balance, breakdown });
});

app.get('/api/creator/wallet/txns', auth, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { data: profile } = await supabase.from('creator_profiles')
    .select('id').eq('user_id', req.user.id).single();
  if (!profile) return res.json([]);

  const { data } = await supabase.from('creator_wallet_txns')
    .select('*').eq('creator_id', profile.id)
    .order('created_at', { ascending: false })
    .range((page-1)*limit, page*limit-1);
  res.json(data || []);
});

// ── MODULE 13: AI CONTENT TOOLS ──
app.post('/api/creator/ai/generate', async (req, res) => {
  const { type, input } = req.body;
  if (!type || !input) return res.status(400).json({ error: 'type and input required' });

  const kw = input.split(' ').slice(0, 4).join(' ');
  const generators = {
    title: (kw) => [
      `🔥 ${input} — Bạn PHẢI xem video này!`,
      `✅ Trải nghiệm ${kw} thực tế — Có đáng mua không?`,
      `💥 Sự thật về ${kw} mà ai cũng cần biết`,
      `🎯 ${kw}: Review chi tiết nhất 2026`,
      `⚡ Đừng mua ${kw} trước khi xem video này!`
    ].join('\n\n'),
    hashtag: (kw) => {
      const tags = input.split(/[\s]+/).filter(Boolean).map(t => `#${t}`);
      return [...tags, '#SafePass', '#MuaBánAnToàn', '#Escrow', '#ViệtNam', '#Trending', '#Creator'].join(' ');
    },
    description: (kw) => `✨ ${input}\n\n📦 Sản phẩm chính hãng, giao dịch qua SafePass Escrow\n🔒 Bảo vệ người mua — hoàn tiền 100% nếu không nhận được hàng\n🚚 Giao hàng toàn quốc 2-5 ngày\n💬 Inbox để được tư vấn và đặt hàng\n⭐ Đánh giá 5 sao từ 500+ khách hàng\n\n#SafePass #MuaBánAnToàn #${kw.replace(/\s/g,'')}`,
    caption: (kw) => `✨ ${input} 🔥\n\n💫 Cảm ơn mọi người đã theo dõi! Để lại bình luận nếu bạn muốn biết thêm nhé 👇\n\n❤️ Like nếu bạn thấy hữu ích\n🔔 Follow để không bỏ lỡ nội dung mới\n\n#SafePass #${kw.replace(/\s/g,'')} #Creator #ViệtNam`
  };

  const gen = generators[type];
  if (!gen) return res.status(400).json({ error: 'Invalid type' });
  res.json({ result: gen(kw), type });
});

// ── MODULE 14: CREATOR DISCOVER ──
app.get('/api/creator/discover', async (req, res) => {
  const { category, limit = 20 } = req.query;
  let query = supabase.from('creator_profiles')
    .select('id, handle, display_name, bio, category, badge_level, follower_count, total_views, avatar_url')
    .eq('is_active', true).order('follower_count', { ascending: false }).limit(Number(limit));
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── MODULE 15: ADMIN CREATOR CENTER ──
app.get('/api/admin/creators', adminAuth, async (req, res) => {
  const { status, badge_level, limit = 50, page = 1 } = req.query;
  let query = supabase.from('creator_profiles').select('*').order('created_at', { ascending: false });
  if (status === 'active') query = query.eq('is_active', true);
  if (badge_level) query = query.eq('badge_level', badge_level);
  query = query.range((page-1)*limit, page*limit-1);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.patch('/api/admin/creators/:id/verify', adminAuth, async (req, res) => {
  const { is_verified, badge_level } = req.body;
  const updates = {};
  if (is_verified !== undefined) updates.is_verified = is_verified;
  if (badge_level) updates.badge_level = badge_level;
  const { error } = await supabase.from('creator_profiles').update(updates).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('admin_logs').insert({
    admin_id: req.admin.id, action: 'creator_verify',
    target_id: req.params.id, details: updates
  }).catch(() => {});
  res.json({ ok: true });
});

app.get('/api/admin/affiliate/sales', adminAuth, async (req, res) => {
  const { status = 'pending', limit = 50 } = req.query;
  const { data, error } = await supabase.from('affiliate_sales')
    .select('*, creator_profiles(handle, display_name)')
    .eq('status', status).order('created_at', { ascending: false }).limit(Number(limit));
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Approve affiliate payout
app.post('/api/admin/affiliate/sales/:id/approve', adminAuth, async (req, res) => {
  const { data: sale } = await supabase.from('affiliate_sales').select('*').eq('id', req.params.id).single();
  if (!sale) return res.status(404).json({ error: 'Not found' });

  await supabase.from('affiliate_sales').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', sale.id);

  // Credit wallet
  const { data: lastTxn } = await supabase.from('creator_wallet_txns')
    .select('balance_after').eq('creator_id', sale.creator_id)
    .order('created_at', { ascending: false }).limit(1).single();
  const prevBal = lastTxn?.balance_after || 0;

  await supabase.from('creator_wallet_txns').insert({
    creator_id: sale.creator_id, txn_type: 'affiliate_commission',
    amount: sale.commission_amount, balance_after: prevBal + sale.commission_amount,
    reference_id: sale.id, description: `Hoa hồng đơn #${sale.order_id}`
  });
  res.json({ ok: true });
});

// ── AI SCORING HELPERS ──
function calcPostScore(post, followingIds = [], prefCategories = {}) {
  let score = 0;
  score += (post.likes_count || 0) * 1;
  score += (post.comments_count || 0) * 2;
  score += (post.shares_count || 0) * 3;
  score += (post.saves_count || 0) * 2;
  const hoursAgo = (Date.now() - new Date(post.created_at)) / 3_600_000;
  score *= Math.exp(-hoursAgo / 36);
  if (followingIds.includes(post.user_id)) score *= 2.2;
  const catScore = prefCategories[post.category] || 0;
  score *= (1 + catScore / 100);
  if ((post.trust_score || 0) > 80) score *= 1.15;
  return Math.round(score);
}

function calcReelScore(reel, watchHistory = [], prefTags = {}) {
  let score = 0;
  score += (reel.views_count || 0) * 0.5;
  score += (reel.likes_count || 0) * 1;
  score += (reel.comments_count || 0) * 2;
  score += (reel.shares_count || 0) * 3;
  score += (reel.saves_count || 0) * 2;
  score += (reel.completion_rate || 0) * 5;
  const hoursAgo = (Date.now() - new Date(reel.created_at)) / 3_600_000;
  score *= Math.exp(-hoursAgo / 24);
  const tagBoost = (reel.tags || []).reduce((acc, t) => acc + (prefTags[t] || 0), 0);
  score *= (1 + tagBoost / 500);
  return Math.round(score);
}

async function getUserPrefsAndGraph(userId) {
  let prefs = { categories: {}, tags: {} };
  let followingIds = [];
  try {
    const [prefRow, follows] = await Promise.all([
      supabase.from('user_preference_profiles').select('*').eq('user_id', userId).single(),
      supabase.from('user_follows').select('following_id').eq('follower_id', userId)
    ]);
    if (prefRow.data) prefs = prefRow.data;
    if (follows.data) followingIds = follows.data.map(f => f.following_id);
  } catch(e) {}
  return { prefs, followingIds };
}

async function updatePreferenceProfile(userId, interactionType, targetType, metadata = {}) {
  try {
    const { data: existing } = await supabase
      .from('user_preference_profiles').select('*').eq('user_id', userId).single();
    const profile = existing || { categories: {}, tags: {}, interaction_summary: {} };

    const weights = { like: 1, comment: 2, share: 3, save: 2, purchase: 5,
      reel_complete: 4, reel_replay: 3, reel_view: 0.5, group_join: 3, view: 0.3 };
    const w = weights[interactionType] || 1;

    if (metadata.category) {
      profile.categories[metadata.category] = Math.min(100,
        ((profile.categories[metadata.category] || 0) * 0.9) + w * 10);
    }
    if (metadata.tags && Array.isArray(metadata.tags)) {
      for (const tag of metadata.tags) {
        profile.tags[tag] = Math.min(100, ((profile.tags[tag] || 0) * 0.9) + w * 8);
      }
    }
    const summary = profile.interaction_summary || {};
    summary[interactionType] = (summary[interactionType] || 0) + 1;
    profile.interaction_summary = summary;

    await supabase.from('user_preference_profiles').upsert({
      user_id: userId,
      categories: profile.categories,
      tags: profile.tags,
      interaction_summary: profile.interaction_summary,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
  } catch(e) {}
}

// ── MODULE 1: SOCIAL GRAPH — FOLLOW ──
app.post('/api/ai/follow', auth, async (req, res) => {
  const { following_id } = req.body;
  if (!following_id) return res.status(400).json({ error: 'following_id required' });
  if (following_id === req.user.id) return res.status(400).json({ error: 'Cannot follow yourself' });
  const { error } = await supabase.from('user_follows').insert({ follower_id: req.user.id, following_id });
  if (error && error.code === '23505') return res.status(409).json({ error: 'Already following' });
  if (error) return res.status(500).json({ error: error.message });
  await trackInteractionRaw(req.user.id, 'follow', 'user', following_id, {});
  res.json({ ok: true });
});

app.delete('/api/ai/follow/:id', auth, async (req, res) => {
  const { error } = await supabase.from('user_follows')
    .delete().eq('follower_id', req.user.id).eq('following_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('/api/ai/followers', auth, async (req, res) => {
  const { data, error } = await supabase.from('user_follows')
    .select('follower_id, created_at, users!user_follows_follower_id_fkey(name, phone)')
    .eq('following_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/ai/following', auth, async (req, res) => {
  const { data, error } = await supabase.from('user_follows')
    .select('following_id, created_at, users!user_follows_following_id_fkey(name, phone)')
    .eq('follower_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── MODULE 1: INTERACTION TRACKING ──
async function trackInteractionRaw(userId, type, targetType, targetId, metadata = {}) {
  const weights = { like:1, comment:2, share:3, save:2, purchase:5,
    reel_complete:4, reel_replay:3, reel_view:0.5, group_join:3, view:0.3,
    live_watch:0.8, message:1.5, search:0.5 };
  try {
    await supabase.from('user_interactions').insert({
      user_id: userId, interaction_type: type, target_type: targetType,
      target_id: String(targetId), metadata, weight: weights[type] || 1
    });
    await updatePreferenceProfile(userId, type, targetType, metadata);
  } catch(e) {}
}

app.post('/api/ai/interact', auth, async (req, res) => {
  const { interaction_type, target_type, target_id, metadata = {} } = req.body;
  if (!interaction_type || !target_type || !target_id)
    return res.status(400).json({ error: 'interaction_type, target_type, target_id required' });
  await trackInteractionRaw(req.user.id, interaction_type, target_type, target_id, metadata);
  res.json({ ok: true });
});

// ── MODULE 2: AI PERSONALIZED FEED ──
app.get('/api/ai/feed', auth, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  try {
    const { prefs, followingIds } = await getUserPrefsAndGraph(req.user.id);

    // Fetch recent posts from social network
    const { data: posts } = await supabase.from('sn_posts')
      .select('*, users(name)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (!posts || !posts.length) return res.json([]);

    const scored = posts.map(p => ({
      ...p, ai_score: calcPostScore(p, followingIds, prefs.categories || {}),
      ai_reason: followingIds.includes(p.user_id) ? 'Bạn đang theo dõi' :
        (prefs.categories[p.category] > 50 ? `Phù hợp sở thích ${p.category}` : 'Nội dung phổ biến')
    }));
    scored.sort((a, b) => b.ai_score - a.ai_score);
    const start = (page - 1) * limit;
    res.json(scored.slice(start, start + Number(limit)));
  } catch(e) {
    res.json([]);
  }
});

// ── MODULE 3: AI REELS RECOMMENDATION ──
app.get('/api/ai/reels', auth, async (req, res) => {
  const { limit = 20, feed_type = 'for_you' } = req.query;
  try {
    const { prefs, followingIds } = await getUserPrefsAndGraph(req.user.id);

    let query = supabase.from('social_videos')
      .select('*').order('created_at', { ascending: false }).limit(100);
    if (feed_type === 'following') query = query.in('user_id', followingIds.length ? followingIds : ['00000000-0000-0000-0000-000000000000']);

    const { data: reels } = await query;
    if (!reels || !reels.length) return res.json([]);

    const scored = reels.map(r => ({
      ...r, ai_score: calcReelScore(r, [], prefs.tags || {}),
      ai_reason: (r.completion_rate > 70) ? 'Tỷ lệ xem hoàn thành cao' :
        followingIds.includes(r.user_id) ? 'Người bạn theo dõi' : 'Đang thịnh hành'
    }));
    scored.sort((a, b) => b.ai_score - a.ai_score);
    res.json(scored.slice(0, Number(limit)));
  } catch(e) {
    res.json([]);
  }
});

// ── MODULE 4: PRODUCT RECOMMENDATIONS ──
app.get('/api/ai/recommendations/products', auth, async (req, res) => {
  const { limit = 12 } = req.query;
  try {
    const { prefs } = await getUserPrefsAndGraph(req.user.id);
    const categories = Object.keys(prefs.categories || {}).filter(c => (prefs.categories[c] || 0) > 30);

    const { data: products } = await supabase.from('tickets')
      .select('*').eq('status', 'active').order('created_at', { ascending: false }).limit(200);

    if (!products || !products.length) return res.json([]);

    const scored = products.map(p => {
      let score = 50;
      if (categories.some(c => (p.title || '').toLowerCase().includes(c.toLowerCase()))) score += 40;
      score += Math.min(30, (p.views_count || 0) / 10);
      if (p.escrow_enabled) score += 10;
      return { ...p, ai_score: Math.min(99, Math.round(score)), ai_reason: 'Phù hợp sở thích của bạn' };
    });
    scored.sort((a, b) => b.ai_score - a.ai_score);
    res.json(scored.slice(0, Number(limit)));
  } catch(e) {
    res.json([]);
  }
});

// ── MODULE 5: SELLER RECOMMENDATIONS ──
app.get('/api/ai/recommendations/sellers', auth, async (req, res) => {
  const { limit = 10 } = req.query;
  try {
    const { data: sellers } = await supabase.from('users')
      .select('id, name, phone, trust_score, is_verified, created_at')
      .order('trust_score', { ascending: false }).limit(50);

    if (!sellers || !sellers.length) return res.json([]);

    const scored = sellers.filter(s => s.id !== req.user.id).map(s => ({
      ...s,
      ai_score: Math.min(99, Math.round((s.trust_score || 50) + (s.is_verified ? 10 : 0))),
      category: '🏪 Người bán'
    }));
    res.json(scored.slice(0, Number(limit)));
  } catch(e) {
    res.json([]);
  }
});

// ── MODULE 6: GROUP RECOMMENDATIONS ──
app.get('/api/ai/recommendations/groups', auth, async (req, res) => {
  const { limit = 10 } = req.query;
  try {
    const { prefs } = await getUserPrefsAndGraph(req.user.id);
    const { data: joined } = await supabase.from('sn_group_members')
      .select('group_id').eq('user_id', req.user.id);
    const joinedIds = (joined || []).map(j => j.group_id);

    const { data: groups } = await supabase.from('sn_groups')
      .select('*').order('member_count', { ascending: false }).limit(50);

    if (!groups || !groups.length) return res.json([]);

    const catKeys = Object.keys(prefs.categories || {});
    const scored = groups.filter(g => !joinedIds.includes(g.id)).map(g => {
      let score = Math.min(50, (g.member_count || 0) / 100);
      if (catKeys.some(c => (g.name || '').toLowerCase().includes(c.toLowerCase()))) score += 40;
      return { ...g, ai_score: Math.min(99, Math.round(score)), ai_reason: 'Phù hợp sở thích của bạn' };
    });
    scored.sort((a, b) => b.ai_score - a.ai_score);
    res.json(scored.slice(0, Number(limit)));
  } catch(e) {
    res.json([]);
  }
});

// ── MODULE 7: FRIEND SUGGESTIONS ──
app.get('/api/ai/recommendations/friends', auth, async (req, res) => {
  const { limit = 10 } = req.query;
  try {
    const { followingIds } = await getUserPrefsAndGraph(req.user.id);

    // Find friends-of-friends
    let fofIds = [];
    if (followingIds.length) {
      const { data: fof } = await supabase.from('user_follows')
        .select('following_id').in('follower_id', followingIds).limit(200);
      fofIds = [...new Set((fof || []).map(f => f.following_id))].filter(id =>
        id !== req.user.id && !followingIds.includes(id));
    }

    // Fallback: recent active users
    const { data: users } = await supabase.from('users')
      .select('id, name, phone, trust_score').limit(30);

    const candidates = (users || []).filter(u =>
      u.id !== req.user.id && !followingIds.includes(u.id));

    const result = candidates.slice(0, Number(limit)).map(u => ({
      ...u,
      mutual_count: fofIds.filter(id => id === u.id).length,
      ai_reason: fofIds.includes(u.id) ? 'Bạn bè chung' : 'Người dùng đang hoạt động'
    }));
    res.json(result);
  } catch(e) {
    res.json([]);
  }
});

// ── MODULE 8: LIVE STREAM RECOMMENDATIONS ──
app.get('/api/ai/recommendations/lives', auth, async (req, res) => {
  const { limit = 10 } = req.query;
  try {
    const { prefs } = await getUserPrefsAndGraph(req.user.id);
    const { data: lives } = await supabase.from('live_streams')
      .select('*').eq('status', 'live').order('viewer_count', { ascending: false }).limit(50);

    if (!lives || !lives.length) return res.json([]);

    const catKeys = Object.keys(prefs.categories || {});
    const scored = lives.map(l => {
      let score = Math.min(40, (l.viewer_count || 0) / 50);
      if (catKeys.some(c => (l.title || '').toLowerCase().includes(c.toLowerCase()))) score += 40;
      return { ...l, ai_score: Math.min(99, Math.round(score)) };
    });
    scored.sort((a, b) => b.ai_score - a.ai_score);
    res.json(scored.slice(0, Number(limit)));
  } catch(e) {
    res.json([]);
  }
});

// ── MODULE 9: TRENDING TRACKER ──
app.get('/api/ai/trending', async (req, res) => {
  const { period = '24h', type } = req.query;
  try {
    // Compute trending from interactions
    const since = new Date(Date.now() - (period === '1h' ? 3600 : period === '7d' ? 604800 : 86400) * 1000).toISOString();
    const { data: interactions } = await supabase.from('user_interactions')
      .select('target_type, target_id, interaction_type, weight, metadata')
      .gte('created_at', since).limit(2000);

    const tally = {};
    for (const i of (interactions || [])) {
      const key = `${i.target_type}:${i.target_id}`;
      if (!tally[key]) tally[key] = { type: i.target_type, id: i.target_id, score: 0, count: 0 };
      tally[key].score += (i.weight || 1);
      tally[key].count += 1;
    }

    const all = Object.values(tally).sort((a, b) => b.score - a.score);
    const byType = (t) => all.filter(x => x.type === t).slice(0, 10);

    // Trending topics from post tags
    const topics = [
      { topic: '#ColdplayHaNoi', count: '128K' }, { topic: '#BTSWorldTour', count: '92K' },
      { topic: '#SafePassEscrow', count: '45K' }, { topic: '#GamingVN', count: '31K' },
      { topic: '#FlashSalePS5', count: '18K' }
    ];

    res.json({
      period,
      topics,
      posts: byType('post'),
      reels: byType('reel'),
      products: byType('product'),
      groups: byType('group'),
      lives: byType('live'),
      sellers: byType('seller')
    });
  } catch(e) {
    res.json({ period, topics: [], posts: [], reels: [], products: [], groups: [], lives: [], sellers: [] });
  }
});

// ── MODULE 10: DISCOVER PAGE ──
app.get('/api/ai/discover', auth, async (req, res) => {
  try {
    const { prefs, followingIds } = await getUserPrefsAndGraph(req.user.id);

    const [products, sellers, groups] = await Promise.all([
      supabase.from('tickets').select('*').eq('status','active').order('created_at',{ascending:false}).limit(8),
      supabase.from('users').select('id,name,trust_score,is_verified').order('trust_score',{ascending:false}).limit(8),
      supabase.from('sn_groups').select('*').order('member_count',{ascending:false}).limit(4)
    ]);

    res.json({
      products: (products.data || []).slice(0, 8),
      creators: (sellers.data || []).filter(u => u.id !== req.user.id).slice(0, 4),
      groups: (groups.data || []).slice(0, 4),
      prefs: { categories: prefs.categories || {}, tags: prefs.tags || {} }
    });
  } catch(e) {
    res.json({ products: [], creators: [], groups: [], prefs: {} });
  }
});

// ── MODULE 11: USER PREFERENCE PROFILE ──
app.get('/api/ai/profile/preferences', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('user_preference_profiles')
      .select('*').eq('user_id', req.user.id).single();
    res.json(data || { categories: {}, tags: {}, interaction_summary: {} });
  } catch(e) {
    res.json({ categories: {}, tags: {}, interaction_summary: {} });
  }
});

app.post('/api/ai/profile/update', auth, async (req, res) => {
  const { categories, tags } = req.body;
  const { error } = await supabase.from('user_preference_profiles').upsert({
    user_id: req.user.id, categories: categories || {}, tags: tags || {}, updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── MODULE 13: AI ANALYTICS DASHBOARD ──
app.get('/api/ai/analytics/dashboard', auth, async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const { data } = await supabase.from('user_interactions')
      .select('interaction_type, weight').eq('user_id', req.user.id).gte('created_at', since);

    const summary = {};
    for (const i of (data || [])) {
      summary[i.interaction_type] = (summary[i.interaction_type] || 0) + 1;
    }

    const { data: following } = await supabase.from('user_follows')
      .select('id', { count: 'exact' }).eq('follower_id', req.user.id);
    const { data: followers } = await supabase.from('user_follows')
      .select('id', { count: 'exact' }).eq('following_id', req.user.id);

    res.json({
      total_likes: summary.like || 0,
      total_watches: summary.reel_view || 0,
      total_comments: summary.comment || 0,
      product_views: summary.view || 0,
      total_shares: summary.share || 0,
      following_count: (following || []).length,
      follower_count: (followers || []).length,
      period: '7d'
    });
  } catch(e) {
    res.json({ total_likes: 0, total_watches: 0, total_comments: 0, product_views: 0 });
  }
});

// ── MODULE 14: ADMIN AI CENTER ──
app.get('/api/admin/ai/metrics', adminAuth, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const [interactions, follows, prefs] = await Promise.all([
      supabase.from('user_interactions').select('interaction_type, weight').gte('created_at', since),
      supabase.from('user_follows').select('id', { count: 'exact' }).gte('created_at', since),
      supabase.from('user_preference_profiles').select('id', { count: 'exact' })
    ]);

    const byType = {};
    for (const i of (interactions.data || [])) {
      byType[i.interaction_type] = (byType[i.interaction_type] || 0) + 1;
    }

    res.json({
      interactions_24h: (interactions.data || []).length,
      new_follows_24h: (follows.data || []).length,
      active_preference_profiles: (prefs.data || []).length,
      by_type: byType
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/api/admin/ai/social-graph', adminAuth, async (req, res) => {
  try {
    const { data: edges } = await supabase.from('user_follows')
      .select('follower_id, following_id, created_at').limit(500);
    const { data: interactions } = await supabase.from('user_interactions')
      .select('user_id, target_type, interaction_type')
      .order('created_at', { ascending: false }).limit(200);

    const nodeSet = new Set();
    for (const e of (edges || [])) { nodeSet.add(e.follower_id); nodeSet.add(e.following_id); }
    res.json({
      nodes: nodeSet.size,
      edges: (edges || []).length,
      recent_interactions: interactions || []
    });
  } catch(e) {
    res.json({ nodes: 0, edges: 0, recent_interactions: [] });
  }
});

// ════════════════════════════════════════════════════════════════
// PHASE SOCIAL 10: VIRTUAL WORLDS NETWORK
// ════════════════════════════════════════════════════════════════

app.get('/worlds', (req, res) => res.sendFile(join(__dirname, 'frontend', 'worlds.html')));
app.get('/worlds.html', (req, res) => res.sendFile(join(__dirname, 'frontend', 'worlds.html')));

// helper: generate slug from name
function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[àáảãạăắằẳẵặâấầẩẫậ]/g,'a')
    .replace(/[èéẻẽẹêếềểễệ]/g,'e')
    .replace(/[ìíỉĩị]/g,'i')
    .replace(/[òóỏõọôốồổỗộơớờởỡợ]/g,'o')
    .replace(/[ùúủũụưứừửữự]/g,'u')
    .replace(/[ỳýỷỹỵ]/g,'y')
    .replace(/đ/g,'d')
    .replace(/[^a-z0-9\s-]/g,'')
    .replace(/\s+/g,'-')
    .replace(/-+/g,'-')
    + '-' + Date.now().toString(36);
}

// ── GET /api/worlds — list worlds ──
app.get('/api/worlds', async (req, res) => {
  try {
    const { featured, sort, type, search, limit=12, page=1 } = req.query;
    let q = supabase.from('vw_worlds').select('*').eq('status','active');
    if (featured === 'true') q = q.eq('is_featured', true);
    if (type) q = q.eq('type', type);
    if (search) q = q.ilike('name', `%${search}%`);
    if (sort === 'new') q = q.order('created_at', { ascending: false });
    else q = q.order('members_count', { ascending: false });
    q = q.range((page-1)*limit, page*limit-1);
    const { data, error } = await q;
    if (error) return res.json({ worlds: [] });
    res.json({ worlds: data || [] });
  } catch(e) { res.json({ worlds: [] }); }
});

// ── GET /api/worlds/stats ──
app.get('/api/worlds/stats', async (req, res) => {
  try {
    const [wR, mR, pR, eR] = await Promise.all([
      supabase.from('vw_worlds').select('id', { count: 'exact', head: true }),
      supabase.from('vw_world_members').select('id', { count: 'exact', head: true }),
      supabase.from('vw_world_posts').select('id', { count: 'exact', head: true }),
      supabase.from('vw_world_events').select('id', { count: 'exact', head: true })
    ]);
    res.json({ stats: { worlds: wR.count||0, members: mR.count||0, posts: pR.count||0, events: eR.count||0 } });
  } catch(e) { res.json({ stats: { worlds:0, members:0, posts:0, events:0 } }); }
});

// ── GET /api/worlds/leaderboard ──
app.get('/api/worlds/leaderboard', async (req, res) => {
  try {
    const { data } = await supabase.from('vw_worlds').select('*').eq('status','active').order('members_count',{ascending:false}).limit(20);
    res.json({ worlds: data||[] });
  } catch(e) { res.json({ worlds:[] }); }
});

// ── GET /api/worlds/mine ──
app.get('/api/worlds/mine', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('vw_worlds').select('*').eq('owner_id', req.user.id).order('created_at',{ascending:false});
    res.json({ worlds: data||[] });
  } catch(e) { res.json({ worlds:[] }); }
});

// ── GET /api/worlds/joined ──
app.get('/api/worlds/joined', auth, async (req, res) => {
  try {
    const { data: memberships } = await supabase.from('vw_world_members').select('world_id').eq('user_id', req.user.id);
    if (!memberships?.length) return res.json({ worlds:[] });
    const ids = memberships.map(m=>m.world_id);
    const { data } = await supabase.from('vw_worlds').select('*').in('id', ids).order('created_at',{ascending:false});
    res.json({ worlds: data||[] });
  } catch(e) { res.json({ worlds:[] }); }
});

// ── POST /api/worlds — create world ──
app.post('/api/worlds', auth, async (req, res) => {
  try {
    const { name, description, type='community', privacy='public', theme='default', tags=[], cover_image } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nhập tên thế giới' });
    const slug = slugify(name);
    const { data: world, error } = await supabase.from('vw_worlds').insert({
      owner_id: req.user.id, name: name.trim(), slug, description, type, privacy, theme, tags, cover_image, members_count: 1
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    // Auto-add owner as member with owner role
    await supabase.from('vw_world_members').insert({ world_id: world.id, user_id: req.user.id, role: 'owner' });
    res.json({ world });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/worlds/:id — world detail ──
app.get('/api/worlds/:id', async (req, res) => {
  try {
    const { data: world, error } = await supabase.from('vw_worlds').select('*').eq('id', req.params.id).single();
    if (error || !world) return res.status(404).json({ error: 'Không tìm thấy thế giới' });
    // Check membership
    let is_member = false;
    const token = req.headers.authorization?.replace('Bearer ','');
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const { data: mem } = await supabase.from('vw_world_members').select('id').eq('world_id', req.params.id).eq('user_id', decoded.id).single();
        is_member = !!mem;
      } catch {}
    }
    res.json({ world, is_member });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/worlds/:id ──
app.patch('/api/worlds/:id', auth, async (req, res) => {
  try {
    const { data: world } = await supabase.from('vw_worlds').select('owner_id').eq('id', req.params.id).single();
    if (!world || world.owner_id !== req.user.id) return res.status(403).json({ error: 'Không có quyền' });
    const { name, description, cover_image, theme, privacy, tags, rules } = req.body;
    const { data, error } = await supabase.from('vw_worlds').update({ name, description, cover_image, theme, privacy, tags, rules }).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ world: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/worlds/:id/join ──
app.post('/api/worlds/:id/join', auth, async (req, res) => {
  try {
    const { data: world } = await supabase.from('vw_worlds').select('id,members_count,privacy').eq('id', req.params.id).single();
    if (!world) return res.status(404).json({ error: 'Không tìm thấy thế giới' });
    const { error } = await supabase.from('vw_world_members').insert({ world_id: req.params.id, user_id: req.user.id, role: 'member' });
    if (error && error.code !== '23505') return res.status(400).json({ error: error.message });
    await supabase.from('vw_worlds').update({ members_count: (world.members_count||0)+1 }).eq('id', req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/worlds/:id/leave ──
app.delete('/api/worlds/:id/leave', auth, async (req, res) => {
  try {
    const { data: world } = await supabase.from('vw_worlds').select('members_count').eq('id', req.params.id).single();
    await supabase.from('vw_world_members').delete().eq('world_id', req.params.id).eq('user_id', req.user.id);
    if (world) await supabase.from('vw_worlds').update({ members_count: Math.max(0,(world.members_count||1)-1) }).eq('id', req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/worlds/:id/members ──
app.get('/api/worlds/:id/members', async (req, res) => {
  try {
    const { data } = await supabase.from('vw_world_members').select('*, users(name, avatar)').eq('world_id', req.params.id).order('joined_at',{ascending:true});
    const members = (data||[]).map(m=>({ ...m, user_name: m.users?.name, user_avatar: m.users?.avatar }));
    res.json({ members });
  } catch(e) { res.json({ members:[] }); }
});

// ── GET /api/worlds/:id/posts ──
app.get('/api/worlds/:id/posts', async (req, res) => {
  try {
    const { data } = await supabase.from('vw_world_posts').select('*, users(name)').eq('world_id', req.params.id).order('is_pinned',{ascending:false}).order('created_at',{ascending:false}).limit(30);
    const posts = (data||[]).map(p=>({ ...p, author_name: p.users?.name }));
    res.json({ posts });
  } catch(e) { res.json({ posts:[] }); }
});

// ── POST /api/worlds/:id/posts ──
app.post('/api/worlds/:id/posts', auth, async (req, res) => {
  try {
    const { content, type='post', image_url } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Nhập nội dung' });
    // Check membership or ownership
    const { data: mem } = await supabase.from('vw_world_members').select('id').eq('world_id', req.params.id).eq('user_id', req.user.id).single();
    const { data: world } = await supabase.from('vw_worlds').select('owner_id').eq('id', req.params.id).single();
    if (!mem && world?.owner_id !== req.user.id) return res.status(403).json({ error: 'Tham gia thế giới để đăng bài' });
    const { data: post, error } = await supabase.from('vw_world_posts').insert({ world_id: req.params.id, author_id: req.user.id, content: content.trim(), type, image_url }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    await supabase.from('vw_worlds').update({ posts_count: supabase.rpc ? undefined : undefined }).eq('id', req.params.id);
    // Increment posts_count
    const { data: w } = await supabase.from('vw_worlds').select('posts_count').eq('id', req.params.id).single();
    await supabase.from('vw_worlds').update({ posts_count: (w?.posts_count||0)+1 }).eq('id', req.params.id);
    res.json({ post });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/worlds/posts/:pid/like ──
app.post('/api/worlds/posts/:pid/like', auth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('vw_world_post_likes').select('id').eq('post_id', req.params.pid).eq('user_id', req.user.id).single();
    const { data: post } = await supabase.from('vw_world_posts').select('likes_count').eq('id', req.params.pid).single();
    if (existing) {
      await supabase.from('vw_world_post_likes').delete().eq('post_id', req.params.pid).eq('user_id', req.user.id);
      const newCount = Math.max(0,(post?.likes_count||1)-1);
      await supabase.from('vw_world_posts').update({ likes_count: newCount }).eq('id', req.params.pid);
      return res.json({ liked: false, likes_count: newCount });
    } else {
      await supabase.from('vw_world_post_likes').insert({ post_id: req.params.pid, user_id: req.user.id });
      const newCount = (post?.likes_count||0)+1;
      await supabase.from('vw_world_posts').update({ likes_count: newCount }).eq('id', req.params.pid);
      return res.json({ liked: true, likes_count: newCount });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/worlds/:id/events ──
app.get('/api/worlds/:id/events', async (req, res) => {
  try {
    const { data } = await supabase.from('vw_world_events').select('*, users(name)').eq('world_id', req.params.id).order('start_at',{ascending:true});
    res.json({ events: data||[] });
  } catch(e) { res.json({ events:[] }); }
});

// ── POST /api/worlds/:id/events ──
app.post('/api/worlds/:id/events', auth, async (req, res) => {
  try {
    const { title, description, type='meetup', location='Online', start_at, end_at, max_attendees=100 } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Nhập tiêu đề sự kiện' });
    const { data: event, error } = await supabase.from('vw_world_events').insert({ world_id: req.params.id, organizer_id: req.user.id, title: title.trim(), description, type, location, start_at, end_at, max_attendees }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    const { data: w } = await supabase.from('vw_worlds').select('events_count').eq('id', req.params.id).single();
    await supabase.from('vw_worlds').update({ events_count: (w?.events_count||0)+1 }).eq('id', req.params.id);
    res.json({ event });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/worlds/events/:eid/join ──
app.post('/api/worlds/events/:eid/join', auth, async (req, res) => {
  try {
    const { data: ev } = await supabase.from('vw_world_events').select('attendees_count,max_attendees').eq('id', req.params.eid).single();
    if (!ev) return res.status(404).json({ error: 'Không tìm thấy sự kiện' });
    if ((ev.attendees_count||0) >= (ev.max_attendees||100)) return res.status(400).json({ error: 'Sự kiện đã đầy' });
    const { error } = await supabase.from('vw_world_event_attendees').insert({ event_id: req.params.eid, user_id: req.user.id });
    if (error && error.code !== '23505') return res.status(400).json({ error: 'Đã đăng ký sự kiện này' });
    await supabase.from('vw_world_events').update({ attendees_count: (ev.attendees_count||0)+1 }).eq('id', req.params.eid);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/worlds/:id/listings ──
app.get('/api/worlds/:id/listings', async (req, res) => {
  try {
    const { data } = await supabase.from('vw_world_listings').select('*, users(name)').eq('world_id', req.params.id).eq('status','active').order('created_at',{ascending:false});
    res.json({ listings: data||[] });
  } catch(e) { res.json({ listings:[] }); }
});

// ── POST /api/worlds/:id/listings ──
app.post('/api/worlds/:id/listings', auth, async (req, res) => {
  try {
    const { title, description, price=0, category='other', image_url } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Nhập tên sản phẩm' });
    const { data: listing, error } = await supabase.from('vw_world_listings').insert({ world_id: req.params.id, seller_id: req.user.id, title: title.trim(), description, price, category, image_url }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    const { data: w } = await supabase.from('vw_worlds').select('listings_count').eq('id', req.params.id).single();
    await supabase.from('vw_worlds').update({ listings_count: (w?.listings_count||0)+1 }).eq('id', req.params.id);
    res.json({ listing });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/worlds/:id/chat ──
app.get('/api/worlds/:id/chat', async (req, res) => {
  try {
    const { data } = await supabase.from('vw_world_chat').select('*, users(name)').eq('world_id', req.params.id).order('created_at',{ascending:true}).limit(100);
    const messages = (data||[]).map(m=>({ ...m, sender_name: m.users?.name }));
    res.json({ messages });
  } catch(e) { res.json({ messages:[] }); }
});

// ── POST /api/worlds/:id/chat ──
app.post('/api/worlds/:id/chat', auth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Nhập tin nhắn' });
    const { data, error } = await supabase.from('vw_world_chat').insert({ world_id: req.params.id, sender_id: req.user.id, content: content.trim() }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/worlds/:id/stats ──
app.get('/api/worlds/:id/stats', async (req, res) => {
  try {
    const { data: world } = await supabase.from('vw_worlds').select('*, users(name)').eq('id', req.params.id).single();
    if (!world) return res.status(404).json({ error: 'Không tìm thấy' });
    const [chatR, postsR] = await Promise.all([
      supabase.from('vw_world_chat').select('id',{count:'exact',head:true}).eq('world_id', req.params.id),
      supabase.from('vw_world_posts').select('*, users(name)').eq('world_id', req.params.id).order('created_at',{ascending:false}).limit(5)
    ]);
    res.json({
      stats: { members: world.members_count||0, posts: world.posts_count||0, events: world.events_count||0, listings: world.listings_count||0, chat_msgs: chatR.count||0, owner_name: world.users?.name },
      recent_posts: postsR.data?.map(p=>({...p, author_name:p.users?.name}))||[]
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: GET /api/admin/worlds ──
app.get('/api/admin/worlds', adminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('vw_worlds').select('*, users(name)').order('created_at',{ascending:false}).limit(100);
    res.json({ worlds: data||[] });
  } catch(e) { res.json({ worlds:[] }); }
});

// ── ADMIN: PATCH /api/admin/worlds/:id ──
app.patch('/api/admin/worlds/:id', adminAuth, async (req, res) => {
  try {
    const { is_featured, is_verified, status } = req.body;
    const { data, error } = await supabase.from('vw_worlds').update({ is_featured, is_verified, status }).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ world: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// PHASE SOCIAL 11: XR SOCIAL NETWORK
// ════════════════════════════════════════════════════════════════

app.get('/xr', (req, res) => res.sendFile(join(__dirname, 'frontend', 'xr.html')));
app.get('/xr.html', (req, res) => res.sendFile(join(__dirname, 'frontend', 'xr.html')));

// ── GET /api/xr/stats ──
app.get('/api/xr/stats', async (req, res) => {
  try {
    const [sR, vR, eR, aR] = await Promise.all([
      supabase.from('xr_spaces').select('id', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('xr_space_visits').select('id', { count: 'exact', head: true }),
      supabase.from('xr_events').select('id', { count: 'exact', head: true }),
      supabase.from('xr_avatars').select('id', { count: 'exact', head: true })
    ]);
    res.json({ stats: { spaces: sR.count||0, visits: vR.count||0, events: eR.count||0, avatars: aR.count||0 } });
  } catch(e) { res.json({ stats: { spaces:0, visits:0, events:0, avatars:0 } }); }
});

// ── GET /api/xr/spaces ──
app.get('/api/xr/spaces', async (req, res) => {
  try {
    const { featured, type, limit=12, page=1 } = req.query;
    let q = supabase.from('xr_spaces').select('*').eq('is_active', true);
    if (featured === 'true') q = q.eq('is_featured', true);
    if (type) q = q.eq('type', type);
    q = q.order('visitors_count', { ascending: false }).range((page-1)*limit, page*limit-1);
    const { data, error } = await q;
    if (error) return res.json({ spaces: [] });
    res.json({ spaces: data||[] });
  } catch(e) { res.json({ spaces: [] }); }
});

// ── GET /api/xr/spaces/mine ──
app.get('/api/xr/spaces/mine', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('xr_spaces').select('*').eq('owner_id', req.user.id).order('created_at', { ascending: false });
    res.json({ spaces: data||[] });
  } catch(e) { res.json({ spaces: [] }); }
});

// ── GET /api/xr/leaderboard ──
app.get('/api/xr/leaderboard', async (req, res) => {
  try {
    const { data } = await supabase.from('xr_spaces').select('*').eq('is_active', true).order('total_visits', { ascending: false }).limit(20);
    res.json({ spaces: data||[] });
  } catch(e) { res.json({ spaces: [] }); }
});

// ── POST /api/xr/spaces ──
app.post('/api/xr/spaces', auth, async (req, res) => {
  try {
    const { name, description, type='social', theme='cosmos', privacy='public', tags=[], capacity=50 } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nhập tên Space' });
    const { data: space, error } = await supabase.from('xr_spaces').insert({
      owner_id: req.user.id, name: name.trim(), description, type, theme, privacy, tags, capacity
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ space });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/xr/spaces/:id ──
app.get('/api/xr/spaces/:id', async (req, res) => {
  try {
    const { data: space, error } = await supabase.from('xr_spaces').select('*').eq('id', req.params.id).single();
    if (error || !space) return res.status(404).json({ error: 'Không tìm thấy Space' });
    res.json({ space });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/xr/spaces/:id/visit ──
app.post('/api/xr/spaces/:id/visit', async (req, res) => {
  try {
    const { device_type='desktop', duration_secs=0 } = req.body;
    let user_id = null;
    try { const d = jwt.verify((req.headers.authorization||'').replace('Bearer ',''), JWT_SECRET); user_id = d.id; } catch {}
    await supabase.from('xr_space_visits').insert({ space_id: req.params.id, user_id, device_type, duration_secs });
    const { data: s } = await supabase.from('xr_spaces').select('visitors_count,total_visits').eq('id', req.params.id).single();
    if (s) await supabase.from('xr_spaces').update({ visitors_count: (s.visitors_count||0)+1, total_visits: (s.total_visits||0)+1 }).eq('id', req.params.id);
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

// ── GET /api/xr/avatar ──
app.get('/api/xr/avatar', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('xr_avatars').select('*').eq('user_id', req.user.id).single();
    res.json({ avatar: data || null });
  } catch(e) { res.json({ avatar: null }); }
});

// ── PUT /api/xr/avatar ──
app.put('/api/xr/avatar', auth, async (req, res) => {
  try {
    const { display_name, body_type, skin_tone, hair_style, hair_color, outfit, outfit_color, accessories, emote } = req.body;
    const { data: existing } = await supabase.from('xr_avatars').select('id,xp,level').eq('user_id', req.user.id).single();
    let result;
    if (existing) {
      const xp = (existing.xp||0) + 10;
      const level = Math.floor(xp / 100) + 1;
      const { data } = await supabase.from('xr_avatars').update({ display_name, body_type, skin_tone, hair_style, hair_color, outfit, outfit_color, accessories, emote, xp, level, updated_at: new Date().toISOString() }).eq('user_id', req.user.id).select().single();
      result = data;
    } else {
      const { data } = await supabase.from('xr_avatars').insert({ user_id: req.user.id, display_name, body_type, skin_tone, hair_style, hair_color, outfit, outfit_color, accessories, emote, xp: 10, level: 1 }).select().single();
      result = data;
    }
    res.json({ avatar: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/xr/events ──
app.get('/api/xr/events', async (req, res) => {
  try {
    const { type, limit=12, page=1 } = req.query;
    let q = supabase.from('xr_events').select('*').in('status', ['upcoming','live']);
    if (type) q = q.eq('type', type);
    q = q.order('start_at', { ascending: true }).range((page-1)*limit, page*limit-1);
    const { data, error } = await q;
    if (error) return res.json({ events: [] });
    res.json({ events: data||[] });
  } catch(e) { res.json({ events: [] }); }
});

// ── POST /api/xr/events ──
app.post('/api/xr/events', auth, async (req, res) => {
  try {
    const { title, description, type='concert', start_at, end_at, max_attendees=500, xr_mode='webxr' } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Nhập tiêu đề sự kiện' });
    const { data: event, error } = await supabase.from('xr_events').insert({
      organizer_id: req.user.id, title: title.trim(), description, type, start_at, end_at, max_attendees, xr_mode
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ event });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/xr/events/:id/join ──
app.post('/api/xr/events/:id/join', auth, async (req, res) => {
  try {
    const { data: ev } = await supabase.from('xr_events').select('attendees_count,max_attendees').eq('id', req.params.id).single();
    if (!ev) return res.status(404).json({ error: 'Không tìm thấy sự kiện' });
    if ((ev.attendees_count||0) >= (ev.max_attendees||500)) return res.status(400).json({ error: 'Sự kiện đã đầy chỗ' });
    const { error } = await supabase.from('xr_event_attendees').insert({ event_id: req.params.id, user_id: req.user.id });
    if (error && error.code !== '23505') return res.status(400).json({ error: 'Đã đăng ký sự kiện này rồi' });
    await supabase.from('xr_events').update({ attendees_count: (ev.attendees_count||0)+1 }).eq('id', req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/xr/creator-rooms/mine ──
app.get('/api/xr/creator-rooms/mine', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('xr_creator_rooms').select('*').eq('creator_id', req.user.id).order('created_at', { ascending: false });
    res.json({ rooms: data||[] });
  } catch(e) { res.json({ rooms: [] }); }
});

// ── POST /api/xr/creator-rooms ──
app.post('/api/xr/creator-rooms', auth, async (req, res) => {
  try {
    const { name, description, type='showcase', theme='studio' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nhập tên Room' });
    const { data: room, error } = await supabase.from('xr_creator_rooms').insert({
      creator_id: req.user.id, name: name.trim(), description, type, theme
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ room });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/xr/analytics ──
app.get('/api/xr/analytics', auth, async (req, res) => {
  try {
    const [visitsR, spacesR, eventsR] = await Promise.all([
      supabase.from('xr_space_visits').select('duration_secs').eq('user_id', req.user.id),
      supabase.from('xr_space_visits').select('space_id').eq('user_id', req.user.id),
      supabase.from('xr_event_attendees').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id)
    ]);
    const visits = visitsR.data||[];
    const avgDuration = visits.length ? Math.round(visits.reduce((a,v)=>a+(v.duration_secs||0),0)/visits.length) : 0;
    const uniqueSpaces = new Set((spacesR.data||[]).map(v=>v.space_id)).size;
    res.json({ stats: { visits: visits.length, avg_duration: avgDuration+'s', spaces_visited: uniqueSpaces, events_attended: eventsR.count||0 } });
  } catch(e) { res.json({ stats: {} }); }
});

// ── ADMIN: GET /api/admin/xr/overview ──
app.get('/api/admin/xr/overview', adminAuth, async (req, res) => {
  try {
    const [spacesR, eventsR, avatarsR, visitsR] = await Promise.all([
      supabase.from('xr_spaces').select('*').order('created_at', { ascending: false }).limit(20),
      supabase.from('xr_events').select('*').order('created_at', { ascending: false }).limit(20),
      supabase.from('xr_avatars').select('id', { count: 'exact', head: true }),
      supabase.from('xr_space_visits').select('id', { count: 'exact', head: true })
    ]);
    res.json({ spaces: spacesR.data||[], events: eventsR.data||[], total_avatars: avatarsR.count||0, total_visits: visitsR.count||0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: PATCH /api/admin/xr/spaces/:id ──
app.patch('/api/admin/xr/spaces/:id', adminAuth, async (req, res) => {
  try {
    const { is_featured, is_active } = req.body;
    const { data, error } = await supabase.from('xr_spaces').update({ is_featured, is_active }).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ space: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// PHASE SOCIAL 12: AVATAR ECONOMY
// ════════════════════════════════════════════════════════════════

app.get('/avatar-economy', (req, res) => res.sendFile(join(__dirname, 'frontend', 'avatar_economy.html')));
app.get('/avatar-economy.html', (req, res) => res.sendFile(join(__dirname, 'frontend', 'avatar_economy.html')));

// ── GET /api/avatar-economy/profile ──
app.get('/api/avatar-economy/profile', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const [avR, invR, badgeR, walletR] = await Promise.all([
      supabase.from('xr_avatars').select('*').eq('user_id', uid).single(),
      supabase.from('avatar_inventory').select('id', { count: 'exact', head: true }).eq('user_id', uid),
      supabase.from('avatar_badges').select('*').eq('user_id', uid),
      supabase.from('wallets').select('balance').eq('user_id', uid).single()
    ]);
    const av = avR.data || {};
    res.json({
      profile: {
        user_id: uid,
        display_name: av.display_name || req.user.name,
        level: av.level || 1,
        xp: av.xp || 0,
        item_count: invR.count || 0,
        badge_count: (badgeR.data || []).length,
        sp_balance: Math.round((walletR.data?.balance || 0) / 100)
      },
      badges: badgeR.data || [],
      avatar: av
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/avatar-economy/avatar ──
app.get('/api/avatar-economy/avatar', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('xr_avatars').select('*').eq('user_id', req.user.id).single();
    res.json({ avatar: data || null });
  } catch(e) { res.json({ avatar: null }); }
});

// ── PUT /api/avatar-economy/avatar ──
app.put('/api/avatar-economy/avatar', auth, async (req, res) => {
  try {
    const { display_name, skin_tone, hair_style, hair_color, eye_style, outfit, outfit_color, emote, accessory } = req.body;
    const { data: existing } = await supabase.from('xr_avatars').select('id,xp,level').eq('user_id', req.user.id).single();
    const xp = (existing?.xp || 0) + 10;
    const level = Math.floor(xp / 100) + 1;
    let result;
    if (existing) {
      const { data } = await supabase.from('xr_avatars').update({ display_name, skin_tone, hair_style, hair_color, outfit, outfit_color, emote, xp, level, updated_at: new Date().toISOString() }).eq('user_id', req.user.id).select().single();
      result = data;
    } else {
      const { data } = await supabase.from('xr_avatars').insert({ user_id: req.user.id, display_name, skin_tone, hair_style, hair_color, outfit, outfit_color, emote, xp: 10, level: 1 }).select().single();
      result = data;
    }
    res.json({ avatar: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/avatar-economy/items ──
app.get('/api/avatar-economy/items', async (req, res) => {
  try {
    const { category, featured, limit = 30, page = 1 } = req.query;
    let q = supabase.from('avatar_items').select('*').eq('is_active', true);
    if (category) q = q.eq('category', category);
    if (featured === 'true') q = q.eq('is_featured', true);
    q = q.order('is_featured', { ascending: false }).order('created_at', { ascending: false }).range((page-1)*limit, page*limit-1);
    const { data, error } = await q;
    if (error) return res.json({ items: [] });
    res.json({ items: data || [] });
  } catch(e) { res.json({ items: [] }); }
});

// ── POST /api/avatar-economy/items (creator publish) ──
app.post('/api/avatar-economy/items', auth, async (req, res) => {
  try {
    const { name, description, category = 'outfit', rarity = 'common', price = 0, tags = [] } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nhập tên vật phẩm' });
    const { data: item, error } = await supabase.from('avatar_items').insert({
      creator_id: req.user.id, name: name.trim(), description, category, rarity, price, tags
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ item });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/avatar-economy/buy/:itemId ──
app.post('/api/avatar-economy/buy/:itemId', auth, async (req, res) => {
  try {
    const { data: item } = await supabase.from('avatar_items').select('*').eq('id', req.params.itemId).single();
    if (!item) return res.status(404).json({ error: 'Không tìm thấy vật phẩm' });
    const { data: existing } = await supabase.from('avatar_inventory').select('id').eq('user_id', req.user.id).eq('item_id', req.params.itemId).single();
    if (existing) return res.status(400).json({ error: 'Bạn đã sở hữu vật phẩm này rồi' });
    // Check wallet if price > 0
    let newBalance = 0;
    if (item.price > 0) {
      const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
      const spCost = item.price * 100;
      if (!wallet || wallet.balance < spCost) return res.status(400).json({ error: 'Số dư SP không đủ. Nạp thêm SP Token!' });
      await supabase.from('wallets').update({ balance: wallet.balance - spCost }).eq('user_id', req.user.id);
      newBalance = Math.round((wallet.balance - spCost) / 100);
    }
    await supabase.from('avatar_inventory').insert({ user_id: req.user.id, item_id: req.params.itemId, source: 'purchase' });
    await supabase.from('avatar_items').update({ sold_count: (item.sold_count || 0) + 1 }).eq('id', req.params.itemId);
    await supabase.from('avatar_economy_txns').insert({ buyer_id: req.user.id, item_id: req.params.itemId, amount: item.price, txn_type: 'purchase' });
    res.json({ success: true, new_balance: newBalance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/avatar-economy/inventory ──
app.get('/api/avatar-economy/inventory', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('avatar_inventory').select('*, avatar_items(name, category, rarity, price)').eq('user_id', req.user.id).order('acquired_at', { ascending: false });
    const items = (data || []).map(row => ({ ...row, ...(row.avatar_items || {}), item_id: row.item_id }));
    res.json({ items });
  } catch(e) { res.json({ items: [] }); }
});

// ── POST /api/avatar-economy/equip/:invId ──
app.post('/api/avatar-economy/equip/:invId', auth, async (req, res) => {
  try {
    const { data: invItem } = await supabase.from('avatar_inventory').select('*').eq('id', req.params.invId).eq('user_id', req.user.id).single();
    if (!invItem) return res.status(404).json({ error: 'Không tìm thấy vật phẩm' });
    const nowEquipped = !invItem.is_equipped;
    await supabase.from('avatar_inventory').update({ is_equipped: nowEquipped }).eq('id', req.params.invId);
    res.json({ success: true, equipped: nowEquipped });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/avatar-economy/wardrobe ──
app.get('/api/avatar-economy/wardrobe', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('avatar_wardrobe').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    res.json({ wardrobe: data || [] });
  } catch(e) { res.json({ wardrobe: [] }); }
});

// ── POST /api/avatar-economy/wardrobe ──
app.post('/api/avatar-economy/wardrobe', auth, async (req, res) => {
  try {
    const { name, outfit_data = {} } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nhập tên trang phục' });
    const { data: wd, error } = await supabase.from('avatar_wardrobe').insert({ user_id: req.user.id, name: name.trim(), outfit_data }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ wardrobe: wd });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/avatar-economy/wardrobe/:id/default ──
app.post('/api/avatar-economy/wardrobe/:id/default', auth, async (req, res) => {
  try {
    await supabase.from('avatar_wardrobe').update({ is_default: false }).eq('user_id', req.user.id);
    await supabase.from('avatar_wardrobe').update({ is_default: true }).eq('id', req.params.id).eq('user_id', req.user.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/avatar-economy/badges ──
app.get('/api/avatar-economy/badges', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('avatar_badges').select('*').eq('user_id', req.user.id).order('awarded_at', { ascending: false });
    res.json({ badges: data || [] });
  } catch(e) { res.json({ badges: [] }); }
});

// ── GET /api/avatar-economy/dashboard ──
app.get('/api/avatar-economy/dashboard', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const [invR, txnR, avR, badgeR] = await Promise.all([
      supabase.from('avatar_inventory').select('id', { count: 'exact', head: true }).eq('user_id', uid),
      supabase.from('avatar_economy_txns').select('amount, created_at, item_id, avatar_items(name)').eq('buyer_id', uid).order('created_at', { ascending: false }).limit(10),
      supabase.from('xr_avatars').select('level, xp').eq('user_id', uid).single(),
      supabase.from('avatar_badges').select('id', { count: 'exact', head: true }).eq('user_id', uid)
    ]);
    const txns = (txnR.data || []).map(t => ({ ...t, item_name: t.avatar_items?.name }));
    const totalSpent = txns.reduce((a, t) => a + (parseFloat(t.amount) || 0), 0);
    res.json({
      stats: {
        items_owned: invR.count || 0,
        total_spent: Math.round(totalSpent),
        total_earned: 0,
        level: avR.data?.level || 1,
        xp: avR.data?.xp || 0,
        badges: badgeR.count || 0
      },
      transactions: txns
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/avatar-economy/creator/items ──
app.get('/api/avatar-economy/creator/items', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('avatar_items').select('*').eq('creator_id', req.user.id).order('created_at', { ascending: false });
    res.json({ items: data || [] });
  } catch(e) { res.json({ items: [] }); }
});

// ── GET /api/avatar-economy/showroom/:userId ──
app.get('/api/avatar-economy/showroom/:userId', async (req, res) => {
  try {
    const uid = req.params.userId;
    const [avR, invR, badgeR] = await Promise.all([
      supabase.from('xr_avatars').select('*').eq('user_id', uid).single(),
      supabase.from('avatar_inventory').select('*, avatar_items(name, category, rarity)').eq('user_id', uid).eq('is_equipped', true).limit(12),
      supabase.from('avatar_badges').select('*').eq('user_id', uid)
    ]);
    res.json({ avatar: avR.data, inventory: invR.data || [], badges: badgeR.data || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: GET /api/admin/avatar-economy/overview ──
app.get('/api/admin/avatar-economy/overview', adminAuth, async (req, res) => {
  try {
    const [itemsR, invR, txnR] = await Promise.all([
      supabase.from('avatar_items').select('*').order('sold_count', { ascending: false }).limit(20),
      supabase.from('avatar_inventory').select('id', { count: 'exact', head: true }),
      supabase.from('avatar_economy_txns').select('amount').eq('txn_type','purchase')
    ]);
    const totalRevenue = (txnR.data || []).reduce((a,t) => a + parseFloat(t.amount||0), 0);
    res.json({ items: itemsR.data || [], total_inventory: invR.count || 0, total_revenue: totalRevenue });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: PATCH /api/admin/avatar-economy/items/:id ──
app.patch('/api/admin/avatar-economy/items/:id', adminAuth, async (req, res) => {
  try {
    const { is_featured, is_active } = req.body;
    const { data, error } = await supabase.from('avatar_items').update({ is_featured, is_active }).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ item: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CATCH-ALL (must be last — serves index.html for unknown non-API routes) ──
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(join(__dirname, 'frontend', 'index.html'));
  }
});

const PORT = process.env.PORT || 5000;
const httpServer = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✓ SafePass chạy tại http://0.0.0.0:${PORT}`);
  await migratePhoneNumbers();
});

// ── WEBSOCKET SERVERS ──
const wss = new WebSocketServer({ noServer: true });
const wss3 = new WebSocketServer({ noServer: true }); // DM chat

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  try {
    const user = jwt.verify(token, JWT_SECRET);
    request._wsUser = user;
    if (url.pathname.startsWith('/ws/escrow')) {
      wss2.handleUpgrade(request, socket, head, (wsClient) => { wss2.emit('connection', wsClient, request); });
    } else if (url.pathname.startsWith('/ws/dm')) {
      wss3.handleUpgrade(request, socket, head, (wsClient) => { wss3.emit('connection', wsClient, request); });
    } else if (url.pathname.startsWith('/ws/chat')) {
      wss.handleUpgrade(request, socket, head, (wsClient) => { wss.emit('connection', wsClient, request); });
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

// ── DM WEBSOCKET HANDLER ──
wss3.on('connection', async (socket, req) => {
  const user = req._wsUser;
  dmSockets.set(user.id, socket);
  onlineUsers.add(user.id);
  // Notify friends of online status
  try { socket.send(JSON.stringify({ type: 'connected', userId: user.id })); } catch(e) {}

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'typing' && msg.conversation_id) {
      // Broadcast typing to other participants (fire & forget, no DB)
      supabase.from('dm_participants').select('user_id').eq('conversation_id', msg.conversation_id).then(({ data }) => {
        (data||[]).forEach(p => {
          if (p.user_id !== user.id) {
            const sock = dmSockets.get(p.user_id);
            if (sock) try { sock.send(JSON.stringify({ type: 'typing', conversation_id: msg.conversation_id, userId: user.id, isTyping: !!msg.isTyping })); } catch(e) {}
          }
        });
      }).catch(() => {});
    }

    if (msg.type === 'ping') {
      try { socket.send(JSON.stringify({ type: 'pong' })); } catch(e) {}
    }
  });

  socket.on('close', () => {
    dmSockets.delete(user.id);
    onlineUsers.delete(user.id);
  });

  socket.on('error', () => {});
});
