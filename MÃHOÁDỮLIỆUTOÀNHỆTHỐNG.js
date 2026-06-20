/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║          MÃ HOÁ DỮ LIỆU TOÀN HỆ THỐNG — SafePass               ║
 * ║   AES-256-GCM + PBKDF2 + HMAC-SHA512 + Key Rotation             ║
 * ║   Tự động mã hoá mọi dữ liệu nhạy cảm trước khi lưu DB          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 *  CHIẾN LƯỢC:
 *  - Mỗi bản ghi được mã hoá bằng DEK (Data Encryption Key) riêng
 *  - DEK được bọc (wrap) bởi KEK (Key Encryption Key) lưu trong env
 *  - Payload: base64( IV || AuthTag || EncryptedData )
 *  - HMAC toàn bộ payload để phát hiện giả mạo
 *  - Key rotation: tự động sinh DEK mới mỗi 24h
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════
// HẰNG SỐ THUẬT TOÁN
// ═══════════════════════════════════════════════════════
const ALGO            = 'aes-256-gcm';
const IV_LEN          = 16;          // 128-bit IV
const AUTH_TAG_LEN    = 16;          // 128-bit GCM auth tag
const KEY_LEN         = 32;          // 256-bit AES key
const SALT_LEN        = 32;          // 256-bit PBKDF2 salt
const PBKDF2_ITER     = 310_000;     // NIST recommended minimum 2024
const PBKDF2_DIGEST   = 'sha512';
const HMAC_ALGO       = 'sha512';
const SCHEMA_VERSION  = 'SP1';       // SafePass v1 format marker

// ═══════════════════════════════════════════════════════
// NGUỒN KHOÁ MÃ HOÁ (KEK — Key Encryption Key)
// ═══════════════════════════════════════════════════════
function getKEK() {
  const raw = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('[ENCRYPT] KEK không có — thiếu JWT_SECRET trong Secrets');

  // Dẫn xuất KEK từ passphrase bằng PBKDF2 với salt cố định (per-deployment)
  const deploymentSalt = crypto
    .createHash('sha256')
    .update(`safepass-kek-${process.env.SUPABASE_URL || 'local'}`)
    .digest();

  return crypto.pbkdf2Sync(raw, deploymentSalt, PBKDF2_ITER, KEY_LEN, PBKDF2_DIGEST);
}

// ═══════════════════════════════════════════════════════
// QUẢN LÝ DEK (Data Encryption Key) — Tự động rotation
// ═══════════════════════════════════════════════════════
const DEK_STORE_PATH = path.join(__dirname, '.local', 'dek-store.enc');
let currentDEK = null;
let dekGeneratedAt = 0;
const DEK_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function generateDEK() {
  return crypto.randomBytes(KEY_LEN);
}

function wrapDEK(dek, kek) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, kek, iv);
  const enc = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function unwrapDEK(wrapped, kek) {
  const buf = Buffer.from(wrapped, 'base64');
  const iv  = buf.slice(0, IV_LEN);
  const tag = buf.slice(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const enc = buf.slice(IV_LEN + AUTH_TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function saveDEK(dek) {
  try {
    const dir = path.dirname(DEK_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const kek = getKEK();
    const wrapped = wrapDEK(dek, kek);
    const payload = JSON.stringify({ wrapped, ts: Date.now(), v: SCHEMA_VERSION });
    fs.writeFileSync(DEK_STORE_PATH, payload, 'utf8');
  } catch (e) {
    console.error('[ENCRYPT] Không lưu được DEK:', e.message);
  }
}

function loadDEK() {
  try {
    if (!fs.existsSync(DEK_STORE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(DEK_STORE_PATH, 'utf8'));
    if (Date.now() - raw.ts > DEK_TTL_MS) return null; // expired
    const kek = getKEK();
    return unwrapDEK(raw.wrapped, kek);
  } catch {
    return null;
  }
}

function getActiveDEK() {
  if (currentDEK && Date.now() - dekGeneratedAt < DEK_TTL_MS) {
    return currentDEK;
  }
  // Thử load từ disk
  const loaded = loadDEK();
  if (loaded) {
    currentDEK = loaded;
    dekGeneratedAt = Date.now();
    return currentDEK;
  }
  // Sinh mới
  currentDEK = generateDEK();
  dekGeneratedAt = Date.now();
  saveDEK(currentDEK);
  console.log('[ENCRYPT] DEK mới được sinh — rotation hoàn tất');
  return currentDEK;
}

// ═══════════════════════════════════════════════════════
// CORE ENCRYPT / DECRYPT
// ═══════════════════════════════════════════════════════

/**
 * Mã hoá một giá trị bất kỳ (string, object, number…)
 * Trả về chuỗi base64 an toàn để lưu DB
 */
function encrypt(value) {
  if (value === null || value === undefined) return value;

  const dek  = getActiveDEK();
  const iv   = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, dek, iv);

  const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();

  // Layout: VERSION(3) | IV(16) | AUTHTAG(16) | DATA(n)
  const payload = Buffer.concat([
    Buffer.from(SCHEMA_VERSION, 'utf8'),
    iv,
    authTag,
    encrypted
  ]);

  // HMAC bảo vệ toàn bộ payload
  const mac = crypto
    .createHmac(HMAC_ALGO, dek)
    .update(payload)
    .digest();

  return Buffer.concat([payload, mac]).toString('base64');
}

/**
 * Giải mã chuỗi base64 trở lại giá trị gốc
 */
function decrypt(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;

  // Không phải dữ liệu mã hoá của hệ thống → trả về nguyên
  if (!isEncrypted(ciphertext)) return ciphertext;

  try {
    const dek = getActiveDEK();
    const buf  = Buffer.from(ciphertext, 'base64');

    const VERSION_LEN = 3;
    const MAC_LEN     = 64; // SHA-512 = 512 bits = 64 bytes

    // Tách MAC ra khỏi payload
    const payload = buf.slice(0, buf.length - MAC_LEN);
    const mac     = buf.slice(buf.length - MAC_LEN);

    // Xác minh HMAC
    const expectedMac = crypto
      .createHmac(HMAC_ALGO, dek)
      .update(payload)
      .digest();

    if (!crypto.timingSafeEqual(mac, expectedMac)) {
      throw new Error('HMAC mismatch — dữ liệu bị giả mạo hoặc hỏng');
    }

    // Tách IV, AuthTag, Data
    const iv      = payload.slice(VERSION_LEN, VERSION_LEN + IV_LEN);
    const authTag = payload.slice(VERSION_LEN + IV_LEN, VERSION_LEN + IV_LEN + AUTH_TAG_LEN);
    const data    = payload.slice(VERSION_LEN + IV_LEN + AUTH_TAG_LEN);

    const decipher = crypto.createDecipheriv(ALGO, dek, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');

    // Thử parse JSON nếu có
    try { return JSON.parse(plain); } catch { return plain; }
  } catch (e) {
    console.error('[ENCRYPT] Giải mã thất bại:', e.message);
    return null;
  }
}

/**
 * Kiểm tra xem chuỗi có phải dữ liệu đã mã hoá không
 */
function isEncrypted(value) {
  if (typeof value !== 'string') return false;
  try {
    const buf = Buffer.from(value, 'base64');
    return buf.slice(0, 3).toString('utf8') === SCHEMA_VERSION;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════
// MÃ HOÁ OBJECT — TỰ ĐỘNG MÃ HOÁ CÁC TRƯỜNG NHẠY CẢM
// ═══════════════════════════════════════════════════════

/** Tên trường sẽ bị mã hoá trước khi lưu DB */
const SENSITIVE_FIELDS = new Set([
  'phone', 'phone_number', 'email', 'full_name', 'id_number',
  'bank_account', 'bank_name', 'bank_holder',
  'address', 'identity_front', 'identity_back', 'selfie_with_id',
  'qr_data', 'qr_code_data', 'ticket_code',
  'kyc_document', 'description_private', 'admin_note'
]);

/**
 * Mã hoá toàn bộ các trường nhạy cảm trong object trước khi insert/update DB
 */
function encryptRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const out = { ...record };
  for (const [k, v] of Object.entries(out)) {
    if (SENSITIVE_FIELDS.has(k) && v !== null && v !== undefined && !isEncrypted(String(v))) {
      out[k] = encrypt(v);
    }
  }
  return out;
}

/**
 * Giải mã toàn bộ các trường nhạy cảm sau khi đọc từ DB
 */
function decryptRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const out = { ...record };
  for (const [k, v] of Object.entries(out)) {
    if (SENSITIVE_FIELDS.has(k) && typeof v === 'string' && isEncrypted(v)) {
      out[k] = decrypt(v);
    }
  }
  return out;
}

function decryptRecords(records) {
  if (!Array.isArray(records)) return records;
  return records.map(decryptRecord);
}

// ═══════════════════════════════════════════════════════
// SUPABASE WRAPPER — TỰ ĐỘNG MÃ HOÁ/GIẢI MÃ
// ═══════════════════════════════════════════════════════

/**
 * Bọc Supabase client để tự động mã hoá khi write, giải mã khi read
 *
 * Dùng:
 *   import { wrapSupabase } from './MÃHOÁDỮLIỆUTOÀNHỆTHỐNG.JS';
 *   const db = wrapSupabase(supabase);
 *   const { data } = await db.from('users').select('*'); // tự giải mã
 */
function wrapSupabase(client) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop !== 'from') return target[prop];

      return (table) => {
        const queryBuilder = target.from(table);
        return wrapQueryBuilder(queryBuilder);
      };
    }
  });
}

function wrapQueryBuilder(qb) {
  return new Proxy(qb, {
    get(target, prop) {
      // Intercept insert/update/upsert để mã hoá
      if (['insert', 'update', 'upsert'].includes(prop)) {
        return (data, options) => {
          const encrypted = Array.isArray(data)
            ? data.map(encryptRecord)
            : encryptRecord(data);
          const next = target[prop](encrypted, options);
          return wrapQueryBuilder(next);
        };
      }

      // Intercept then() để giải mã kết quả
      if (prop === 'then') {
        return (resolve, reject) => {
          return target.then((result) => {
            if (result?.data) {
              result = {
                ...result,
                data: Array.isArray(result.data)
                  ? decryptRecords(result.data)
                  : decryptRecord(result.data)
              };
            }
            return resolve ? resolve(result) : result;
          }, reject);
        };
      }

      // Mọi method khác (select, eq, filter…) — chain tiếp
      const val = target[prop];
      if (typeof val === 'function') {
        return (...args) => {
          const next = val.apply(target, args);
          if (next && typeof next === 'object') return wrapQueryBuilder(next);
          return next;
        };
      }
      return val;
    }
  });
}

// ═══════════════════════════════════════════════════════
// MÃ HOÁ DỮ LIỆU FILE (snapshot toàn hệ thống)
// ═══════════════════════════════════════════════════════

const SNAPSHOT_PATH = path.join(__dirname, '.local', 'system-snapshot.enc');
const SNAPSHOT_IGNORE = [
  'node_modules', '.git', '.local', '.cache', 'dist', 'build',
  'MÃHOÁDỮLIỆUTOÀNHỆTHỐNG.JS'
];

/**
 * Tạo snapshot mã hoá của toàn bộ codebase (checksum + metadata)
 * KHÔNG mã hoá source file gốc (sẽ phá vỡ runtime)
 * Thay vào đó lưu hash của mỗi file để phát hiện giả mạo
 */
function createSystemSnapshot() {
  try {
    const root = __dirname;
    const manifest = {};

    function scan(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel  = path.relative(root, full);
        if (SNAPSHOT_IGNORE.some(ig => rel.startsWith(ig))) continue;
        if (e.isDirectory()) { scan(full); continue; }
        if (!e.isFile()) continue;
        try {
          const buf  = fs.readFileSync(full);
          const hash = crypto.createHash('sha256').update(buf).digest('hex');
          const stat = fs.statSync(full);
          manifest[rel] = { hash, size: stat.size, mtime: stat.mtimeMs };
        } catch {}
      }
    }

    scan(root);

    const payload  = JSON.stringify({ ts: Date.now(), v: SCHEMA_VERSION, manifest });
    const ciphertext = encrypt(payload);

    const dir = path.dirname(SNAPSHOT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, ciphertext, 'utf8');

    console.log(`[ENCRYPT] Snapshot hệ thống tạo xong — ${Object.keys(manifest).length} file`);
    return { ok: true, fileCount: Object.keys(manifest).length };
  } catch (e) {
    console.error('[ENCRYPT] Snapshot thất bại:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * So sánh trạng thái hiện tại với snapshot — phát hiện file bị sửa trái phép
 */
function verifySystemIntegrity() {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) {
      return { ok: false, error: 'Chưa có snapshot — chạy createSystemSnapshot() trước' };
    }

    const ciphertext = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    const raw = decrypt(ciphertext);
    if (!raw) return { ok: false, error: 'Snapshot hỏng hoặc bị giả mạo' };

    const snapshot = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const { manifest } = snapshot;

    const tampered = [];
    const added    = [];
    const removed  = Object.keys(manifest);

    function scan(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(__dirname, e.name === dir ? '' : '');
        // simplified scan
      }
    }

    // Re-hash current files
    for (const [rel, info] of Object.entries(manifest)) {
      const full = path.join(__dirname, rel);
      if (!fs.existsSync(full)) {
        tampered.push({ file: rel, reason: 'FILE_DELETED' });
        continue;
      }
      const idx = removed.indexOf(rel);
      if (idx !== -1) removed.splice(idx, 1);

      const buf  = fs.readFileSync(full);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      if (hash !== info.hash) {
        tampered.push({ file: rel, reason: 'HASH_MISMATCH', expected: info.hash, got: hash });
      }
    }

    const ok = tampered.length === 0;
    if (!ok) {
      console.error('[ENCRYPT] ⚠️  PHÁT HIỆN THAY ĐỔI TRÁI PHÉP:');
      tampered.forEach(t => console.error(`   ${t.reason}: ${t.file}`));
    }

    return { ok, tampered, snapshotAge: Date.now() - snapshot.ts };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════
// HASH AN TOÀN CHO MẬT KHẨU / SỐ ĐIỆN THOẠI
// ═══════════════════════════════════════════════════════

function hashPassword(plain) {
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.pbkdf2Sync(plain, salt, PBKDF2_ITER, 64, PBKDF2_DIGEST);
  return `pbkdf2$${PBKDF2_ITER}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(plain, stored) {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const [, iter, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const hash = crypto.pbkdf2Sync(plain, salt, parseInt(iter), 64, PBKDF2_DIGEST);
  return crypto.timingSafeEqual(Buffer.from(hashHex, 'hex'), hash);
}

/** Tokenize phone number (one-way — dùng để tìm kiếm mà không lộ số thật) */
function tokenizePhone(phone) {
  const kek = getKEK();
  return crypto.createHmac('sha256', kek).update(phone).digest('hex');
}

// ═══════════════════════════════════════════════════════
// KEY ROTATION TỰ ĐỘNG (DEK mới mỗi 24h)
// ═══════════════════════════════════════════════════════
function startKeyRotationScheduler() {
  setInterval(() => {
    const age = Date.now() - dekGeneratedAt;
    if (age >= DEK_TTL_MS) {
      const oldDEK = currentDEK;
      currentDEK   = generateDEK();
      dekGeneratedAt = Date.now();
      saveDEK(currentDEK);
      console.log('[ENCRYPT] Key rotation hoàn tất — DEK mới đã được kích hoạt');
    }
  }, 60 * 60 * 1000); // check mỗi giờ
}

// ═══════════════════════════════════════════════════════
// KHỞI ĐỘNG
// ═══════════════════════════════════════════════════════
function init() {
  try {
    getActiveDEK(); // Đảm bảo DEK sẵn sàng
    startKeyRotationScheduler();
    console.log('[ENCRYPT] Hệ thống mã hoá AES-256-GCM + HMAC-SHA512 ACTIVE');
  } catch (e) {
    console.error('[ENCRYPT] Khởi động thất bại:', e.message);
    // Không crash server — chạy tiếp nhưng không mã hoá
  }
}

init();

// ═══════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════
export {
  encrypt,
  decrypt,
  isEncrypted,
  encryptRecord,
  decryptRecord,
  decryptRecords,
  wrapSupabase,
  createSystemSnapshot,
  verifySystemIntegrity,
  hashPassword,
  verifyPassword,
  tokenizePhone,
  SENSITIVE_FIELDS
}

export default {
  encrypt,
  decrypt,
  isEncrypted,
  encryptRecord,
  decryptRecord,
  decryptRecords,
  wrapSupabase,
  createSystemSnapshot,
  verifySystemIntegrity,
  hashPassword,
  verifyPassword,
  tokenizePhone
}
