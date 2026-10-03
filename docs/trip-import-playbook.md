# Trip Import Playbook

Use this when copying an outside tour into the shared poster/chatbot/website
catalogue.

## Source Of Truth

- Keep the copied trip as one poster JSON object.
- Save through `savePosterTrip`; this creates or updates the linked chatbot trip
  and queues website sync from the same record.
- Do not create separate website-only or chatbot-only rows unless debugging a
  production incident.

## Import Command

Create a local JSON file with this shape:

```json
{
  "id": "poster-source-name-trip-name-2026-2027",
  "title": "АЯЛЛЫН НЭР",
  "source_file": "https://example.com/source-tour",
  "note": "Imported from source page and corrected user screenshot.",
  "data": {
    "title": "АЯЛЛЫН НЭР",
    "duration_days": 8,
    "duration_nights": 7,
    "departures": [{ "date": "2026 оны 11 сарын 14" }],
    "price_table": {
      "columns": ["Хугацаа", "Том хүн", "Хүүхэд 2-11.99 нас"],
      "rows": [
        { "dates": "2026.11.14-11.21", "cells": ["4,990,000₮", "3,990,000₮"] }
      ]
    },
    "days": [
      { "day": 1, "route": "Өдөр 1", "summary": "Хөтөлбөр..." }
    ],
    "includes": [],
    "excludes": [],
    "source_url": "https://example.com/source-tour"
  }
}
```

Preview the mapped values first:

```bash
node --import tsx scripts/import-poster-trip-json.ts tmp/trip.json --dry-run
```

Save it:

```bash
node --import tsx scripts/import-poster-trip-json.ts tmp/trip.json
```

## Copying Rules

- If a source schedule row has no price, ignore it as a real departure.
- If the user provides a corrected price screenshot, trust that over the public
  site table and note it in the import JSON.
- For weekly ranges like `2026.11.14-11.21`, store the range in
  `price_table.rows[].dates`; the mapper preserves it for display and matches by
  the start date.
- Put every real start date in `data.departures`.
- Put day-by-day photos in the poster data when available; the linked chatbot
  trip and website projection read from the same poster data.

## Verification

After saving, check:

```bash
node --import tsx scripts/verify-poster-trip-sync.ts
npm run typecheck
```

For mapper/code changes, also run:

```bash
node --import tsx --test tests/poster-trip-mapper.test.ts
npm run lint
npm run build
```
