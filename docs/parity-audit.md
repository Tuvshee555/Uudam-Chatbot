# Parity audit — do the admin, the poster, the website and the bot agree?

A trip lives in three copies: the chatbot row (`travel_trip_entries`), the poster (`poster_trips.data`)
and the website rows (`"Trip"`, `"Departure"`, `"ItineraryDay"` in the booking database). The bot
answers from the first, the poster PDF prints the second, customers book from the third. This nightly
check says, per trip on sale, where they disagree.

```
npm run audit:parity                 # report into the Obsidian vault (Business/Uudam-Parity)
npm run audit:parity -- --out <dir>  # report somewhere else
npm run audit:parity -- --no-partner # skip the partner's public API
```

- **Read-only.** Both databases are read inside `BEGIN … READ ONLY` and rolled back. The partner trip is
  compared with one GET to the partner's public API. No AI calls, no admin secret, no HTTP to our apps.
  The app's log-to-database copy (`travel_error_logs`, its own connection outside that transaction) is
  switched off: the script forces `ERROR_LOG_DB_ENABLED=false` before it loads any app module, and the
  daily task's ps1 sets it as well.
- **Needs** the chatbot's `.env.local` (the npm script loads it): `NEON_DATABASE_URL` and
  `BOOKING_DATABASE_URL`, plus the server settings the app checks when its trip code loads
  (`getEnv()`: `OPENAI_API_KEY`, `VERIFY_TOKEN`, the Facebook page settings, `ADMIN_SESSION_SECRET`, …).
  They are only validated, never used: no AI or Messenger call is made. A missing one is a FAILED note.
- **Writes** `<dir>/YYYY-MM-DD.md` (Ulaanbaatar date) and `<dir>/latest.md`. Folder: `--out`, else
  `PARITY_AUDIT_DIR`, else the vault's `Business/Uudam-Parity` when it exists, else `tmp/parity-audit`.
- **Exit code** 0 even with differences. 1 only when the check could not run; then it writes
  `YYYY-MM-DD-FAILED.md` and a `latest.md` saying why (connection strings are never written). That
  includes an app module that fails to load or the env check above. When node stops before the script
  can write that note (node or tsx missing, the script itself does not compile), the daily task's ps1
  writes it instead, pointing at the console log, so a stale `latest.md` never passes for today's.

Code: `scripts/audit-parity.ts` loads the rows; `src/lib/parityAudit.ts` compares them (pure, tested in
`tests/parity-audit.test.ts` on invented trips).

## What is compared

Trips checked: `status = active` and not hidden (`extra.customer_visible !== false`), read the way the
bot reads them (`listTrips`: schedule-sanitized, with the website's per-date availability overlay).
Every comparison reuses the code that produces the fact, so a difference is what a customer, the next
sync or the next save would actually see.

| Area | Against | Reported |
|---|---|---|
| Website | `websiteTripPayload` — what the next chatbot → website sync would write — vs the website rows now | page hidden; title, duration, hotel, the hotels the price options name; the card's headline price; per upcoming date: adult/child/infant price, status, seats left, a date open on the website the chatbot does not sell, a chatbot date missing on the website; itinerary day count and meals; open website↔chatbot conflicts; a website edit still waiting to reach the chatbot |
| Website (sweep) | every published website page | published although the chatbot trip is archived, cancelled, draft, hidden, unknown, or the page is linked to no chatbot trip (sold-out and paused trips stay published by design) |
| Poster | the trip as a Poster-tab save would leave it (`mapPosterTripToFields` → `splitPackagedHotelRows`, as `syncPosterTrip` does) vs the trip now, each read through the fare resolver per date × hotel × package | a different price read from a poster table row (the PDF shows it, and the save would write it over the chatbot's); a date/hotel only the poster prices; a price no poster row the mapper can read holds (no row dated that day, or a row whose prices the reader rejects), where the save would leave the bot quoting the trip-wide fare, or nothing; one no readable row prices and no trip-wide fare backs; the same prices under another hotel/package name, the same prices with another age band; poster vs chatbot itinerary day count and duration |
| Bot | the shared fare card (`buildFareSection`) and the bot's own checker (`verifyTripReply`, plus every answer `checkSelfConsistency` builds) | no card; no price line although the admin holds prices for a date on sale (customer gets silence, staff a lead); an amount on the card that no price row holds; a non-tugrik amount; the checker refusing the card or an answer (customer gets silence) |
| Partner | the facts the partner sync would store now (`partnerTripFields`, as `scripts/verify-partner-sync.ts`) vs the stored trip | prices or dates, other facts (hotel, notes, includes, itinerary, hotel profiles), any price row, a poster not on the partner's latest data; a partner trip the sync does not list |

Severity: 🔴 a customer can see the wrong fact now · 🟠 wrong after the next save or sync, or staff must
decide · 🟡 detail. The report opens with "N trips checked, M with differences", lists the most serious
ones, then one section per trip with only its differences.

## Reading common findings

- **Poster price differs, adult fares exactly 100,000₮ apart** — most likely the 2026-10-31 +100,000₮
  shift reached the chatbot's rows but not that poster's table (first run, 2026-11-06). The PDF is
  wrong now; a Poster-tab save would undo the shift.
- **Poster price differs on one date** — a per-date price edited in the chatbot (or by the assistant)
  never reaches the poster table; a Poster-tab save puts the old price back (operations map §2).
- **No readable poster row for this price** (🟠 `poster_row_unreadable`) — the amount shown after
  "after a Poster-tab save" is the trip-wide fare the bot would fall back to, not a poster cell. Either
  the date reader places no poster row on that day (the poster has none, or labels it in a way the
  reader dates elsewhere), or a row is dated that day but its prices cannot be read (stay ranges like
  "2027: 01/03 - 01/10", one column pair per package). The PDF itself may print the right price;
  the risk is the next Poster-tab save. Only a "poster price differs" is a fare the PDF prints; inside
  one, an amount marked "(trip-wide, not on the poster)" is the fallback, not a poster cell.
- **Same prices, another hotel/package name** — the poster table has no hotel column (or a column the
  mapper misreads as one); a save rewrites the chatbot's hotel/package choice.
- **Headline price differs** — the website card still shows the fare of a date that has passed; it is
  corrected the next time that trip syncs.
- **Weekly trip's newest date missing** — a weekly schedule is projected 12 weeks ahead from the sync
  day, so one new date per week waits for the next sync of that trip. More than two = not synced for weeks.

## Daily task

Windows Task Scheduler task **"Uudam Parity Audit"**, daily 23:45, user `ganbo`, interactive logon,
normal (not elevated) rights, start when available, 20 min limit — the same setup as "Uudam Admin
Shadow" (23:30). It runs `%USERPROFILE%\.claude\scripts\uudam-parity-audit.ps1`, which runs the check
from this repo with `--out` set to the vault folder and keeps the console output of the last run in
`%TEMP%\uudam-parity-audit.log`.

Register it again (PowerShell, no elevation needed):

```powershell
Register-ScheduledTask -TaskName 'Uudam Parity Audit' -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\ganbo\.claude\scripts\uudam-parity-audit.ps1"') -Trigger (New-ScheduledTaskTrigger -Daily -At '23:45') -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)) -Principal (New-ScheduledTaskPrincipal -UserId 'ganbo' -LogonType Interactive -RunLevel Limited) -Description 'Daily read-only check: do the admin, the poster, the website and the bot agree about every Uudam trip on sale'
```

Run it now: `Start-ScheduledTask -TaskName 'Uudam Parity Audit'`. Remove it:
`Unregister-ScheduledTask -TaskName 'Uudam Parity Audit' -Confirm:$false`.
