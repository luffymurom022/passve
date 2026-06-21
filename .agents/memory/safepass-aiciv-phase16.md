---
name: SafePass AI Civilization Engine Phase 16 (Social)
description: Phase 16 of the social series — AI Civilization Engine with 20 modules, 9 Supabase tables, /aiciv page, 15 API routes.
---

# SafePass AI Civilization Engine — Phase 16 Social

## Key facts
- **URL:** `/aiciv` → `frontend/aiciv.html`
- **Migration:** `aiciv_migration.sql` — must be run in Supabase SQL Editor before real data appears
- **Nav entry:** `{id:"ai_civ",icon:"🤖",label:"AI Civilization"}` + `if(p.id==="ai_civ") return "window.location.href='/aiciv'"`
- **API prefix:** `/api/aiciv/*` — 15 routes in server.js

## Tables (all require migration)
- `ai_governors` — 4 seeded (Atlas/Nova/Orion/Aurora)
- `ai_mayors` — 4 seeded (Crest/Dawn/Vox/Terra)
- `ai_npcs` — 5 seeded (Sage Lumis/Trader Kira/Guard Rex/Healer Mira/Explorer Jin)
- `ai_quests` — 6 seeded (easy/medium/hard with SP coin rewards)
- `ai_generated_events` — 5 seeded (festival/competition/challenge)
- `ai_knowledge_base` — 5 seeded articles (history/economy/governance/creator/world)
- `ai_agents` — 5 seeded marketplace agents (ShopBot/CommunityMind/EventHost/LearnBot/TrustGuard)
- `ai_agent_deployments` — tracks user deployments
- `ai_moderation_logs` — AI moderation action history

## Critical lesson
**render() must be called BEFORE loadAll()** — calling loadAll() first causes the spinner to freeze while Supabase calls are pending. Pattern: `render(currentView); loadAll();` at init. This applies to all new phase HTML files. (See safepass-dam.md for same lesson.)

**Why:** Supabase API calls (even fast ones) are async. The initial HTML shows a spinner. If loadAll() finishes before JS replaces the spinner, the spinner freezes. Calling render() synchronously first replaces the spinner with fallback data immediately.

## 20 Modules
1. AI Governor System — deploy/manage AI governors
2. AI Mayor System — city-level AI management
3. AI Community Manager — discussion/report monitoring + suggestions
4. AI Event Generator — auto-create events with templates
5. AI Quest Engine — missions with difficulty/rewards
6. AI Knowledge Engine — world history/article base
7. AI NPC System — chatbot NPCs with rule-based KB
8. AI Economy Analyzer — GMV/demand analysis + recommendations
9. AI Marketplace Manager — fraud/suspicious listing detection
10. AI Creator Coach — personalized creator growth tips
11. AI Business Assistant — campaign/sales analysis for businesses
12. AI World Builder — 6 templates, AI generation form
13. AI Universe Analytics — population growth charts, top worlds
14. AI Discovery Engine — 6-category personalized recommendations
15. AI Social Graph Evolution — 2.4M connections, 94.7% rec accuracy
16. AI Moderation Network — real-time spam/abuse/scam blocking
17. AI Agent Marketplace — deploy/create/monetize AI agents
18. AI Civilization Dashboard — 8 live metric cards + module status
19. Multi-AI Coordination — 5-node AI network, coordination cases
20. Foundation for Autonomous Worlds — 6 autonomous world types
