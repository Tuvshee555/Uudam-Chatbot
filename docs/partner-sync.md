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

## Hotels and packages

A partner row is one date × hotel; each row has up to two packages (with or without the
programme). The trip keeps them as two separate choices:

- Each price row has `hotel` (the bare hotel name) and `package_id` (an id from
  `extra.package_options`). It also has `hotel_id` and `hotel_profile_ids` when every hotel
  in the option matched a profile. A multi-hotel option ("A+B", "A / B", "A эсвэл B",
  the website's own split) links every profile. "&", an unspaced "/" and "буюу" are part of
  a name ("Resort & Spa"), never a split. A text that only starts with a hotel's name and
  then names another ("A, B", "A болон B", "A & B") is not linked. Two different
  options sold on one date that link to the same hotel get no `hotel_id`, so they stay
  two choices.
- `extra.hotel_profiles` come from the partner's hotels (name, id, stars, description and
  https link off the partner's own domain), merged with what staff stored. Staff photos
  are kept, including those saved under another spelling of the hotel. So are a staff
  link or description, and any hotel staff added that the partner does not list. The
  poster's `partner_snapshot` tells a staff correction apart from the partner's older
  value. A partner hotel that no price row sells, holding only the partner's facts, is
  left out. Partner photos are not copied: they have no image extension and would show
  as links.
- `extra.hotel_links` list the links of hotels a price row sells, for older readers.
- Hotel links and photos are https only, in the schema and in the sync alike.
- Only the poster's price table writes "Hotel · Package" in one cell, because it reads well
  there. A poster-editor save splits it back against the trip's `package_options`
  (`src/lib/poster/packageRows.ts`) and keeps the rows' seats and sold-out state.

The first run after a hotel record changes adds "📝 Буудлын мэдээлэл" to the change report.

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
