# Partner tour sync

`src/lib/partnerSync/run.ts` maps each source slug to an existing poster and canonical trip.
The public API supplies date/hotel/package fares (adult, both child bands, infant and
single-room supplement), availability, hotels, itinerary, descriptions and included/excluded
items. Branding, contacts and photo/layout assets stay on the existing trip.

The poster and canonical trip save atomically through the connected-trip store. Website
delivery must complete before a run reports success. A pending delivery is retried even
when the source hash has not changed. A per-trip PostgreSQL transaction lock prevents
overlapping runs, and canonical comparison also repairs local drift on the next run.
Malformed responses fail without replacing live data; valid price movements and removed
offers mirror automatically without percentage or price-jump approval thresholds.

## Scheduling

GitHub Actions workflow `Partner trip sync` calls the authenticated production endpoint
at minutes 7 and 37 of each hour. GitHub can delay scheduled jobs under load. The daily
Vercel cron is a fallback; no local computer or customer traffic is required.

Repository configuration:

- Variable `PARTNER_SYNC_URL`: production `/api/cron/partner-sync` URL.
- Secret `PARTNER_SYNC_CRON_SECRET`: matches the deployment's `CRON_SECRET`.

The endpoint waits for the result and returns HTTP 503 for failures, blocked malformed
data or overlapping work. The workflow retries and fails visibly if completion cannot
be confirmed. It can also be run manually from GitHub Actions.

## Operations

```sh
node --import tsx scripts/sync-global-travel.ts --dry-run
node --import tsx scripts/sync-global-travel.ts
node --import tsx scripts/sync-global-travel.ts --force
node --import tsx scripts/verify-partner-sync.ts
```

The parity check is read-only and compares all passenger fares, dates, itinerary,
included/excluded items, headline prices and delivery state across the source, canonical
trip and website. Old duplicate trips remain archived for recovery and must be unpublished.
