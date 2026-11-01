# Admin dashboard audit — 2026-10-31

Scope: the admin panel at `/admin` (all 16 sections, their APIs, sign-in, and the
admin → database → chatbot/website data flow). Production was inspected read-only
(browser, read-only SQL, the parity audit); nothing was written to production data
on purpose. Recovery point before the work: tag `archive/2026-10-31/pre-admin-overhaul`.

## What was wrong, and what changed

| Area | Problem found | Now | Commit |
|---|---|---|---|
| Trip hide/show | Sent the browser's whole, possibly stale `extra` with no version check: reverted prices/itineraries saved meanwhile, and stored the list's display-only `poster_photo_count` in a live row | Sends `customer_visible` only, with the loaded `updated_at` (409 on conflict); `normalizeExtra(Patch)` drops display-only keys (`website_sync`, `poster_photo_count`, `list_projection`) for every caller | c52fc62 |
| Bulk archive | "Бүгдийг архивлах" quoted the filtered count but archived the whole catalogue | `DELETE /api/admin/trips` takes an explicit `ids` list (`?all=true` is refused); the Trips tab archives exactly the listed trips after typing «архивлах» | c52fc62 |
| JSON editor | A field missing from ChatGPT's answer was cleared (missing `departure_dates` emptied the schedule → auto-archive); non-numeric prices became null; bad status became "active"; every trip rewritten with no version check; a 401/500 showed "✓ undefined saved"; a 250,000 px page | Only changed trips/fields are sent, each with its loaded version, after a review dialog (before → after); absent keys stay unchanged, bad values are refused per trip, new trips default to draft; only confirmed results are shown; fixed-height editor | c52fc62 |
| False "saved" | Bot-tab switches, reminder text and «Нэр татах» ignored the response («Нэр татах» also sent no JSON header, so it never worked); Error log and Payments showed an empty "all clear"/"QPay off" screen when loading failed; poster backup saved an error body as the file | `ensureOk()` (`src/lib/adminUtils.ts`) throws unless the server accepted; load failures are shown as failures; payment status changes ask for confirmation | c52fc62 |
| Sign-in | Secret kept in localStorage (readable by any injected script), resent on every request, no server-side expiry, no sign-out; 4 unauthenticated data requests per page load counted against the 20/min lockout; a wrong secret gave no message | HttpOnly, SameSite=Strict, signed 7-day sliding session cookie (`src/lib/adminSession.ts`; key derived from `ADMIN_SECRET`, so rotating it ends all sessions); cross-origin cookie writes refused; «Гарах»; clear wrong-secret/throttle messages; nothing loads before the session is confirmed. Scripts keep `x-admin-secret` | 82acde4 |
| Headers | Admin could be framed and indexed | `/admin` and `/api/admin/*`: `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `noindex`, `same-origin` referrer | 82acde4 |
| Navigation | Refresh always reopened the overview; Back did nothing | The section is in the URL (`#trips`); refresh, Back/Forward and links keep it | 82acde4 |
| Performance | The whole page re-rendered every second (Bot-tab countdown); bot state polled every 5 s everywhere; readiness check and lead list reloaded every 45 s on every tab; trips list was 2.0 MB | Countdown lives in the Bot tab; 5 s polling only there (20 s elsewhere); readiness every 5 min; leads only on the Leads tab; trips list `?view=list` (480 KB), editor fetches the trip it opens (`?id=`) | 82acde4, 77493a1 |
| Leads | List capped at 120 of 279 (older requests unfindable; "Бүгд 120" vs "Нийт 279"); headline "Шинэ хүсэлт 276" in red vs nav badge 65; "today" and the chart used UTC days (began 08:00 local) | Server-side search over all leads; pages of 200 with "load more" and "N / total loaded"; headline "Анхаарах" = nav badge (same 200 leads); Ulaanbaatar days | 77493a1 |
| Overview | "Хариулсан 83" (messages since records began yesterday, titled "last 7 days") next to "Бот хариулсан 146" (people) | "Мессежийн хүргэлт" panel with message units and its real window, below the people KPIs; duplicate cards removed | 77493a1 |
| Settings | Saving sent every field, writing back stale copies of anything changed meanwhile | Sends only fields changed since the form loaded (`changedSettingsFields`) | 8a2dafe |
| Layout | Trip rows ~250 px, Bot rows ~150 px with full-width buttons, empty list shown as "Аялал олдсонгүй" while loading | Compact trip rows (facts line, next departure, gaps line), one-line bot rows, one-line sync status when healthy, loading skeletons; phones skip the leads chart | 77493a1, 1ea3490 |

## Data flow (verified 2026-10-31, read-only)

- Admin → `PATCH/POST /api/admin/trips` → `travel_trip_entries` (Neon) and, in the same
  transaction, the website projection queue `trip_website_sync`, flushed inline.
- Chatbot: reads `listTrips()` on every message; no trip cache (only 5 s caches for bot
  control/settings).
- Website: reads its `Trip`/`Departure` tables in the same database; its page cache can
  lag up to ~60 s (website project).
- Parity audit: 61/61 trips linked, 0 visibility differences, 0 differences in the fares
  the website currently projects, 0 pending/failed deliveries. Live pages for four
  active trips showed the database price; an archived trip's page returned 404.

## Open items (not done here)

- One shared admin secret: no per-person accounts, roles or "who changed what" trail.
  Sessions are stateless: «Гарах» ends this browser's session; a copied cookie stays
  valid until it expires unless `ADMIN_SECRET` is rotated.
- Production data left as found (each fix needs an owner-approved write):
  one trip still carries a stored `poster_photo_count` (harmless now, never written
  again); 31 `trip_website_sync` rows point at deleted trips whose website pages are
  already gone.
- JSON editor: pasting an old downloaded file over a fresh load shows its stale values as
  changes; the review dialog lists every before → after so staff can catch it, but the
  editor cannot tell an old file from an intentional edit.
- Catalogue gaps the admin correctly flags: 31 trips miss required facts (infant fare
  28, child 11, adult 6, dates 5, photos 2); two active trips have no price at all.
  Website vs chatbot base fares differ on 8 package-priced trips (owner decision pending).
- Not exercised end to end: real file uploads under the cookie session (the Blob client
  posts same-origin, so the cookie is sent), saves that would write to production.
- Large components remain (`admin.tsx` ~2,400 lines, `PosterTab` ~2,900,
  `TripEditModal` ~1,400); `settingsToForm` exists twice (`adminUtils`, `adminPageUtils`)
  with different `handoff_enabled` defaults.

## Re-checking

- `npm test`, `npm run typecheck`, `npm run build` (runs the conversation gates).
- `ADMIN_SMOKE_SECRET_FILE=<file> node scripts/admin-smoke.mjs [baseUrl]` — read-only
  browser run (sign-in, sections, editor, archive guard, lead search, JSON review,
  sign-out); never saves.
- `npm run audit:website-parity` — read-only admin/website comparison.
- Running `next dev` with `.env.local` uses the production database: browsing is
  reads plus routine schema/maintenance writes, and a local env without the Blob token
  logs `customer_documents.storage_check` errors into the production error log (5 rows
  came from this audit's local runs, 2026-10-31 13:50–14:21 UTC).
