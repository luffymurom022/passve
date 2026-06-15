---
name: SafePass API format change
description: GET /api/tickets returns paginated object, not array. Frontend handles both shapes.
---

`GET /api/tickets` returns `{ tickets: [], total, page, limit }` — not a bare array.

Frontend `loadTicketsFromAPI()` uses `Array.isArray(data) ? data : (data.tickets || [])` to handle both.

**Why:** Pagination was added; the shape changed from bare array to envelope. Any code consuming this endpoint must handle both during transition.

**How to apply:** Always destructure with `data.tickets || []` not just `data` when fetching tickets.
