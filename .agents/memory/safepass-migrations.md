---
name: SafePass schema migrations
description: Supabase columns that must be added manually before admin/dispute/review features work fully.
---

Run in Supabase SQL Editor:

- `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned boolean default false;` — required for ban/unban API
- `ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;` — required for email notifications
- Dispute columns on orders: `dispute_reason`, `dispute_description`, `dispute_opened_by`, `dispute_opened_at`, `dispute_resolved_by`, `dispute_resolved_at`, `dispute_note`
- Reviews table: create with `seller_reply text`, `seller_reply_at timestamptz`

**Why:** Supabase doesn't auto-migrate. Server.js uses these columns — missing columns cause silent nulls or soft errors (update may not fail, just skip).

**How to apply:** See full SQL block in tientrinhethong.md under "Cần Chạy Migration".
