# Photo audit, 2026-11-16

All 53 non-archived trips (47 published, 376 photos) were laid out on contact sheets in the
order the website shows them and looked at one by one. 37 trips changed; every published trip
still has at least six photos.

What was taken out, in classes:

- **Not a place a traveller would want to see:** an unfinished, empty hotel block as a Hainan
  cover; a flag-pole yard with a group of people as a Jining cover; an itinerary screenshot as a
  cover (draft); a price-text screenshot in a gallery; a hotel room; a metro entrance; an
  aeroplane wing; parked cars at the Ulaanbaatar station.
- **Wrong or meaningless pictures:** an astronaut's night frame of China (black with a few
  lights) on three trips; a European village on two; the Erenhot dinosaur gate on seven
  (a transit town, never a sight of the trip).
- **Dull:** grey panorama strips that crop to a blurred sliver on the trip card (covers of two
  Bangkok and Da Nang trips among them); a 1990s street scene with bicycles; a statue as a dark
  shape against the sky; a red wall; a dim hot-spring pool; a temple gate with a man posing.

Replacements are 54 Wikimedia Commons photographs (CC0 / public domain / CC BY / CC BY-SA,
author and licence kept in each trip's `extra.photo_credits`), chosen by eye from the candidate
sheets and placed on the program day whose sight they show. The bright indoor pool of the
Jining hot-spring resort, already on Cloudinary, replaced the dim one on four trips.

Files:

- `picks.mjs` — the reviewed choices (trip, slot, day, candidate).
- `photo-plan.json` — the plan the applier ran: per trip the reviewed photo set, the new cover,
  day photos, removals and additions, plus each new photo's source and licence.
- `photo-plan.hosted.json` — each new photo's Cloudinary copy.
- `backup-T34.json`, `backup-before-plan.json` — the exact previous gallery, credits, chatbot
  day photos and poster of every touched trip. To roll a trip back, restore `photo_urls`,
  `extra.photo_credits`, the day photos and the poster from its entry; every write also left a
  `poster_trip_versions` row.

Applied with `scripts/apply-photo-plan.ts` (dry run first, then `--apply --backup`). It uploads
new photos to Cloudinary before writing, keeps the gallery, the chatbot's program days and the
poster in step, skips a trip whose photos changed since the review, and pushes the website.
Afterwards every trip's website `image` + `extraImages` equalled the chatbot's photo list, every
photo was on our Cloudinary, and the website sync queue was empty.

The automatic finder (`src/lib/tripPhotoFinder.ts`) now also refuses panorama strips wider than
2.1:1 and astronaut frames, and its ranker is told the first pick becomes the cover and to reject
grey, hazy, empty or merely ordinary pictures, so new trips do not bring these classes back.
