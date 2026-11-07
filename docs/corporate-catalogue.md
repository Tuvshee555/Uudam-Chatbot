# Corporate catalogue («Хамт олны аяллын сонголт»)

One PDF of the live trips that the bot sends to companies, teams and groups on Messenger: **one text and one
file attachment**, never a carousel and never a pile of images. Staff generate it in the admin tab
**«Аяллын каталог»**, review the pages, publish it, and can roll back. The bot sends only what was published,
and refuses to send a file that no longer matches the live trips.

Hard rules that shaped it (AGENTS.md): no data, no answer; reservations, payments and quotes stay human; no real
trip, place, price or date in code, tests or docs; no model call anywhere in this feature (it spends nothing).

- [1. Architecture](#1-architecture)
- [2. Data source and why](#2-data-source-and-why)
- [3. Price, date and copy rules](#3-price-date-and-copy-rules)
- [4. Trip codes](#4-trip-codes)
- [5. Rendering stack and fonts](#5-rendering-stack-and-fonts)
- [6. Storage and the public file route](#6-storage-and-the-public-file-route)
- [7. Operator guide: Generate, Preview, Publish, Rollback](#7-operator-guide-generate---preview---publish---rollback)
- [8. Messenger flow and safeguards](#8-messenger-flow-and-safeguards)
- [9. Environment variables](#9-environment-variables)
- [9a. Test recipients: «Тестер холбох»](#9a-test-recipients-тестер-холбох)
- [9b. Hero photo picker, display titles and the recommended shortlist](#9b-hero-photo-picker-display-titles-and-the-recommended-shortlist)
- [10. Testing and scripts](#10-testing-and-scripts)
- [11. Known limits](#11-known-limits)
- [12. Data inconsistencies found so far](#12-data-inconsistencies-found-so-far)
- [13. Before the first real send](#13-before-the-first-real-send)

## 1. Architecture

```
 Neon: travel_trip_entries + poster_trips + settings            (the ONLY source of facts; read-only here)
        |  listTrips / loadPosterRows / contact phones
        v
 src/lib/catalogue/tripData.ts     buildCatalogueSnapshot()  PURE, deterministic, no clock, no DB
   pricing.ts  highlights.ts  groups.ts  diagnostics.ts  contact.ts
        |  CatalogueSnapshot { cards, groups, contact, warnings, contentHash }
        v
 src/lib/catalogue/render/         renderCatalogue()   HTML/CSS -> headless Chromium -> vector PDF 540x960 pt
        |  RenderedCatalogue { pdf, pageCount, pageImages[JPEG], warnings }
        v
 src/lib/catalogue/store.ts        Neon tables catalogue_*   (schema, versions, publish pointer, codes, sends)
        |  saveDraftVersion -> publishVersion / rollbackTo        (admin: src/pages/api/admin/catalogue/*)
        v
 published version (immutable bytes + stored snapshot)
        |                                                    GET /api/catalogue/file/<token>  (public link)
        v
 src/lib/catalogue/send.ts         deliverCatalogue():  plan -> claim -> Meta upload -> caption text -> file
        ^                                  ^
        |                                  +-- freshness.ts: age > 21 days or live data drifted => stale
 src/lib/webhookCatalogue.ts       handleCatalogueTurn(): intent, trip-code replies, group quotes, staff leads
        ^
 src/pages/api/webhook.ts          a few hook lines; every customer-facing word leaves through deliverFastPathReply
```

Admin UI: `src/components/admin/CatalogueTab.tsx` and `src/components/admin/catalogue/*`. Admin API:
`/api/admin/catalogue/{state,config,trips,generate,versions,version/*,publish,rollback,test-send,stats,testers,testers/revoke,photos,recommend}`.
Shared contract (types, constants, edition names): `src/lib/catalogue/types.ts`.

Editions:

| Edition | Admin name | Trips | Published? |
|---|---|---|---|
| `quick` | Хурдан | 8 to 12 chosen by staff (`CATALOGUE_QUICK_MIN_TRIPS/MAX`) | yes, sent for «байгууллагын аялал» style asks |
| `complete` | Бүрэн | every eligible trip, staff order first | yes, sent for «бүх аялал», «каталог» asks |
| `preview` | Дээж | 1 to 4 trips of the live data | never published, never sent to a customer (design check and test) |

## 2. Data source and why

The canonical trip source is the chatbot's own store (Neon `travel_trip_entries`, read through `listTrips()`),
plus the linked poster row for photos. The website is a projection of that store (docs/connected-trips.md), so
reading the store means the catalogue can never disagree with what the bot answers. Consequences:

- **Nothing is copied into the catalogue.** Staff curation (which trips, order, featured, excluded, group
  overrides) is the only thing stored besides the generated files; titles, prices and dates are re-read on every
  Generate.
- **No second price or date table.** Dated fares come from the same resolver the bot uses (`tripOffers.ts`,
  `tripFareBlock.ts`, `departureAvailability.ts`), never from prose.
- The snapshot of a version is stored with it, so a published file can later be compared with the live data
  (freshness) and re-explained exactly (what did page 7 say).

## 3. Price, date and copy rules

Pure functions in `src/lib/catalogue/pricing.ts` and friends; "today" is always the Asia/Ulaanbaatar calendar day.

- **Starting price** = the minimum **adult** fare among **future departures still on sale**, with the date that
  fare belongs to ("3,980,000₮-с"). Never a sum, never inferred, never a child, infant or single-room fare, never a
  sold-out date.
- **Zero, a placeholder (< 1,000₮), a price in another currency, or contradictory dated rows** are missing data:
  the card says **«Үнэ лавлах»** and a warning (`price_missing`, `price_zero`, `price_conflict`) says why.
- **Dates** show the next departures (up to 12 kept, 3 printed plus «болон өөр N огноо»). A trip with no bookable
  future date is not eligible for a catalogue (`isTripEligible`): archived, draft, paused, sold out, cancelled,
  hidden from customers, unpublished on the website, or no future date. A recurring schedule text is allowed.
- **Overview prose never beats the dated fare.** When prose (notes, source description, website summary, marketing
  badge, poster subtitle) quotes a different adult price, the catalogue prints the dated fare and raises a
  `price_conflict` warning naming the field and both amounts (§12).
- **Highlights**: at most three per card, taken from the trip's own curated list, summary sentences, program day
  titles or included sights. Never written or paraphrased by the system; transfers, meals, free days, prices,
  discounts, contact details, availability or booking claims and staff/bot instructions are dropped
  (`internal_copy_dropped`). Fewer than three is fine.
- **Groups** (contents page): admin override, then the trip's metadata, then a computed budget tier (at most 60% of
  the edition's median starting price), then prose, else «Бусад» with a `category_unknown` warning. One group per
  trip.
- **Contact**: at most three configured phone numbers (admin «Холбоо барих мэдээлэл»), the site address, never an
  office address. No phone configured is a **blocking** warning.
- **Photos**: an approved photo already stored for the trip (poster hero, trip photo, poster day photo). None, or
  one that cannot be fetched, gives a clean text placeholder and a `photo_missing` / `photo_fetch_failed`
  warning; a small one raises `photo_low_resolution`. A stand-in picture is never used. Staff may choose which of a
  trip's own photos is the hero, where the crop is centred and how far to zoom (§9b); the choice is stored in the
  catalogue config only, never on the trip. Every card carries a `heroQuality` (excellent, good, weak, missing); weak
  and missing heroes are listed in the admin as «солих шаардлагатай».
- **Display titles**: the book prints a concise editorial title derived from the trip's title of record; staff can
  override that display title (80 characters at most). Identity (the title in the trip store) is never changed.

Warning severities: `info` (FYI), `warning` (publishable, read it), `blocking` (publish refuses until the editor
explicitly acknowledges it: no phone, no trips, a code collision).

## 4. Trip codes

`A01`..`A99`, then `B01`..`B99` and on to `Z99` (2,574 codes). Allocated **once per trip id** by `assignTripCodes`
(advisory lock plus unique constraints, so concurrent generations never collide), persisted in `catalogue_codes`,
**never reused or renumbered**, and shared by every edition. A trip that leaves the catalogue keeps its code
reserved. Customers answer with the code: «A01, 25 хүн, 1-р сар». Typing variants (`a1`, `A-01`, Cyrillic `А01`)
all resolve (`normalizeTripCode`). A card without a code is not printed (blocking warning).

## 5. Rendering stack and fonts

- **Engine**: the repo's existing headless Chromium (`playwright-core` plus `@sparticuz/chromium`, the launch code
  of `src/lib/poster/renderPdf.ts`, proven on Vercel by `/api/poster-pdf`). HTML/CSS goes through `page.pdf()`:
  **vector, selectable, searchable text** with embedded font subsets, page 540 x 960 pt (9:16, built for a phone
  screen). The PDF gets real metadata and a bookmark outline (`pdfMeta.ts`, `pdf-lib`).
- **Photos** are fetched in Node, cropped around the most prominent region and re-encoded with `sharp` (1200 px at
  up to 18 trips, 1080 px up to 30, 960 px beyond; JPEG quality 80/77/74), then inlined as `data:` URIs. The page
  can load `data:` URLs only, runs no script of its own, and every other request is blocked.
- **Fonts** (`public/fonts/`, Noto family, SIL OFL 1.1, see `README.txt` and `OFL.txt` there): Noto Sans Regular and
  Medium for text, Noto Serif SemiBold for headlines, prices and codes, Noto Serif Italic for captions. Glyph
  coverage of the Mongolian Cyrillic letters (Ө ө Ү ү) and the tugrik sign ₮ is asserted from the font files by
  `tests/catalogue-render.test.ts`. The fonts are never served to web pages; the renderer reads them from disk
  (`outputFileTracingIncludes` in `next.config.ts` ships them with the generate and preview routes).
- **Page JPEGs** for the admin preview come from `page.screenshot()` in the same browser session as the PDF, so the
  preview is the pixels of the file that would be sent.
- **Budget**: `/api/admin/catalogue/generate` has `maxDuration = 60`, one generation per edition at a time on an
  instance, and rate limits (6 per minute). A PDF over 12 MB raises a size warning; over 25 MB (Meta's attachment
  limit) is refused at save.

## 6. Storage and the public file route

- **Neon, not Vercel Blob.** `BLOB_READ_WRITE_TOKEN` is not guaranteed in production and Cloudinary raw PDFs return
  401 forever (see the poster PDF notes), so each version's PDF is a `BYTEA` row in `catalogue_versions`, with its
  stored snapshot and page JPEGs (`catalogue_version_pages`). Tables, all `catalogue_` prefixed and created
  idempotently on first use (`ensureCatalogueSchema`): `catalogue_versions`, `catalogue_version_pages`,
  `catalogue_config`, `catalogue_codes`, `catalogue_sends`, `catalogue_fb_attachments`, `catalogue_audit`.
  A partial unique index allows **one published row per edition**, so there is never a moment with two.
- **Versions are immutable.** Publish and rollback only move the published pointer (in one transaction, the old
  published row becomes `superseded`); bytes never change. File names: `UUDAM_Corporate_YYYY-MM-DD_vN.pdf` (quick),
  `UUDAM_Complete_..._vN.pdf`, `UUDAM_Preview_..._vN.pdf`; N is monotonic per edition.
- **Public file route**: `GET|HEAD /api/catalogue/file/<token>`. The token is 24 random bytes (192 bits,
  base64url) with no personal data. Unknown tokens, malformed tokens and **drafts** all answer the same 404, so
  nothing can be enumerated. Published and superseded versions are reachable, with `ETag` (the SHA-256),
  `Cache-Control: public, max-age=3600, immutable`, byte ranges, `X-Robots-Tag: noindex`, `inline` disposition with a
  safe file name. It is the fallback link and the "open in browser" target; the normal Messenger path does not use
  it (§8).
- **Meta attachment cache**: the id Meta returns for an uploaded version is cached per version and page
  (`catalogue_fb_attachments`), so a resend does not upload the bytes again.
- **Send log** (`catalogue_sends`): one row per claimed send, sender stored **hashed**, status, Meta message id,
  reason, retries, suppressed-count. No PSID, no phone, no message text.
- `pruneOldVersions(keep = 20)` deletes old non-published versions (never a published row); it is exported but not
  scheduled yet (§11).

## 7. Operator guide: Generate -> Preview -> Publish -> Rollback

Admin sidebar **«Аяллын каталог»**. Light theme, Mongolian UI. Trip facts are read live; only staff curation is
stored. Sections: **Хувилбарууд** (versions), **Сонголт** (selection), **Зураг ба гарчиг** (photos and titles), **Шалгалт** (review), **Үүсгэх ба нийтлэх**,
**Туршилтын илгээлт** (test send), **Статистик**.

1. **Сонголт (Selection).** Quick: pick 8 to 12 trips and their order, mark featured trips (shown first), exclude
   trips, override a trip's group. Complete: every eligible trip prints automatically; you can only reorder or
   exclude. The admin enforces 8 to 12 for quick (selection, generate and publish).
   For Quick, **«Санал болгосон 10-г ашиглах»** fills the selection with a diverse shortlist (one slot per
   destination, balanced themes, premium photos first) with a reason per trip. It only fills the draft: nothing is
   saved until you press **Хадгалах**.
2. **Зураг ба гарчиг (Photos and titles).** Section «Зураг ба гарчиг»: the list «Хуучин/сул зураг — солих шаардлагатай»
   (weak or missing heroes, each with its reason), and the per-trip picker (§9b).
3. **Шалгалт (Review).** Computed live, before anything is generated: per trip, what will print (price and the
   date it belongs to, dates, highlights, photo and its quality chip, the display title) and its warnings. Nothing is
   stored. Fix the cause in the trip itself (dates, fares, photos, description) and it shows on the next Generate;
   nothing is edited in the catalogue.
4. **Үүсгэх (Generate).** Choose the edition and press **Үүсгэх**. One consistent snapshot of the live trips is built,
   rendered once and stored as a **DRAFT** with its page images. Nothing is published or sent. It usually takes
   under a minute (the route budget is 60 s); a second click while it runs is refused.
5. **Урьдчилан харах (Preview).** Page-by-page images of the exact PDF. Check the cover, each trip page, the
   contents/group page and the closing page (phones, site). Read the **warnings list**. **Open** or **download**
   the real PDF from the version row. «Туршилтын илгээлт» can send a draft (or the preview sample) to a verified
   tester (§9a).
6. **Нийтлэх (Publish).** Press publish and confirm. If the version carries **blocking** warnings the button stays
   off until you tick the acknowledgement; a quick version outside 8 to 12 trips cannot be published. The previous
   published version becomes «хуучирсан» (superseded) in the same moment. From here the bot sends this file.
7. **Rollback.** In **Хувилбарын түүх**, pick a previously published (superseded) version and press **Буцаах**. Only
   versions that were published before can be restored; the bytes never changed, so it is exactly the old file.
   Rolling back to a version older than 21 days, or one whose live data has since changed, makes it stale again
   immediately (§8), so prefer generating a new version.
8. **Stale banner.** The versions tab and a banner on the other sections show when a published version is stale
   (older than 21 days, or a trip is no longer bookable, a dated fare or the next date changed, a printed
   departure was removed, a title changed) with the reasons. Generate and publish again.
9. **Статистик.** Delivery counts by status and version for the last days (sent, link fallback, stale fallback,
   suppressed, blocked, failed), unique recipients. Watch it after the first sends.

Every admin route is behind the same auth as the rest of the admin (signed-in same-origin session for writes, the
read-only bearer token for GET only), validates its body server-side, and is rate limited.

## 8. Messenger flow and safeguards

A customer asks («каталог явуул», «байгууллагын аяллууд», «all tours», «хамт олны аяллын сонголт»). `detectCatalogueIntent`
decides, from words alone and by phonetic stems (Cyrillic, Latin and English spellings, small typos tolerated):

- a catalogue word, a corporate word plus a trip word, «аяллын сонголтууд» or «бүх аяллаа» -> a catalogue request.
  Corporate wording or «сонголт» chooses **quick**; «бүх»/«all», or a bare «каталог» with no corporate wording,
  chooses **complete**;
- a quote word with a company or head count and no catalogue word -> **group quote**: a staff lead and one text
  asking for head count, month and destination or code;
- a message naming a specific trip, or a conversation already about a trip, is **never hijacked**: the existing trip
  flow answers it (unless the customer says company or all). «Дахин явуул» alone repeats the edition the bot sent last.

`deliverCatalogue` then:

```
plan     kill switch? 24h window? staff-owned / paused / photo-only? published version? fresh?   (sends nothing)
claim    one atomic row per send (dedupe key = the inbound message id): redelivery and double taps change nothing
upload   bytes -> Meta attachment API (or the cached attachment id); BEFORE any text, so the caption never lies
text     ONE caption via deliverFastPathReply ("the file below")
file     in the caption's afterDeliver: attachment.type = "file" by attachment_id   -> status "sent"
```

Safeguards:

- **Idempotency**: the same inbound message (webhook redelivery) sends nothing twice; a new message from the same
  person inside 6 hours is `recent_send` and suppressed; an explicit «дахин явуул» is allowed, but not within 45
  seconds of the previous send (`burst_guard`). A half-finished claim expires after 5 minutes. A send that never
  happened releases its claim so the retry goes through.
- **Staff takeover / pause**: a conversation owned by a person, a paused bot, a paused page or photo-only mode sends
  nothing (`blocked_staff_owned`, `blocked_paused`), and a takeover that starts **between** the caption and the file
  stops the file (`assertMaySend`). In every blocked case the request is still **logged and surfaced as a staff
  lead** («каталог хүссэн, ажилтан эзэмшиж байгаа тул бот илгээгээгүй»), never dropped.
- **Kill switch**: `WEBHOOK_BOT_DISABLED=1` or a Vercel Preview deployment sends nothing at all (`blocked_killswitch`;
  `PREVIEW_META_OUTBOUND_ALLOWED=1` overrides only the Preview rule). A dry run ignores the switch because it sends
  nothing.
- **24-hour window**: Messenger lets the page answer within 24 hours of the customer's last message; the code uses
  24 h minus 5 minutes and sends nothing outside it (`blocked_window`, plus a lead).
- **Stale fallback**: age over 21 days (judged on when the data was read, not on publish time), or live drift
  (`liveDrift`: trip gone or no longer bookable, dated fare or its date changed, a printed departure removed, title
  changed). A stale file is **never sent**: the customer gets ONE short text with the website link and a staff lead
  names the reasons. A failed comparison (database busy) is «unverified», not stale: infrastructure trouble is not
  evidence about prices. New trips appearing later are not drift (nothing in the file is false).
- **No published version**: nothing is sent, no apology is invented, the request is logged and a staff lead is
  written (`no_published_version`). A draft is never sent to customers.
- **Meta refuses the file**: a rejected attachment id is cleared and the bytes uploaded once more; a transient error
  is retried once; if the file still cannot go, the caption has already been delivered and **ONE** text with the
  public link follows (`sent_link_fallback`, `fileAccepted = false`), plus a staff lead. With no public host
  configured, a «манай ажилтан илгээнэ» text and a lead instead. The system never claims a file was sent when it was
  not and never sends a second file.
- **Instagram** gets the link text only (Messenger file attachments are not used there).
- **Trip-code reply** «A01, 25 хүн, 1-р сар»: the trip is selected in the conversation, a structured staff lead
  is written with the code, trip, head count and month, and ONE short acknowledgement says staff will prepare the
  quotation. It states no price, date or availability and books nothing. An unknown or inactive code is silence plus
  a lead.
- **Logs**: `catalogue.delivery` with status, reason and counters; sender ids are hashed everywhere.

## 9. Environment variables

| Variable | Needed | Purpose |
|---|---|---|
| `NEON_DATABASE_URL` | yes (already set) | trips, posters and every `catalogue_*` table |
| `CATALOGUE_TEST_RECIPIENT_PSIDS` | **optional extra** | comma-separated PSIDs the admin may ALSO send tests to. Not needed: verified testers (§9a) replace it. A recipient must have written to the page in the last 24 hours. |
| `CATALOGUE_PUBLIC_BASE_URL` | optional | host of the public file link; falls back to `NEXT_PUBLIC_SITE_URL`, `SITE_URL`, then the Vercel production URL |
| `WEBHOOK_BOT_DISABLED` | existing | kill switch; also honoured by test sends |
| `BLOB_READ_WRITE_TOKEN` | **not needed** | the catalogue stores nothing in Vercel Blob |
| `CHROME_EXECUTABLE_PATH` | local only | a local Chrome or Edge for rendering; on Vercel `@sparticuz/chromium` is used |

Test send rules (`/api/admin/catalogue/test-send`): dry run is the default and sends nothing; a real send needs
`dryRun=false` **and** an explicit confirmation **and** a verified tester (§9a) with an open Messenger window (or a
PSID on the optional env list) **and** the Meta kill switch / Vercel Preview rule off **and** the page not paused; the
browser never holds a full PSID (only labels and a masked tail). The file may be a draft, the published version or
the preview sample (the sample only to a verified tester).

## 9a. Test recipients: «Тестер холбох»

Nobody hunts for a Messenger id or edits a Vercel variable any more, and a test can never reach a customer: identity
is **proven by a one-time code**.

1. In **Аяллын каталог -> Туршилтын илгээлт** a signed-in staff member presses **«Тестер холбох»** (optionally naming
   the device). The server mints a code like `UUDAM-TEST-7K3Q9X` (no 0/O/1/I/L), keeps only its SHA-256, and shows it once.
   It is valid for **30 minutes** and works **once**; pressing the button again retires the previous unused code. A
   read-only API token cannot mint one.
2. The staff member sends **exactly that code, as the whole message,** to the Page from their **own Messenger
   account**. This is the one unavoidable live-device step; the screen says so while no tester exists.
3. The webhook (`handleTesterPairingTurn` in `webhookCatalogue.ts`, called by `webhook.ts` after the paused-page,
   paused-sender and staff-takeover checks and before any routing) recognises a message that **is** an active code
   (upper/lower case and surrounding spaces forgiven; a sentence, a near miss, an expired, used or stranger's code is
   ignored and answered by the normal flow). It burns the code in one atomic `UPDATE ... RETURNING`, registers THAT
   sender in `catalogue_testers` and replies one short acknowledgement through `deliverFastPathReply`:
   «Тестийн бүртгэл амжилттай. Админ дээрээс каталогийг илгээж болно.» The code is never written to the conversation
   history or the logs. A sender gets five code-shaped tries per ten minutes.
4. The tester appears in the admin as **label + masked tail + verified time + «Messenger цонх нээлттэй / хаагдсан»**
   and a **Цуцлах** (revoke) button. The 24 h window is the later of the tester's own last message and
   `travel_senders.last_seen`, which `trackSender` refreshes on every inbound message, so writing to the Page again
   reopens it. Up to 10 active testers.

Tables (created lazily by `src/lib/catalogue/testers.ts`, not part of the shared schema): `catalogue_tester_codes`
(code hash, label, creator, expiry, consumed marker) and `catalogue_testers` (raw PSID server-side only because
sending needs it, a PSID hash, page id, label, masked tail, verified / last inbound / revoked stamps, creator). The raw
PSID never leaves the server: every admin response and log carries only the label, the masked tail and an opaque id.

What a real send to a tester checks, all of it: the tester is verified and not revoked; the window is open (else
`tester_window_closed`, with the instruction to write to the Page again); `dryRun=false` and `confirm=true`; the Meta
kill switch / Vercel Preview rule is off; the **page** is not paused and photo-only mode is off. **Decision:** a
sender-level pause or staff takeover on the tester's OWN conversation does not block a test. That conversation is the
staff member's own account, verified by a code only a signed-in admin could mint; staff "owning" it is exactly what they
are doing. No customer send slot is claimed. The payload is always one text and one file attachment.

## 9b. Hero photo picker, display titles and the recommended shortlist

Section **«Зураг ба гарчиг»** (`GET|PUT /api/admin/catalogue/photos`, `GET /api/admin/catalogue/recommend`).

- **Per trip**: every photo the trip owns appears as a candidate with its **real measured size**, a 0-100 score and
  issue chips (low resolution, text or poster risk, ...). Choose one, then click or drag on the full photo (or use the
  sliders) to set the **focal point**, and set the **zoom** (1 to 3). The 9:16 preview is the same CSS the book uses
  (`object-fit: cover`, `object-position` at the focal point, `transform: scale` around it).
- **Server rules**: the chosen url must be one of that trip's own candidates (a photo of another trip or site is
  refused, 422); focal in 0..1, zoom in 1..3; `null` clears the choice. Stored as `heroByTripId[tripId] = {url, focal, zoom}`
  in the catalogue config, together with `titleOverrides[tripId]` (display only, at most 80 characters). Neither
  touches a price, a date or the trip's own title. Writes need a signed-in same-origin session; the bearer token reads only.
- **«Хуучин/сул зураг — солих шаардлагатай»**: trips whose hero quality is weak or missing, each with a plain reason
  (resolution, no photo). The review table shows the same quality chip and reason.
- **Recommended shortlist**: `GET /recommend` returns trip ids with a reason each plus the trip best suited to the cover.
  The Quick tab's button fills the draft; nothing is saved without **Хадгалах**.

## 10. Testing and scripts

```
node --import tsx --test tests/catalogue-data.test.ts tests/catalogue-render.test.ts tests/catalogue-store.test.ts \
  tests/catalogue-intent.test.ts tests/catalogue-send.test.ts tests/catalogue-journeys.test.ts \
  tests/catalogue-admin-api.test.ts tests/catalogue-admin-ui.test.ts tests/catalogue-e2e.test.ts
npm run qa:conversations     # includes the catalogue journeys; part of the Vercel prebuild
npm run typecheck && npm run lint
npm run gate                 # read-only, no AI calls; read every changed decision before pushing routing changes
```

- `tests/catalogue-e2e.test.ts` runs the whole path with invented trips: snapshot, render (real Chromium when
  available, a stand-in PDF otherwise), draft, publish, delivery through the real store (in-memory Neon) and a
  stubbed Meta. It asserts exactly one file attachment and one caption text, no image attachment, redelivery
  silence, explicit resend after the burst window (cached attachment, no second upload), the link-text fallback
  when Meta refuses the file, the stale fallback after a dated fare changes, and the no-published-version lead.
- `npm run catalogue:sample -- <outDir> [quick|complete|preview] [count]`: renders the LIVE trips to a PDF and one
  JPEG per page for a visual check. Read-only; codes are in memory.
- `npm run catalogue:dry-run -- [--edition quick|complete] [--count 10] [--trips id1,id2] [--out dir] [--no-photos]`:
  the full flow against the live trips with an in-memory store and a stubbed Meta. Prints the exact payload sequence
  (upload, one text, one file attachment), file name, size, page count, version label, the warnings list and the
  freshness verdict. Never writes Neon, never calls Meta, no model.
- `node --import tsx scripts/catalogue-render-sample.ts <outDir> [tripCount]`: renders INVENTED trips with synthetic
  photos (no database, no network), the quickest design check.

## 11. Known limits

- **Public link size on Vercel.** Treat about 4.5 MB as the ceiling for `GET /api/catalogue/file/<token>`: Vercel caps
  non-streamed function responses there. The route writes larger files in chunks, but that has not been proven on
  production for a PDF above 4.5 MB, so before relying on the link for a big complete edition open it on a phone.
  The **Messenger path is unaffected**: the bytes are uploaded to Meta from inside the function (the limit is 25 MB),
  the customer receives Meta's attachment, and the link is only the fallback. Photo count and quality are tuned so
  a quick edition is typically a few hundred KB to a few MB.
- **Instagram** receives the link only, no file attachment.
- **`/api/demo`** (the public demo chat) does not handle catalogue requests; only the Messenger and Instagram
  webhook does.
- Old versions are kept until `pruneOldVersions` is run (it is not scheduled yet); each costs the PDF plus page JPEGs
  in Neon.
- The preview edition is a design check on up to four live trips; it cannot be published or sent to customers.
- Photos come only from images already stored for the trip; no search or generation happens here. Without one the
  page shows a text placeholder and a warning.
- Rendering needs Chromium: if it cannot start, Generate answers with a clear error and the published version is
  untouched.

## 12. Data inconsistencies found so far

Described as classes of problem, not as trips. The catalogue prints the dated fare in every case and tells staff.

1. **Prose price versus dated fare.** A trip's overview prose, notes, marketing text or poster subtitle quotes one
   adult price (often an older or "from" price) while its dated fare table says another. The catalogue prints the
   dated fare and raises `price_conflict` naming the field and both amounts, and says when the prose is the cheaper,
   stale one. Fix: edit the prose, or the dated fare if the prose is right.
2. **Website «price» column versus dated fare.** The website projection carries a single price field that can lag
   the dated fares. Raised as an info-level `price_conflict`; the website sync is the place to correct it.
3. **Trips with no readable adult fare** (zero, blank, foreign currency or contradictory rows on one date) print
   «Үнэ лавлах» with `price_missing`, `price_zero` or `price_conflict`.
4. **Missing category or transport type.** A trip with no usable category lands in «Бусад» (`category_unknown`) and
   one with no transport type prints without the transport label (info). Fix the trip's category in the admin or
   override its group in «Сонголт».
5. **Photos.** Some trips have no approved photo, or only a small one; both are flagged. Some stored photo links
   no longer download; the card gets a text placeholder and `photo_fetch_failed`.
6. **Title casing.** Trip names are entered inconsistently (all capitals, all lower case); the PDF normalises the
   display casing but the stored titles are unchanged.

## 13. Before the first real send

Do these in order. Nothing here messages a real customer until step 6.

1. **Pair your test device.** In the admin: «Туршилтын илгээлт» -> **«Тестер холбох»**, then send the code it shows,
   exactly, from your own Messenger to the Page (§9a). No PSID to find, no Vercel variable. Check the contact phones in
   the admin «Холбоо барих мэдээлэл» (up to three are printed).
2. **Dry run.** `npm run catalogue:dry-run -- --edition quick --out tmp/dry-run`. Expect: delivery `sent`, **1 text, 1
   file attachment, 0 image attachments**, freshness FRESH, no blocking warnings. Open the PDF; read every warning
   (§12 classes) and fix the trips, not the catalogue.
3. **Generate and Preview in the admin.** Generate **Хурдан** (and **Бүрэн**), page through the preview on a phone
   width, check codes, prices, dates, phones, site.
4. **Send a test to yourself.** Pick your tester (its «Messenger цонх» must be open; write anything to the page if not),
   then «Туршилтын илгээлт» -> pick the draft -> «Дээж харах» (dry) -> tick the confirmation -> «Туршилтаар илгээх». Confirm on your phone: one caption, one PDF
   that opens, selectable text, Ө Ү ₮ rendering. Reply «A01, 25 хүн, 1-р сар» and confirm exactly one acknowledgement.
5. **Publish.** «Нийтлэх» the version you tested. Open the public link in a browser and on a phone (§11).
6. **Watch the first real asks.** Keep «Аяллын каталог» -> «Статистик» and the **Leads tab** open: every blocked,
   stale, link-fallback or failed delivery and every trip-code reply is a staff lead. Reply to code replies by hand;
   quotes and bookings are always human.
7. **Keep it fresh.** Re-generate after price or date changes and at the latest every 21 days; the stale banner
   shows when. If the bot ever must stop sending the catalogue: set `WEBHOOK_BOT_DISABLED=1` (everything stops), or
   publish a corrected version (there is no unpublish button; the stale fallback already keeps an outdated file from
   going out).
