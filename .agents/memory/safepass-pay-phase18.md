---
name: SafePass Pay Phase 18
description: Phase 18 — wallet/payment system; requires pay_migration.sql; 6 new tables; full P2P transfer + SafeCoin
---

# Phase 18: SafePass Pay

**Why:** Full digital wallet system enabling P2P transfers, escrow funding, SafeCoin rewards, deposit/withdrawal with bank transfer.

## ⚠️ SQL Migration Required
Run `pay_migration.sql` in Supabase SQL Editor before using. Creates 6 tables:
- `wallets` — balance, frozen_balance, safecoin, limits, tier, daily/monthly spend
- `wallet_transactions` — full audit log (12 types)
- `payment_requests` — P2P payment requests with 24h expiry
- `safecoin_ledger` — earn/spend history
- `deposit_requests` — bank transfer top-up with bank_ref
- `withdrawal_requests` — bank withdrawal with admin approval flow

## Key Design Decisions
- **Balance stored as bigint in VND** (no float to avoid rounding) — 1₫ = 1 unit
- **`getOrCreateWallet(userId)`** helper auto-creates wallet on first access — no explicit wallet creation step needed
- **SafeCoin rate: 1 coin = 100₫** for redemption
- **Deposit flow**: create pending deposit_request → admin confirms via `/api/admin/pay/deposits/:id/confirm` → balance credited
- **Withdrawal flow**: freeze balance → admin processes → unfreezes on reject, stays frozen on complete
- **Transfer**: atomic debit + credit in same request; both sides recorded; 5 SafeCoin awarded to sender
- **Payment request**: 24h expiry; pay = instant transfer; both can cancel while pending

## Transaction Types (wallet_transactions.type)
deposit, withdrawal, transfer_in, transfer_out, escrow_hold, escrow_release, escrow_refund, safecoin_earn, safecoin_redeem, fee, cashback, refund, adjustment

## API Routes (before Phase 17 block in server.js)
- `GET /pay` — serve frontend/pay.html
- `GET /api/pay/wallet` — wallet + monthly chart data (auto-creates wallet)
- `GET /api/pay/transactions?limit=&type=` — transaction history
- `POST /api/pay/deposit` — create deposit request
- `POST /api/pay/withdraw` — create withdrawal request
- `POST /api/pay/transfer` — P2P transfer by phone
- `GET /api/pay/requests` — received + sent payment requests
- `POST /api/pay/requests` — create payment request
- `POST /api/pay/requests/:id/pay` — pay a request
- `POST /api/pay/requests/:id/cancel` — cancel a request
- `POST /api/pay/safecoin/redeem` — convert coins to balance
- `GET /api/admin/pay/deposits` — admin list deposits
- `POST /api/admin/pay/deposits/:id/confirm` — admin confirm deposit
- `GET /api/admin/pay/withdrawals` — admin list withdrawals
- `POST /api/admin/pay/withdrawals/:id/process` — admin approve/reject withdrawal

## Frontend (frontend/pay.html at /pay)
4-tab bottom nav (mobile-first, max-width 480px):
1. **💳 Ví** — gradient hero card (toggle hide balance), 4 quick actions, stats, limit bars, recent txns, Chart.js 6m bar chart
2. **📋 Lịch sử** — filter chips (6 types), full transaction list
3. **📨 Yêu cầu** — received requests (pay/decline), sent requests (cancel), create modal
4. **🪙 SafeCoin** — coin balance, redeem to cash, 5 earn methods, coin history

**How to apply:** Run pay_migration.sql first. Then navigate to /pay. Wallet auto-creates on first API call.
