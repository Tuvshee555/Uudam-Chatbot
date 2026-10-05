# Connected Trips

The chatbot is the catalogue's source. Saving either a chatbot trip or its
poster commits both records and a website delivery event in one transaction.
`extra.poster_trip_id` is unique. The booking site's existing unique
`Trip.sourceTripId` identifies the same trip, even after renaming it.

## Configuration

Set the chatbot project's server-only `BOOKING_DATABASE_URL` to the booking
tables' database connection. After consolidation, it must identify the same
database as `NEON_DATABASE_URL`; the website's `DATABASE_URL` and `DIRECT_URL`
must also identify that database. Website projection and sync status then
commit in the same transaction. Set `SITE_URL` to the chatbot's public production
origin. Never expose database credentials using `NEXT_PUBLIC_` variables.

The website projection writes the existing Trip, ItineraryDay and Departure
tables. It keeps trip IDs, slugs, bookings and website-authored itinerary days.
Archiving from either editor hides the trip while retaining records and history.
Removed itinerary days are retained as archived rows; removed departures are
cancelled and retained, preserving history and each booking's price snapshot.

Each save attempts delivery immediately. Unfinished events remain in
`trip_website_sync`; admin status polling and the existing daily cron retry them.
The Trips page displays pending delivery/errors and provides a retry action.
Website edits also commit a durable retry payload in `Trip.sourceMetadata`
before attempting delivery. The editor exposes a retry action if delivery fails.
The website's existing page cache can take up to 60 seconds to refresh.

Both editors send changed fields and a saved-record version. Stale saves return
409 instead of overwriting another editor's work. Projection uses a three-way
comparison against the prior synced content. Independently changed text and
fares remain in `contentConflicts` or `extra.shared_conflicts` for individual
review; neither app silently wins. Website-only details can be edited from the
chatbot editor, while the website editor exposes canonical aliases and terms.

The shared `/api/poster-pdf?id=...` file renders the actual Poster component,
including its CSS, embedded Mongolian fonts, photos and saved size settings.
The database caches PDF bytes by poster content hash. Editing the poster changes
the hash. Increment the renderer version when changing its CSS or template.

## Verification And Migration

- `node --import tsx scripts/connected-trips.ts`: read-only catalogue audit.
- `node --import tsx scripts/connected-trips.ts --backfill`: update existing
  linked records and deliver all current trips; run after deploying the PDF route.
- `node --import tsx scripts/test-connected-trips.ts --pdf`: creates a temporary
  draft trip, checks both directions, retries, concurrency and linked deletion,
  and archives its own test records. Run mutation tests on an isolated branch,
  not production.
- `node --import tsx scripts/verify-connected-pdfs.ts`: render and validate all
  saved poster PDFs; generated review files go in ignored `tmp/pdfs`.

Local scripts can read the existing sibling booking project's `.env`; deployed
code only reads explicitly configured environment variables.

## Website Field Parity Audit

`npm run audit:website-parity` reads the existing `.env.local` connection and
uses a repeatable-read, read-only database transaction. It does not initialize
schemas, flush sync jobs, run catalogue maintenance or change any stored data.
Reports containing both versions of trip copy stay in ignored
`tmp/website-parity-audit.json`. An alternate output JSON path inside `tmp` and
an alternate env-file path can be supplied as positional arguments.

The audit checks linked identities, shared customer copy, itinerary facts,
visibility, price projections, populated app-specific fields and delivery
state. It also inventories website FAQ/terms/notices versus chatbot FAQ/policies;
when available, the sibling booking project's static defaults are read for FAQ
and terms that have no database override.

One database is not field or answer-context parity. Weather is already read by
the bot from the website's weather API, while hotel/traveler media and editorial
fields have separate editors. A poster-derived website description can match
the sync projection without being stored as canonical chatbot answer text.
Source-import filenames are not treated as website summaries. Duration wording
and hosted itinerary photos are not treated as conflicting itinerary facts.

Keep both versions and review differences individually. This audit does not
resolve conflicts. Scalar fare
and current-projection differences need date/hotel/age/availability review,
not an automatic choice of either price. Production content, Messenger delivery
and real submitted bookings/payments are not modified or exercised by this audit.
