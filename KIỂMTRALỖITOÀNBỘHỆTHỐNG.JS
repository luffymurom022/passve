/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║          KIỂM TRA LỖI TOÀN BỘ HỆ THỐNG — AUTO-FIX              ║
 * ║   Quét toàn bộ file JS, phát hiện lỗi, tự động sửa             ║
 * ║   Chạy tự động khi khởi động server                             ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;

// ═══════════════════════════════════════════════════════
// CẤU HÌNH
// ═══════════════════════════════════════════════════════
const CONFIG = {
  SCAN_EXTENSIONS: ['.js', '.mjs', '.cjs'],
  IGNORE_DIRS: ['node_modules', '.git', '.cache', '.local', 'dist', 'build'],
  IGNORE_FILES: [
    'KIỂMTRALỖITOÀNBỘHỆTHỐNG.JS',   // bỏ qua chính nó
  ],
  AUTO_FIX: true,
  LOG_FILE: path.join(ROOT, '.local', 'system-check.log'),
  MAX_FILE_SIZE_MB: 50,
};

// ═══════════════════════════════════════════════════════
// BỘ GHI LOG
// ═══════════════════════════════════════════════════════
const logs = [];
function log(level, msg) {
  const entry = `[${new Date().toISOString()}] [${level}] ${msg}`;
  logs.push(entry);
  const icon = level === 'ERROR' ? '❌' : level === 'FIX' ? '🔧' : level === 'WARN' ? '⚠️' : '✅';
  console.log(`${icon} ${entry}`);
}

function saveLogs() {
  try {
    const dir = path.dirname(CONFIG.LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG.LOG_FILE, logs.join('\n'), 'utf8');
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════
// THU THẬP FILE
// ═══════════════════════════════════════════════════════
function collectFiles(dir, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!CONFIG.IGNORE_DIRS.includes(entry.name)) {
        collectFiles(fullPath, results);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (
        CONFIG.SCAN_EXTENSIONS.includes(ext) &&
        !CONFIG.IGNORE_FILES.includes(entry.name)
      ) {
        const stat = fs.statSync(fullPath);
        if (stat.size < CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024) {
          results.push(fullPath);
        }
      }
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════
// KIỂM TRA SYNTAX VỚI NODE --CHECK
// ═══════════════════════════════════════════════════════
function checkSyntax(filePath) {
  const result = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
    timeout: 10_000,
  });

  if (result.status !== 0) {
    const errorMsg = (result.stderr || result.stdout || 'Unknown error').trim();
    return { ok: false, error: errorMsg };
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════
// BỘ TỰ ĐỘNG FIX — CÁC LỖI PHỔ BIẾN
// ═══════════════════════════════════════════════════════

const AUTO_FIXES = [
  {
    name: 'Trailing comma in object/array',
    // e.g. { a: 1, } → { a: 1 }
    pattern: /,(\s*[}\]])/g,
    fix: (content) => content.replace(/,(\s*[}\]])/g, '$1'),
  },
  {
    name: 'Semicolon after function/class declaration',
    pattern: /^(}\s*);$/gm,
    fix: (content) => content.replace(/^(}\s*);$/gm, '$1'),
  },
  {
    name: 'console.log left in production (warn only)',
    pattern: /console\.log\(/,
    fix: null, // warn only, don't auto-remove
    warnOnly: true,
  },
  {
    name: 'Missing semicolons on import statements',
    pattern: /^(import\s+.+from\s+['"][^'"]+['"])$/gm,
    fix: (content) =>
      content.replace(/^(import\s+.+from\s+['"][^'"]+['"])$/gm, '$1;'),
  },
  {
    name: 'Double semicolon',
    pattern: /;;/g,
    fix: (content) => content.replace(/;;/g, ';'),
  },
  {
    name: 'Windows line endings (CRLF → LF)',
    pattern: /\r\n/g,
    fix: (content) => content.replace(/\r\n/g, '\n'),
  },
  {
    name: 'BOM character at file start',
    pattern: /^\uFEFF/,
    fix: (content) => content.replace(/^\uFEFF/, ''),
  },
  {
    name: 'Undefined variable: using var (prefer const/let)',
    pattern: /\bvar\s+/g,
    fix: null,
    warnOnly: true,
  },
  {
    name: 'Async function missing await',
    pattern: /async\s+function[^{]+\{[^}]*(?<!\bawait\b)/,
    fix: null,
    warnOnly: true,
  },
];

function applyAutoFixes(filePath, content) {
  let changed = false;
  let current = content;

  for (const rule of AUTO_FIXES) {
    if (rule.warnOnly) {
      if (rule.pattern.test(current)) {
        log('WARN', `  [${path.basename(filePath)}] ${rule.name}`);
        rule.pattern.lastIndex = 0;
      }
      continue;
    }
    if (rule.fix && rule.pattern.test(current)) {
      rule.pattern.lastIndex = 0;
      const fixed = rule.fix(current);
      if (fixed !== current) {
        log('FIX', `  [${path.basename(filePath)}] Applied fix: ${rule.name}`);
        current = fixed;
        changed = true;
      }
    }
  }

  return { content: current, changed };
}

// ═══════════════════════════════════════════════════════
// KIỂM TRA CẤU TRÚC FILE SERVER.JS
// ═══════════════════════════════════════════════════════
const REQUIRED_PATTERNS = {
  'server.js': [
    { pattern: /dotenv\.config\(\)/, name: 'dotenv config' },
    { pattern: /app\.listen\(/, name: 'app.listen()' },
    { pattern: /SUPABASE_URL/, name: 'Supabase URL reference' },
    { pattern: /JWT_SECRET/, name: 'JWT_SECRET reference' },
    { pattern: /express\(\)/, name: 'Express init' },
    { pattern: /app\.use\(express\.json/, name: 'JSON middleware' },
  ],
};

function checkRequiredPatterns(filePath, content) {
  const fileName = path.basename(filePath);
  const rules = REQUIRED_PATTERNS[fileName];
  if (!rules) return [];

  const missing = [];
  for (const rule of rules) {
    if (!rule.pattern.test(content)) {
      missing.push(rule.name);
    }
  }
  return missing;
}

// ═══════════════════════════════════════════════════════
// KIỂM TRA BIẾN MÔI TRƯỜNG THIẾU
// ═══════════════════════════════════════════════════════
const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'JWT_SECRET',
  'RESEND_API_KEY',
];

function checkEnvVars() {
  const missing = REQUIRED_ENV_VARS.filter(k => !process.env[k]);
  return missing;
}

// ═══════════════════════════════════════════════════════
// KIỂM TRA PACKAGE.JSON vs NODE_MODULES
// ═══════════════════════════════════════════════════════
function checkDependencies() {
  const pkgPath = path.join(ROOT, 'package.json');
  const missing = [];

  if (!fs.existsSync(pkgPath)) return missing;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return ['package.json parse error'];
  }

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  for (const dep of Object.keys(allDeps || {})) {
    const depPath = path.join(ROOT, 'node_modules', dep);
    if (!fs.existsSync(depPath)) {
      missing.push(dep);
    }
  }

  return missing;
}

// ═══════════════════════════════════════════════════════
// KIỂM TRA FILE QUAN TRỌNG CÓ TỒN TẠI KHÔNG
// ═══════════════════════════════════════════════════════
const REQUIRED_FILES = [
  'server.js',
  'package.json',
  'frontend/index.html',
];

function checkRequiredFiles() {
  return REQUIRED_FILES.filter(f => !fs.existsSync(path.join(ROOT, f)));
}

// ═══════════════════════════════════════════════════════
// HÀM CHÍNH — CHẠY TOÀN BỘ KIỂM TRA
// ═══════════════════════════════════════════════════════
async function runSystemCheck() {
  const startTime = Date.now();
  log('INFO', '═══════════════════════════════════════════════');
  log('INFO', '   KIỂM TRA LỖI TOÀN BỘ HỆ THỐNG BẮT ĐẦU');
  log('INFO', '═══════════════════════════════════════════════');

  let totalFiles = 0;
  let errorFiles = 0;
  let fixedFiles = 0;
  let warningFiles = 0;

  // 1. Kiểm tra file bắt buộc
  const missingFiles = checkRequiredFiles();
  if (missingFiles.length > 0) {
    log('ERROR', `File bắt buộc bị thiếu: ${missingFiles.join(', ')}`);
  } else {
    log('INFO', 'File bắt buộc: ĐỦ');
  }

  // 2. Kiểm tra dependencies
  const missingDeps = checkDependencies();
  if (missingDeps.length > 0) {
    log('ERROR', `Package chưa cài: ${missingDeps.join(', ')}`);
    if (CONFIG.AUTO_FIX) {
      log('FIX', 'Đang chạy npm install...');
      try {
        execSync('npm install', { cwd: ROOT, stdio: 'pipe', timeout: 60_000 });
        log('INFO', 'npm install hoàn tất');
        fixedFiles++;
      } catch (e) {
        log('ERROR', `npm install thất bại: ${e.message}`);
      }
    }
  } else {
    log('INFO', 'Dependencies: ĐỦ');
  }

  // 3. Kiểm tra biến môi trường
  const missingEnv = checkEnvVars();
  if (missingEnv.length > 0) {
    log('WARN', `Biến môi trường thiếu: ${missingEnv.join(', ')} — Cần thêm vào Secrets`);
    warningFiles++;
  } else {
    log('INFO', 'Biến môi trường: ĐỦ');
  }

  // 4. Quét tất cả file JS
  log('INFO', 'Đang quét toàn bộ file JS...');
  const files = collectFiles(ROOT);
  totalFiles = files.length;
  log('INFO', `Tìm thấy ${totalFiles} file để kiểm tra`);

  const results = { errors: [], fixed: [], warnings: [] };

  for (const filePath of files) {
    const relPath = path.relative(ROOT, filePath);
    let content;

    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      log('ERROR', `Không đọc được ${relPath}: ${e.message}`);
      errorFiles++;
      results.errors.push({ file: relPath, error: e.message });
      continue;
    }

    // Kiểm tra pattern bắt buộc
    const missingPatterns = checkRequiredPatterns(filePath, content);
    if (missingPatterns.length > 0) {
      log('WARN', `[${relPath}] Thiếu các phần quan trọng: ${missingPatterns.join(', ')}`);
      results.warnings.push({ file: relPath, issues: missingPatterns });
      warningFiles++;
    }

    // Áp dụng auto-fix nhỏ
    if (CONFIG.AUTO_FIX) {
      const { content: fixed, changed } = applyAutoFixes(filePath, content);
      if (changed) {
        try {
          fs.writeFileSync(filePath, fixed, 'utf8');
          content = fixed;
          fixedFiles++;
          results.fixed.push(relPath);
        } catch (e) {
          log('ERROR', `Không ghi được ${relPath}: ${e.message}`);
        }
      }
    }

    // Kiểm tra syntax
    const syntax = checkSyntax(filePath);
    if (!syntax.ok) {
      log('ERROR', `[${relPath}] Lỗi syntax:\n    ${syntax.error.split('\n')[0]}`);
      errorFiles++;
      results.errors.push({ file: relPath, error: syntax.error.split('\n')[0] });
    }
  }

  // ── BÁO CÁO TỔNG KẾT ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  log('INFO', '═══════════════════════════════════════════════');
  log('INFO', `   KẾT QUẢ KIỂM TRA (${elapsed}s)`);
  log('INFO', `   Tổng file: ${totalFiles}`);
  log('INFO', `   Lỗi: ${errorFiles}`);
  log('INFO', `   Đã tự fix: ${fixedFiles}`);
  log('INFO', `   Cảnh báo: ${warningFiles}`);
  log(
    errorFiles === 0 ? 'INFO' : 'ERROR',
    errorFiles === 0
      ? '   ✅ HỆ THỐNG SẠCH — KHÔNG CÓ LỖI'
      : `   ❌ ${errorFiles} LỖI CẦN XỬ LÝ THỦ CÔNG`
  );
  log('INFO', '═══════════════════════════════════════════════');

  saveLogs();
  return { totalFiles, errorFiles, fixedFiles, warningFiles, results };
}

// ═══════════════════════════════════════════════════════
// AUTO-RUN KHI FILE NÀY ĐƯỢC IMPORT HOẶC CHẠY TRỰC TIẾP
// ═══════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  // Chạy trực tiếp: node KIỂMTRALỖITOÀNBỘHỆTHỐNG.JS
  runSystemCheck().then(r => {
    process.exit(r.errorFiles > 0 ? 1 : 0);
  });
} else {
  // Import từ server.js → auto-run không chặn
  runSystemCheck().catch(e => console.error('System check error:', e));
}

export default { runSystemCheck };
