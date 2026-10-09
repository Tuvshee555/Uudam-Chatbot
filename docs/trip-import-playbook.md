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

## Standard itinerary for trips that leave Ulaanbaatar by train (Erenhot route)

Every trip that starts with the overnight train to the border and ends with the
train home is written the same way. Do not shorten it to "Улаанбаатар - Эрээн":
the train, the border and the arrival time are part of the product. Copy these
days word for word, and write the days in between in the same style.

**First two days**

1. Title `УЛААНБААТАР – ЗАМЫН ҮҮД`. No hotel, no meals, no photo.
   "Улаанбаатар төмөр замын буудал дээр 15:30 цагт цугларан 276-р гал тэргээр
   Замын Үүд хотыг зорино. Энэ өдөр галт тэргэнд хононо. Та бүхэн замын хүнсээ
   зэхэн аялалдаа гараарай."
2. Title `ЗАМЫН ҮҮД – ЭРЭЭН …` (add the next stop). "Өглөө 07:20 цагт Замын Үүдэд
   буугаад автобусанд сууж хил гаалиар нэвтэрнэ. Эрээн хотод ирж …" and then the
   source's own stops, hotel and meals.

**Last two days**

- Second-to-last day, title `ЭРЭЭН – ЗАМЫН ҮҮД` (or the source's last stop first). The
  trip does NOT end on this day: it ends on arrival, the next morning.
  "Өглөөний цайны дараа Эрээн хотод чөлөөт цагтай. Өдөр Эрээнээс автобусаар
  Замын Үүд рүү явж, хил гаалиар нэвтэрнэ. Замын Үүдээс 18:05 цагт 275-р
  галт тэргээр Улаанбаатар хотыг зорино. Энэ шөнө галт тэргэнд хононо."
- Final day, title `УЛААНБААТАР ХОТ`, no hotel, no meals, no photo:
  "Өглөө 09:20 цагт Улаанбаатар хотод ирснээр бидний баялаг аялал баяртайгаар
  өндөрлөнө."

**Rules that follow**

- Duration counts the whole door-to-door trip: the train day through the day of
  arrival in Ulaanbaatar (a trip with this opening and closing and five days
  abroad is 10 days / 9 nights, not 8 / 7).
- The Word or PDF source often skips the train legs because it starts at the
  border. Add them; keep every date, flight time, hotel and meal from the source.
  If the source gives a different train time, the source wins.
- Titles are upper case with ` – ` between stops. Descriptions are full,
  formal sentences like the first and last days above, never fragments.
- Photos go on days that show something to see. Travel days (train, border,
  arrival) get none.
- Included and excluded lists come from the poster's own headings (transport,
  hotels, insurance, guide, sights and meals in the program / personal spending,
  meals and sights outside the program), plus anything the source names, such
  as a paid optional entrance.
- Typing check: never mix Latin and Cyrillic letters inside one Mongolian word.
- Age bands: an infant is 0-23 months and a child starts at exactly 2 years.
  Ads that say "0-2 / 2-9" mean the same; store "0-23 сар" and "2-9 нас".
- A poster price-table column header must not contain the word "буудал"
  (hotel): the mapper reads such a column as a hotel and invents hotel choices.

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
