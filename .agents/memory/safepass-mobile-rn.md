---
name: SafePass React Native Mobile Architecture
description: Expo SDK 52 mobile app in mobile/ subdirectory; workflow "Start Mobile" on port 8080; reuses SafePass backend APIs.
---

## Structure

```
mobile/
├── app.json              — Expo config, bundleId com.safepass.mobile
├── babel.config.js       — babel-preset-expo + reanimated plugin
├── package.json          — Expo SDK 52 (react 18.3.1, RN 0.76.9)
├── app/
│   ├── _layout.tsx       — Root: GestureHandler + SafeArea + QueryClient + Auth + Keyboard + PushNotif
│   ├── index.tsx         — Redirect: loading → (auth)/login or (tabs)
│   ├── +not-found.tsx
│   ├── (auth)/
│   │   ├── _layout.tsx
│   │   ├── login.tsx     — POST /api/auth/login
│   │   └── register.tsx  — POST /api/auth/register
│   ├── (tabs)/
│   │   ├── _layout.tsx   — 5-tab bar (home/reels/messenger/notifications/profile)
│   │   ├── index.tsx     — GET /api/tickets
│   │   ├── reels.tsx     — GET /api/social/reels
│   │   ├── messenger.tsx — GET /api/dm/conversations
│   │   ├── notifications.tsx — GET /api/notifications
│   │   └── profile.tsx   — useAuth user + logout
│   └── chat/[id].tsx     — GET/POST /api/dm/conversations/:id/messages
├── components/
│   ├── ErrorBoundary.tsx
│   └── PushNotifications.tsx — expo-notifications + POST /api/users/push-token
├── constants/colors.ts   — Dark theme: primary #FF6B35, bg #0D0D0D, card #1A1A1A
├── context/AuthContext.tsx — JWT stored in expo-secure-store (native) / localStorage (web)
├── hooks/useColors.ts
└── lib/query-client.ts   — apiRequest() with Bearer token; getApiUrl() reads EXPO_PUBLIC_API_URL
```

## Workflow

- Name: "Start Mobile"
- Command: `cd mobile && EXPO_PUBLIC_API_URL=https://$REPLIT_DEV_DOMAIN npx expo start --web --port 8080 --non-interactive`
- Port: 8080 (console output type)
- Backend API: port 5000 (Start application workflow)

## Key decisions

**Why SDK 52 versions with expo@53 installed:**
- expo@53.0.x installs but warns about peer dep mismatches (react@18→19, rn@0.76→0.79)
- The app runs with Expo SDK 52 versions (react@18.3.1, react-native@0.76.9) — version warnings appear but do not break the web bundle
- To fully upgrade to SDK 53: change react to 19.0.0, react-native to 0.79.6, all expo-* to ~expected versions

**Token storage:**
- Native: expo-secure-store (SecureStore.getItemAsync/setItemAsync)
- Web fallback: localStorage with key 'sp_token'
- Auth middleware reads token on every apiRequest

**API URL config:**
- Set via EXPO_PUBLIC_API_URL env var at workflow start
- Injected as `https://$REPLIT_DEV_DOMAIN` (Replit public URL)
- lib/query-client.ts → getApiUrl() → used by all apiRequest() calls

**Push notifications:**
- PushNotificationProvider wraps app in _layout.tsx
- Registers token on mount → POST /api/users/push-token
- Handles notification tap → router.push() to relevant route
- Android channel: 'default', color: #FF6B35

**SQL required:**
- `ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token text;` in Supabase SQL Editor
- `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;` (if not already present)

**KIỂMTRALỖITOÀNBỘHỆTHỐNG.js auto-linter:**
- This system scans all .js files in the root; it auto-fixed mobile/babel.config.js
- Do NOT place JS config files for mobile in the project root — auto-linter will modify them
- babel.config.js in mobile/ is safe (scanned but only lightly fixed — trailing comma issue)
