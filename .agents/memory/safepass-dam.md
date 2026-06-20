---
name: SafePass DAM Phase 6
description: Phase 6 Digital Asset Marketplace — architecture decisions and gotchas for dam.html + /api/dam/* routes
---

## Key decisions

**Encryption function names**: The project uses `encryptField(text)` and `decryptField(stored)` (defined at line ~3473 in server.js), NOT `encryptData`/`decryptData`. Using wrong names causes silent null returns.

**Frontend init() pattern**: dam.html must call `renderApp()` BEFORE any async API call. When Supabase secrets are missing, `/api/me` hangs with no response (never resolves), so awaiting it first causes infinite spinner. Fix: call `renderApp()` + `loadBrowse()` first, then use `Promise.race([api('me'), timeout(4000)])` for user auth.

**Standalone system**: DAM is completely separate from existing `digital_listings`/`asset_inventory`/`digital_orders` tables (Phase 4 digital accounts). New tables all prefixed `dam_`. Nav entry `{id:"dam",icon:"🏪",label:"Tài Sản Số"}` in index.html redirects to `/dam.html` (same pattern as `open_escrow` → `/escrow.html`).

**Admin hook**: switchTab in admin.html uses a switch statement (line ~1464). Add `case 'dam-admin': loadDamAdmin(); break;` to wire the tab.

**Migration file**: `dam_migration.sql` — must be run in Supabase SQL Editor before DAM features work.

**Why:**
- Keeping DAM isolated prevents escrow/marketplace bugs from leaking across systems.
- The spinner freeze was caused by missing Supabase secrets making HTTP requests hang rather than fail fast.
