# Photo audit, 2026-10-31

Every photo of all 58 trips (35 published) was inspected against the day text
it illustrates, on labeled contact sheets built from the production database.
`review-notes.md` holds the page-by-page findings; `photo-manifest.json` is the
decision record the applier executed (36 trips, 106 slot changes, 64 removals,
28 new photos), and the `-fix*` manifests are the URL corrections that followed
(Wikimedia's thumbnailer only serves fixed sizes, so the first thumb URLs were
refused; two sources were swapped for alternates it would serve).

Applied with `scripts/apply-photo-manifest.ts`:

1. `--apply photo-manifest.json` — poster covers/day photos and trip galleries
   updated through connectedTripMutation (a poster version per change is the
   rollback point; the website projection was queued as for any edit).
2. `--apply photo-manifest-fix*.json` — URL corrections.
3. `--rehost --apply` — once the projection copied each new photo to
   Cloudinary (connected_trip_assets), the canonical slots were swapped to the
   copies, so neither the site nor the bot hotlinks Wikimedia.

Sources, licenses and authors live in each trip's `extra.photo_credits`; every
run is also recorded in `extra.photo_audit`. The `backup-*.json` files are the
exact previous state of each touched poster and gallery, in apply order — to
roll a trip back, restore its poster data and `photo_urls` from the earliest
backup that contains it.

What was wrong, in classes: day photos attached to the wrong day (Egypt's
pyramids on the free beach day, Phuket's Wat Chalong on the water-park day,
Bangkok–Pattaya fully scrambled); photos of a different place on the named
attraction's day (Zhangjiajie pillars for Tianmen Cave and for the glass
bridge, Hong Kong's Bruce Lee statue for Shenzhen Civic Center, the Venetian
Macao for Huaqiangbei, Chureito Pagoda for Senso-ji/Shiraito/Tokyo, castle
photos for Shanghai Wild Animal Park); unverifiable look-alikes replaced with
verified photos (Universal Studios Beijing, Atlantis Sanya); two published
covers that were screenshots of itinerary documents; two private customer
selfies removed; one photographer-watermarked photo removed; optional,
extra-cost activities no longer illustrated as if included (hot-air balloons
in Pamukkale, Universal Studios on free days). Slots with no verifiable photo
were cleared rather than filled with a guess — Linhu Gusai ("Мини Аватар") has
none on Commons, so its days now show no photo until staff add a real one.
