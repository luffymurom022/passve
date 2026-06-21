---
name: SafePass Social Phase 3
description: Phase 3 social build — Groups, Reels, Messenger. Routes, frontend pages, WebSocket.
---

# SafePass Phase 3 — Social Layer

## What was built
- `frontend/groups.html` — Facebook-style groups (Khám phá, Nhóm của tôi, Lời mời, Group Detail with Discussion/Marketplace/Members/Rules tabs)
- `frontend/reels.html` — TikTok-style vertical reels feed (snap scroll, like/save/share/comment, follow, upload)
- `frontend/messenger.html` — Facebook Messenger DM chat (conversations list, real-time WebSocket /ws/dm, reactions, typing indicator)
- `social_phase3_migration.sql` — Must be run in Supabase before DM/group-posts features work

## Critical constraint
The catch-all `app.get('*', ...)` route MUST be the very last GET route in server.js. It was originally at line ~4242 (before all named routes), which caused all specific routes to be unreachable. Fix: removed from old position, added just before `const PORT = ...` at the end.

**Why:** Express matches routes in registration order. Any catch-all before named routes silently swallows all requests.

## New tables (need Supabase migration)
- `dm_conversations`, `dm_participants`, `dm_messages`, `dm_message_reactions`
- `sn_group_posts`, `sn_group_post_likes`, `sn_group_post_comments`
- `sn_group_rules`, `sn_group_invites`, `social_saved`

## New WebSocket
- `wss3` = DM WebSocket at `/ws/dm` (alongside wss=order-chat, wss2=escrow)
- `dmSockets` Map + `onlineUsers` Set are in-memory in server.js

## New API routes
- GET/POST `/api/sn/groups/:id/posts` — group discussion posts
- GET/POST `/api/sn/groups/:id/members` — member list + role management
- GET/POST/DELETE `/api/sn/groups/:id/rules` — group rules
- POST `/api/sn/groups/:id/invite` + accept/decline — invitations
- GET `/api/social/reels` — smart recommendation feed
- POST `/api/social/videos/:id/save` — bookmark reel
- POST `/api/social/videos/:id/share` — share count
- GET/POST `/api/dm/conversations` — DM conversation list + create
- GET/POST `/api/dm/conversations/:id/messages` — messages
- POST `/api/dm/messages/:id/react` — emoji reactions
- DELETE `/api/dm/messages/:id` — recall message
