/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║         BẢO MẬT VÀ CHỐNG HACK TOÀN BỘ HỆ THỐNG                 ║
 * ║   Multi-Layer Security Engine — SafePass Platform                ║
 * ║   Layers: Network → Request → Auth → Data → Behavioral          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// ═══════════════════════════════════════════════════════
// LAYER 1: IP INTELLIGENCE & BLOCKING ENGINE
// ═══════════════════════════════════════════════════════
const ipBlocklist = new Set();
const ipRequestMap = new Map();         // ip → { count, firstSeen, strikes }
const ipFingerprintMap = new Map();     // ip → Set of user-agents
const suspiciousIPs = new Map();        // ip → { reason, bannedAt }
const honeypotHits = new Set();         // IPs that hit honeypot routes

const IP_CONFIG = {
  MAX_REQUESTS_PER_MINUTE: 120,
  MAX_REQUESTS_PER_SECOND: 10,
  MAX_UA_VARIATIONS: 5,
  BAN_DURATION_MS: 30 * 60 * 1000,
  HONEYPOT_INSTANT_BAN: true
}

// IPs luôn được tin tưởng — không bao giờ bị ban (localhost, Replit proxy)
const TRUSTED_IPS = new Set([
  '127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', '0.0.0.0'
]);

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    '0.0.0.0'
  );
}

function recordIPActivity(ip, ua) {
  const now = Date.now();
  if (!ipRequestMap.has(ip)) {
    ipRequestMap.set(ip, { count: 0, firstSeen: now, windowStart: now, windowCount: 0, strikes: 0 });
  }
  const record = ipRequestMap.get(ip);
  record.count++;

  // Reset per-second window
  if (now - record.windowStart > 1000) {
    record.windowStart = now;
    record.windowCount = 0;
  }
  record.windowCount++;

  // Track user-agent diversity per IP
  if (ua) {
    if (!ipFingerprintMap.has(ip)) ipFingerprintMap.set(ip, new Set());
    ipFingerprintMap.get(ip).add(ua.slice(0, 80));
  }

  return record;
}

function isIPBanned(ip) {
  if (ipBlocklist.has(ip)) return { banned: true, reason: 'Permanent blocklist' };
  if (suspiciousIPs.has(ip)) {
    const info = suspiciousIPs.get(ip);
    if (Date.now() - info.bannedAt < IP_CONFIG.BAN_DURATION_MS) {
      return { banned: true, reason: info.reason };
    }
    suspiciousIPs.delete(ip); // ban expired
  }
  return { banned: false };
}

function banIP(ip, reason) {
  suspiciousIPs.set(ip, { reason, bannedAt: Date.now() });
  securityLog('BAN', ip, reason);
}

// ═══════════════════════════════════════════════════════
// LAYER 2: REQUEST SIGNATURE & REPLAY ATTACK PREVENTION
// ═══════════════════════════════════════════════════════
const usedNonces = new Map(); // nonce → timestamp

function generateSecureNonce() {
  return crypto.randomBytes(32).toString('hex');
}

function cleanExpiredNonces() {
  const cutoff = Date.now() - 5 * 60 * 1000; // 5 min TTL
  for (const [nonce, ts] of usedNonces.entries()) {
    if (ts < cutoff) usedNonces.delete(nonce);
  }
}

setInterval(cleanExpiredNonces, 60 * 1000);

// ═══════════════════════════════════════════════════════
// LAYER 3: PAYLOAD INSPECTION ENGINE
// ═══════════════════════════════════════════════════════

// SQL Injection patterns
const SQL_INJECTION_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|TRUNCATE|REPLACE)\b)/gi,
  /('|\"|;|--|\/\*|\*\/|xp_|sp_)/g,
  /(\bOR\b|\bAND\b)\s+[\d'"]/gi,
  /SLEEP\s*\(/gi,
  /BENCHMARK\s*\(/gi,
  /LOAD_FILE\s*\(/gi,
  /INFORMATION_SCHEMA/gi,
  /SYS\.TABLES/gi
];

// XSS patterns
const XSS_PATTERNS = [
  /<script[\s>]/gi,
  /javascript:/gi,
  /on(load|error|click|mouseover|focus|blur|change|submit|reset|keydown|keyup|keypress)\s*=/gi,
  /<iframe/gi,
  /<object/gi,
  /<embed/gi,
  /eval\s*\(/gi,
  /document\.(cookie|domain|location|write)/gi,
  /window\.location/gi,
  /\.innerHTML\s*=/gi,
  /fromCharCode/gi,
  /&#x/gi
];

// Path traversal patterns
const PATH_TRAVERSAL_PATTERNS = [
  /\.\.\//g,
  /\.\.%2f/gi,
  /%2e%2e/gi,
  /\/etc\/passwd/gi,
  /\/etc\/shadow/gi,
  /\/proc\/self/gi,
  /\\\.\\./g
];

// Command injection patterns
const CMD_INJECTION_PATTERNS = [
  /[;&|`$](\s*)(ls|cat|pwd|id|whoami|uname|wget|curl|bash|sh|python|perl|ruby)/gi,
  /\|\s*(bash|sh|cmd)/gi,
  />\s*\/dev\//gi
];

function deepScanValue(value, path = '') {
  if (typeof value === 'string') {
    for (const pattern of SQL_INJECTION_PATTERNS) {
      if (pattern.test(value)) {
        pattern.lastIndex = 0;
        return { threat: 'SQL_INJECTION', path, value: value.slice(0, 100) };
      }
      pattern.lastIndex = 0;
    }
    for (const pattern of XSS_PATTERNS) {
      if (pattern.test(value)) {
        pattern.lastIndex = 0;
        return { threat: 'XSS', path, value: value.slice(0, 100) };
      }
      pattern.lastIndex = 0;
    }
    for (const pattern of PATH_TRAVERSAL_PATTERNS) {
      if (pattern.test(value)) {
        pattern.lastIndex = 0;
        return { threat: 'PATH_TRAVERSAL', path, value: value.slice(0, 100) };
      }
      pattern.lastIndex = 0;
    }
    for (const pattern of CMD_INJECTION_PATTERNS) {
      if (pattern.test(value)) {
        pattern.lastIndex = 0;
        return { threat: 'CMD_INJECTION', path, value: value.slice(0, 100) };
      }
      pattern.lastIndex = 0;
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      const result = deepScanValue(v, `${path}.${k}`);
      if (result) return result;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════
// LAYER 4: BEHAVIORAL ANOMALY DETECTION
// ═══════════════════════════════════════════════════════
const userBehaviorMap = new Map(); // userId → { actions: [], lastSeen, anomalyScore }

const ANOMALY_RULES = {
  RAPID_ORDER_CREATION: { window: 60_000, max: 3, score: 40 },
  RAPID_FAILED_AUTH: { window: 300_000, max: 5, score: 60 },
  LARGE_PAYLOAD: { threshold: 100_000, score: 20 },      // bytes
  UNUSUAL_HOUR: { startHour: 2, endHour: 5, score: 10 }, // 2-5 AM
  RAPID_PROFILE_CHANGES: { window: 3_600_000, max: 10, score: 30 }
}

function recordBehavior(userId, action, meta = {}) {
  if (!userId) return 0;
  const now = Date.now();

  if (!userBehaviorMap.has(userId)) {
    userBehaviorMap.set(userId, { actions: [], anomalyScore: 0, lastSeen: now });
  }

  const profile = userBehaviorMap.get(userId);
  profile.actions.push({ action, ts: now, ...meta });
  profile.lastSeen = now;

  // Trim old actions (keep last 1 hour)
  profile.actions = profile.actions.filter(a => now - a.ts < 3_600_000);

  let score = 0;

  // Check rapid order creation
  const recentOrders = profile.actions.filter(
    a => a.action === 'CREATE_ORDER' && now - a.ts < ANOMALY_RULES.RAPID_ORDER_CREATION.window
  );
  if (recentOrders.length > ANOMALY_RULES.RAPID_ORDER_CREATION.max) {
    score += ANOMALY_RULES.RAPID_ORDER_CREATION.score;
  }

  // Check rapid failed auth
  const recentFailedAuth = profile.actions.filter(
    a => a.action === 'FAILED_AUTH' && now - a.ts < ANOMALY_RULES.RAPID_FAILED_AUTH.window
  );
  if (recentFailedAuth.length > ANOMALY_RULES.RAPID_FAILED_AUTH.max) {
    score += ANOMALY_RULES.RAPID_FAILED_AUTH.score;
  }

  // Unusual hour check
  const hour = new Date().getHours();
  if (hour >= ANOMALY_RULES.UNUSUAL_HOUR.startHour && hour < ANOMALY_RULES.UNUSUAL_HOUR.endHour) {
    score += ANOMALY_RULES.UNUSUAL_HOUR.score;
  }

  profile.anomalyScore = score;
  return score;
}

// ═══════════════════════════════════════════════════════
// LAYER 5: TOKEN INTEGRITY VALIDATOR
// ═══════════════════════════════════════════════════════
const revokedTokens = new Set();

function revokeToken(jti) {
  revokedTokens.add(jti);
}

function isTokenRevoked(jti) {
  return revokedTokens.has(jti);
}

function generateJTI() {
  return crypto.randomBytes(16).toString('hex');
}

// ═══════════════════════════════════════════════════════
// LAYER 6: HONEYPOT TRAP ROUTES
// ═══════════════════════════════════════════════════════
const HONEYPOT_PATHS = [
  '/admin', '/wp-admin', '/wp-login.php', '/phpmyadmin', '/mysql',
  '/.env', '/.git/config', '/config.php', '/backup.zip', '/db.sql',
  '/server.js.bak', '/api/debug', '/api/test', '/console',
  '/api/v0/', '/actuator', '/swagger.json', '/api-docs'
];

function installHoneypots(app) {
  HONEYPOT_PATHS.forEach(path => {
    app.all(path, (req, res) => {
      const ip = getClientIP(req);
      honeypotHits.add(ip);
      banIP(ip, `Honeypot hit: ${path}`);
      securityLog('HONEYPOT', ip, `Accessed ${path}`);
      res.status(404).json({ error: 'Not found' });
    });
  });
}

// ═══════════════════════════════════════════════════════
// LAYER 7: SECURITY EVENT LOGGER
// ═══════════════════════════════════════════════════════
const securityEvents = [];
const MAX_EVENTS = 10_000;

function securityLog(type, ip, detail, userId = null) {
  const event = {
    ts: new Date().toISOString(),
    type,
    ip,
    userId,
    detail: String(detail).slice(0, 500)
  };
  securityEvents.unshift(event);
  if (securityEvents.length > MAX_EVENTS) securityEvents.splice(MAX_EVENTS);

  const prefix = type === 'BAN' || type === 'ATTACK' ? '🚨' : type === 'HONEYPOT' ? '🍯' : '🔒';
  console.error(`${prefix} [SECURITY][${type}] IP=${ip} USER=${userId || '-'} → ${detail}`);
}

// ═══════════════════════════════════════════════════════
// LAYER 8: CSPP / CSRF DEFENSE
// ═══════════════════════════════════════════════════════
const SAFE_ORIGINS = new Set([
  process.env.ALLOWED_ORIGIN,
  `https://${process.env.REPLIT_DEV_DOMAIN}`
].filter(Boolean));

function validateOrigin(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return true; // direct API call
  return [...SAFE_ORIGINS].some(o => o && origin.startsWith(o));
}

// ═══════════════════════════════════════════════════════
// MIDDLEWARE FACTORY — attach to Express app
// ═══════════════════════════════════════════════════════

/**
 * Master security middleware — plug into Express:
 *   import security from './BẢOMẬTVÀCHỐNGHACKTOÀNBỘHỆTHỐNG.JS';
 *   security.applyAll(app);
 */

function middlewareIPShield(req, res, next) {
  const ip = getClientIP(req);
  const ua = req.headers['user-agent'] || '';

  // Whitelist localhost / Replit internal proxy — không bao giờ bị chặn
  if (TRUSTED_IPS.has(ip)) return next();

  const banInfo = isIPBanned(ip);
  if (banInfo.banned) {
    securityLog('BLOCKED', ip, banInfo.reason);
    return res.status(403).json({ error: 'Truy cập bị từ chối.' });
  }

  const record = recordIPActivity(ip, ua);

  // Per-second burst check
  if (record.windowCount > IP_CONFIG.MAX_REQUESTS_PER_SECOND) {
    record.strikes = (record.strikes || 0) + 1;
    if (record.strikes >= 5) banIP(ip, 'Request burst detected');
    securityLog('BURST', ip, `${record.windowCount} req/s`);
    return res.status(429).json({ error: 'Quá nhiều yêu cầu.' });
  }

  // Per-minute check
  const elapsed = (Date.now() - record.firstSeen) / 60_000;
  const rpm = record.count / Math.max(elapsed, 1 / 60);
  if (rpm > IP_CONFIG.MAX_REQUESTS_PER_MINUTE) {
    banIP(ip, `High RPM: ${Math.round(rpm)}`);
    return res.status(429).json({ error: 'Quá nhiều yêu cầu.' });
  }

  // Too many user-agent variations from same IP = bot
  const uaCount = (ipFingerprintMap.get(ip) || new Set()).size;
  if (uaCount > IP_CONFIG.MAX_UA_VARIATIONS) {
    banIP(ip, `UA variation abuse: ${uaCount} different agents`);
    return res.status(403).json({ error: 'Truy cập bị từ chối.' });
  }

  req.clientIP = ip;
  next();
}

function middlewarePayloadScanner(req, res, next) {
  // Check payload size
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > ANOMALY_RULES.LARGE_PAYLOAD.threshold) {
    securityLog('LARGE_PAYLOAD', req.clientIP, `${contentLength} bytes`);
  }

  // Scan body, query, params
  const targets = [req.body, req.query, req.params];
  for (const target of targets) {
    if (!target) continue;
    const threat = deepScanValue(target);
    if (threat) {
      securityLog('ATTACK', req.clientIP, `${threat.threat} at ${threat.path}: ${threat.value}`);
      banIP(req.clientIP, `Attack: ${threat.threat}`);
      return res.status(400).json({ error: 'Yêu cầu không hợp lệ.' });
    }
  }

  // Scan URL
  const urlThreat = deepScanValue({ url: req.originalUrl });
  if (urlThreat) {
    securityLog('ATTACK', req.clientIP, `URL injection: ${req.originalUrl.slice(0, 200)}`);
    return res.status(400).json({ error: 'URL không hợp lệ.' });
  }

  next();
}

function middlewareSecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Cache-Control', 'no-store');
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');
  next();
}

function middlewareAntiCSRF(req, res, next) {
  const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (mutatingMethods.includes(req.method) && !req.path.startsWith('/api/auth')) {
    if (!validateOrigin(req)) {
      securityLog('CSRF', req.clientIP, `Bad origin: ${req.headers.origin}`);
      return res.status(403).json({ error: 'Yêu cầu không hợp lệ (CSRF).' });
    }
  }
  next();
}

function middlewareSensitiveDataMasker(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function (data) {
    const masked = maskSensitiveFields(data);
    return originalJson(masked);
  };
  next();
}

const SENSITIVE_FIELD_NAMES = [
  'password', 'password_hash', 'secret', 'token', 'private_key',
  'bank_account', 'cvv', 'card_number', 'pin', 'otp_code'
];

function maskSensitiveFields(obj) {
  if (Array.isArray(obj)) return obj.map(maskSensitiveFields);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_FIELD_NAMES.some(f => k.toLowerCase().includes(f))) {
        result[k] = '***REDACTED***';
      } else {
        result[k] = maskSensitiveFields(v);
      }
    }
    return result;
  }
  return obj;
}

// ═══════════════════════════════════════════════════════
// AUTOMATED THREAT RESPONSE
// ═══════════════════════════════════════════════════════
function autoCleanup() {
  const now = Date.now();
  // Evict old IP records (older than 1 hour)
  for (const [ip, record] of ipRequestMap.entries()) {
    if (now - record.firstSeen > 3_600_000) ipRequestMap.delete(ip);
  }
  // Evict old user behavior (older than 6 hours)
  for (const [uid, profile] of userBehaviorMap.entries()) {
    if (now - profile.lastSeen > 6 * 3_600_000) userBehaviorMap.delete(uid);
  }
}

setInterval(autoCleanup, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════
function applyAll(app) {
  app.use(middlewareSecurityHeaders);
  app.use(middlewareIPShield);
  app.use(middlewareAntiCSRF);
  app.use(middlewarePayloadScanner);
  app.use(middlewareSensitiveDataMasker);
  installHoneypots(app);

  // Security stats endpoint (admin only)
  app.get('/api/admin/security-stats', (req, res) => {
    const secret = req.headers['x-admin-secret'];
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({
      bannedIPs: suspiciousIPs.size,
      permanentBlocklist: ipBlocklist.size,
      honeypotHits: honeypotHits.size,
      trackedIPs: ipRequestMap.size,
      recentEvents: securityEvents.slice(0, 50),
      revokedTokens: revokedTokens.size
    });
  });

  console.log('🛡️  [SECURITY] Multi-layer security engine ACTIVE — 8 layers loaded');
}

export default {
  applyAll,
  installHoneypots,
  recordBehavior,
  revokeToken,
  isTokenRevoked,
  generateJTI,
  securityLog,
  getClientIP,
  banIP,
  maskSensitiveFields,
  middlewareIPShield,
  middlewarePayloadScanner,
  middlewareSecurityHeaders,
  middlewareAntiCSRF,
  middlewareSensitiveDataMasker
}
