#!/usr/bin/env node
/**
 * SafePass — Auto Tick Script
 * ─────────────────────────────────────────────────────────────────
 * Cách dùng:
 *
 *   npm run tick "keyword"
 *     → Tìm TẤT CẢ dòng checkbox [ ] chứa keyword và đánh dấu [x] + ngày hôm nay
 *
 *   npm run tick:add "Tên Section" "Mô tả chức năng đã build xong"
 *     → Thêm dòng MỚI [x] vào đúng section trong file
 *
 *   npm run tick:new "🎯 Tên Section Mới" "Chức năng 1" "Chức năng 2"
 *     → Tạo section mới hoàn toàn trong phần TỔNG KẾT
 *
 *   npm run tick:all
 *     → Đánh dấu TẤT CẢ checkbox [ ] thành [x] + ngày hôm nay (bỏ qua 🔒)
 *
 *   npm run tick:list
 *     → Liệt kê tất cả mục [ ] chưa build
 * ─────────────────────────────────────────────────────────────────
 */

import fs from 'fs';

const FILE = 'tientrinhethong.md';
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function readFile() {
  if (!fs.existsSync(FILE)) {
    console.error(`❌ Không tìm thấy file ${FILE}`);
    process.exit(1);
  }
  return fs.readFileSync(FILE, 'utf8');
}

function writeFile(content) {
  fs.writeFileSync(FILE, content, 'utf8');
}

function updateTimestamp(content) {
  return content
    .replace(
      /> Cập nhật lần cuối:.*$/m,
      `> Cập nhật lần cuối: **${today}** — Tự động cập nhật sau mỗi lần build xong`
    )
    .replace(
      /^\*Cập nhật lần cuối:.*\*$/m,
      `*Cập nhật lần cuối: ${today}*`
    );
}

// Chỉ nhận dòng checkbox thực sự:
//   - [ ] text...        (list item)
//   | ... | `[ ]` |      (table cell với backtick)
//   | ... | [ ] |        (table cell không backtick)
function isRealCheckbox(line) {
  return (
    /^- \[ \]/.test(line) ||            // - [ ] item
    /^\| .+\| `\[ \]/.test(line) ||     // | col | `[ ]`
    /^\| .+\| \[ \] /.test(line) ||     // | col | [ ] text
    /^\| .+\| \[ \]$/.test(line)        // | col | [ ] (end of line)
  );
}

// ── LỆNH: tick "keyword" ──────────────────────────────────────────
function tickKeyword(keyword) {
  let content = readFile();
  const lines = content.split('\n');
  let count = 0;

  const updated = lines.map(line => {
    if (!isRealCheckbox(line)) return line;
    if (!line.toLowerCase().includes(keyword.toLowerCase())) return line;
    count++;
    const hasDate = /\d{4}-\d{2}-\d{2}/.test(line);
    return hasDate
      ? line.replace(/\[ \]/, '[x]')
      : line.replace(/\[ \]/, `[x]`) + ` *(${today})*`;
  });

  if (count === 0) {
    console.log(`⚠️  Không tìm thấy checkbox [ ] nào chứa: "${keyword}"`);
    console.log(`   Dùng "npm run tick:list" để xem tất cả mục chưa build.`);
    return;
  }

  let out = updated.join('\n');
  out = updateTimestamp(out);
  writeFile(out);
  console.log(`✅ Đã tick ${count} mục chứa "${keyword}" — ngày ${today}`);
}

// ── LỆNH: tick:add "Section" "Feature" ───────────────────────────
function tickAdd(sectionName, featureText) {
  let content = readFile();
  const lines = content.split('\n');
  let insertIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (
      (lines[i].startsWith('### ') || lines[i].startsWith('## ')) &&
      lines[i].toLowerCase().includes(sectionName.toLowerCase())
    ) {
      // Tìm cuối bảng trong section
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.startsWith('### ') || l.startsWith('## ') || l === '---') {
          insertIdx = j;
          break;
        }
        if (l.startsWith('> ') && !lines[j - 1].startsWith('|')) {
          insertIdx = j;
          break;
        }
      }
      if (insertIdx === -1) insertIdx = i + 1;
      break;
    }
  }

  if (insertIdx === -1) {
    console.log(`⚠️  Không tìm thấy section: "${sectionName}"`);
    console.log(`   Dùng "npm run tick:new" để tạo section mới.`);
    return;
  }

  const newRow = `| ${featureText} | ${today} |`;
  lines.splice(insertIdx, 0, newRow);
  let out = lines.join('\n');
  out = updateTimestamp(out);
  writeFile(out);
  console.log(`✅ Đã thêm vào section "${sectionName}": ${featureText} — ${today}`);
}

// ── LỆNH: tick:new "Section" "Feature1" "Feature2" ... ───────────
function tickNew(sectionName, features) {
  let content = readFile();

  const insertMarker = '### 🤝 Referral & Hoa Hồng *(HOÀN THÀNH)*';
  const fallbackMarker = '### 🏗️ Hạ Tầng & Cấu Hình';

  const rows = features.map(f => `| ${f} | ${today} |`).join('\n');
  const newSection = `### ${sectionName} *(HOÀN THÀNH)*\n| Chức năng | Ngày hoàn thành |\n|---|---|\n${rows}\n\n`;

  const pos = content.indexOf(insertMarker);
  if (pos !== -1) {
    content = content.slice(0, pos) + newSection + content.slice(pos);
  } else {
    const fb = content.indexOf(fallbackMarker);
    content = fb !== -1
      ? content.slice(0, fb) + newSection + content.slice(fb)
      : content + '\n' + newSection;
  }

  content = updateTimestamp(content);
  writeFile(content);
  console.log(`✅ Đã tạo section mới: "${sectionName}" với ${features.length} chức năng — ${today}`);
}

// ── LỆNH: tick:all ────────────────────────────────────────────────
function tickAll() {
  let content = readFile();
  const lines = content.split('\n');
  let count = 0;

  const updated = lines.map(line => {
    if (!isRealCheckbox(line)) return line;
    if (line.includes('🔒')) return line; // bỏ qua mục cần API key
    count++;
    const hasDate = /\d{4}-\d{2}-\d{2}/.test(line);
    return hasDate
      ? line.replace(/\[ \]/, '[x]')
      : line.replace(/\[ \]/, '[x]') + ` *(${today})*`;
  });

  let out = updated.join('\n');
  out = updateTimestamp(out);
  writeFile(out);
  console.log(`✅ Đã tick ${count} mục [ ] (bỏ qua 🔒) — ngày ${today}`);
}

// ── LỆNH: tick:list ───────────────────────────────────────────────
function tickList() {
  const content = readFile();
  const lines = content.split('\n');

  const pending = lines
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter(({ text }) => isRealCheckbox(text));

  if (pending.length === 0) {
    console.log('🎉 Tất cả mục đã hoàn thành! Không có [ ] nào còn lại.');
    return;
  }

  console.log(`📋 CÒN ${pending.length} MỤC CHƯA BUILD:\n`);
  pending.forEach(({ line, text }) => {
    const isLocked = text.includes('🔒');
    const clean = text.replace(/^-\s*\[ \]/, '').replace(/^\|.*\|.*\[ \].*\|/, '').trim();
    console.log(`  ${isLocked ? '🔒' : '⬜'} [dòng ${line}] ${clean || text}`);
  });
}

// ── MAIN ──────────────────────────────────────────────────────────
const [,, cmd, ...args] = process.argv;

if (!cmd) {
  console.log(`
SafePass Tick Script — Cách dùng:

  npm run tick "keyword"               Tick [ ] chứa keyword → [x] + ngày
  npm run tick:add "Section" "Mô tả"  Thêm dòng [x] mới vào section có sẵn
  npm run tick:new "Section" "F1" …   Tạo section mới với các chức năng
  npm run tick:all                     Tick TẤT CẢ [ ] (bỏ qua 🔒)
  npm run tick:list                    Liệt kê các [ ] chưa build
`);
  process.exit(0);
}

switch (cmd) {
  case 'list': tickList(); break;
  case 'all':  tickAll();  break;
  case 'add':
    if (args.length < 2) { console.error('❌ Cú pháp: npm run tick:add "Tên Section" "Mô tả"'); process.exit(1); }
    tickAdd(args[0], args[1]);
    break;
  case 'new':
    if (args.length < 2) { console.error('❌ Cú pháp: npm run tick:new "Tên Section" "Chức năng 1"'); process.exit(1); }
    tickNew(args[0], args.slice(1));
    break;
  default:
    tickKeyword(cmd);
}
