# Connected Trips

The chatbot is the catalogue's source. Saving either a chatbot trip or its
poster commits both records and a website delivery event in one transaction.
`extra.poster_trip_id` is unique. The booking site's existing unique
`Trip.sourceTripId` identifies the same trip, even after renaming it.

## Configuration

Set the chatbot project's server-only `BOOKING_DATABASE_URL` to the booking
site database connection. Set `SITE_URL` to the chatbot's public production
origin. Never expose database credentials using `NEXT_PUBLIC_` variables.

The website projection writes the existing Trip, ItineraryDay and Departure
tables. It keeps trip IDs, slugs and bookings. Deleted trips with booking history
are unpublished instead of erasing their booking records. Removed departures
with bookings are cancelled, preserving the booking's original price snapshot.

Each save attempts delivery immediately. Unfinished events remain in
`trip_website_sync`; admin status polling and the existing daily cron retry them.
The Trips page displays pending delivery/errors and provides a retry action.
The website's existing page cache can take up to 60 seconds to refresh.

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
  and removes its own test records.
- `node --import tsx scripts/verify-connected-pdfs.ts`: render and validate all
  saved poster PDFs; generated review files go in ignored `tmp/pdfs`.

Local scripts can read the existing sibling booking project's `.env`; deployed
code only reads explicitly configured environment variables.
