import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { AIChangeProposal } from "../src/lib/travelTypes";

applyTestEnv();

// The owner's four fixes to the new-trip review (2026-11-06). Every place, hotel,
// price and title below is invented; "now" is fixed far ahead.
const NOW = new Date("2098-03-01T04:00:00Z");
type Row = Record<string, unknown>;
const photo = (title: string, query = "Norvel grand hall", n = 0) => ({
  url: `https://thumb.example.test/${n}/1920px-${n}.jpg`, pageUrl: "", title, width: 3000, height: 2000, license: "CC0", author: "", query,
});

/* ------------------------------------------------ 1. duplicate photos */

test("two files of one view are the same picture: digits, dates, extensions, punctuation and camera words do not count", async () => {
  const { samePicture, withoutSamePictures } = await import("../src/lib/tripPhotoFinder");
  const same: Array<[string, string]> = [
    ["Norvel Grand Hall of the People 20240721", "Norvel Grand Hall of the People 20240721 13"],
    ["Norvel Grand Hall of the People 2024-07-21", "Norvel_Grand_Hall_of_the_People_(2).jpg"],
    ["IMG_2041 Lumia bridge", "Lumia Bridge DSC 5531"],
    ["Lumia bridge photo 3", "Lumia-bridge, edited"],
  ];
  for (const [a, b] of same) assert.equal(samePicture(photo(a, "q1", 1), photo(b, "q2", 2)), true, `${a} = ${b}`);
  const different: Array<[string, string]> = [
    ["Lumia bridge at night", "Lumia old town"],
    ["Norvel harbour", "Norvel harbour lighthouse at dawn"],
    ["IMG 2041", "IMG 2042"],
  ];
  for (const [a, b] of different) assert.equal(samePicture(photo(a, "q", 1), photo(b, "q", 2)), false, `${a} ≠ ${b}`);
  // Found for the same sight, a title one word longer is still the same view; for another sight it is not.
  assert.equal(samePicture(photo("Norvel grand hall of the people", "Norvel grand hall", 1), photo("Norvel grand hall of the people night", "Norvel grand hall", 2)), true);
  assert.equal(samePicture(photo("Norvel grand hall of the people", "Norvel grand hall", 1), photo("Norvel grand hall of the people night", "Norvel at night", 2)), false);
  const kept = withoutSamePictures([photo("Norvel Grand Hall 20240721", "q", 1), photo("Lumia bridge", "q", 2), photo("Norvel Grand Hall 20240721 13", "q", 3)]);
  assert.deepEqual(kept.map((entry) => entry.title), ["Norvel Grand Hall 20240721", "Lumia bridge"], "the better-ranked copy stays");
});

test("a pick that copies an earlier one is replaced by the next different picture, so the trip still gets its count", async () => {
  const { rankPhotos } = await import("../src/lib/tripPhotoFinder");
  const candidates = [
    photo("Norvel Grand Hall 20240721", "Norvel grand hall", 1),
    photo("Norvel Grand Hall 20240721 13", "Norvel grand hall", 2),
    photo("Lumia bridge at dusk", "Lumia bridge", 3),
    photo("Velmor lake shore", "Velmor lake", 4),
    photo("Norvel old town lanes", "Norvel old town", 5),
  ];
  const previews = (async () => new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
  let prompt = "";
  const ranked = await rankPhotos(candidates, { subject: "Norvel", count: 3, fetchImpl: previews,
    ask: (async (parts: Array<{ text?: string }>) => {
      prompt = parts.map((part) => part.text || "").join("\n");
      // Labels follow the preview order; find the two copies by their titles.
      const number = (title: string) => (prompt.match(new RegExp(`Photo (\\d+) — searched for "[^"]+": ${title}$`, "m")) || [])[1];
      return { text: JSON.stringify({ picks: [number("Norvel Grand Hall 20240721"), number("Norvel Grand Hall 20240721 13"), number("Lumia bridge at dusk"), number("Velmor lake shore")].map(Number) }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    }) as never });
  assert.deepEqual(ranked.map((entry) => entry.title), ["Norvel Grand Hall 20240721", "Lumia bridge at dusk", "Velmor lake shore"]);
  assert.match(prompt, /Pick up to 5 of the 5 photos/, "reserves are asked for beyond the wanted three");
  const order = [...prompt.matchAll(/^Photo \d+ — searched for "[^"]+": (.+)$/gm)].map((match) => match[1]);
  assert.equal(order.at(-1), "Norvel Grand Hall 20240721 13", "a second copy is shown only after every different picture");
});

test("one picture found under two names is placed once; the trip still gets its six from the reserves", async () => {
  const { finalizeNewTripActions } = await import("../src/lib/tripProposalFinalize");
  const { pictureFor } = await import("./helpers/photoFixtures");
  const { createHash } = await import("node:crypto");
  const words = ["dawn", "river", "spring", "night", "rooftops", "lanterns", "harbour", "market", "temple", "orchard"];
  const downloaded: string[] = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/w/api.php")) {
      const query = (url.searchParams.get("gsrsearch") || "").replace(" filetype:bitmap", "").replace(' incategory:"Quality images"', "");
      const pages = Object.fromEntries(words.map((word, index) => [`${query}-${index}`, { title: `File:${query} ${word}.jpg`, imageinfo: [{
        url: `https://upload.example.test/${encodeURIComponent(query)}-${index}.jpg`, thumburl: `https://thumb.example.test/${encodeURIComponent(query)}/1920px-${index}.jpg`,
        descriptionurl: "https://commons.example.test/x", width: 3000 - index, height: 2000, mime: "image/jpeg",
        extmetadata: { LicenseShortName: { value: "CC0" }, Artist: { value: "Fixture Author" } } }] }]));
      return new Response(JSON.stringify({ query: { pages } }), { status: 200 });
    }
    // The second file of each place is the first one uploaded again under another title.
    const seed = String(input).replace(/1920px-1\.jpg$/, "1920px-0.jpg");
    if (/1920px-/.test(String(input))) downloaded.push(String(input));
    return new Response(await pictureFor(seed), { status: 200, headers: { "content-type": "image/jpeg" } });
  }) as unknown as typeof fetch;
  const ask = (async (parts: Array<{ text?: string }>) => {
    const prompt = parts.map((part) => part.text || "").join("\n");
    const offered = (prompt.match(/^Photo \d+ /gm) || []).length;
    return { text: prompt.includes("search phrases")
      ? JSON.stringify({ queries: [{ q: "Norvel lantern street", day: 2 }, { q: "Lumia river bridge", day: 2 }, { q: "Velmor old harbour", day: 2 }], cities: [] })
      : JSON.stringify({ picks: Array.from({ length: offered }, (_, i) => i + 1) }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }) as never;
  const bytes: string[] = [];
  const upload = async (buffer: Buffer, name: string) => { bytes.push(createHash("md5").update(buffer).digest("hex")); return `https://res.cloudinary.com/fixture/${bytes.length}-${name}`; };
  const proposal: AIChangeProposal = { summary: "", needs_confirmation: false, important_reason: "", conflicts: [], conflict_items: [],
    actions: [{ action: "upsert", fields: { route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", duration_text: "3 өдөр 2 шөнө", extra: { duration_days: 3, duration_nights: 2, destinations: ["Норвел"], itinerary_days: [
      { day: 1, title: "УЛААНБААТАР – НОРВЕЛ", description: "Чингис Хаан олон улсын нисэх буудлаас хөөрнө.", meals: {} },
      { day: 2, title: "НОРВЕЛ ХОТ", description: "Лумиа гүүр, хуучин хороолол.", meals: {} },
      { day: 3, title: "НОРВЕЛ – УЛААНБААТАР", description: "Улаанбаатар хотод газардсанаар аялал өндөрлөнө.", meals: {} },
    ] } } as never }] };
  await finalizeNewTripActions(proposal, { photos: { fetchImpl, ask, upload }, now: NOW });
  const extra = (proposal.actions[0].fields as Row).extra as Row;
  const urls = (proposal.actions[0].fields as Row).photo_urls as string[];
  assert.ok(downloaded.some((url) => /1920px-1\.jpg$/.test(url)), "the repeated files were found and downloaded, then left out");
  assert.equal(urls.length, 6, "six photos, never fewer");
  assert.equal(new Set(bytes).size, bytes.length, "no picture is placed twice");
  assert.equal(Object.keys(extra.photo_credits as Row).length, 6);
});

/* ------------------------------------------------ 2. hotels by default */

test("a new trip read from a file lists the hotels it names as hotel profiles, without a click", async () => {
  const { withSuggestedHotelProfiles } = await import("../src/lib/tripHotelNames");
  const fields = { route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", hotel: "Хотын төвд байрлах Норвел 4 одтой буудал эсвэл Лумиа буудал", extra: { price_groups: [{ hotel: "Велмор нуурын буудал · Хөтөлбөртэй" }] } };
  const next = withSuggestedHotelProfiles(fields);
  assert.deepEqual((next.extra as Row).hotel_profiles, [
    { name: "Велмор нуурын буудал", url: "", description: "", media: [] },
    { name: "Хотын төвд байрлах Норвел 4 одтой буудал", url: "", description: "", media: [] },
    { name: "Лумиа буудал", url: "", description: "", media: [] },
  ]);
  const described = { ...fields, extra: { hotel_profiles: [{ name: "Норвел Гранд", url: "https://hotel.example.test", description: "", media: [] }] } };
  assert.equal(withSuggestedHotelProfiles(described), described, "a trip that already has hotel profiles is unchanged");
  const none = { route_name: "X", extra: {} };
  assert.equal(withSuggestedHotelProfiles(none), none, "no hotel named, nothing added");

  const { finalizeNewTripActions } = await import("../src/lib/tripProposalFinalize");
  const proposal: AIChangeProposal = { summary: "", needs_confirmation: false, important_reason: "", conflicts: [], conflict_items: [],
    actions: [{ action: "upsert", fields: { route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", hotel: "Норвел 4* буудал", extra: { itinerary_days: [
      { day: 1, title: "УЛААНБААТАР – НОРВЕЛ", description: "Чингис Хаан олон улсын нисэх буудлаас хөөрнө.", meals: {} },
      { day: 2, title: "НОРВЕЛ – УЛААНБААТАР", description: "Улаанбаатар хотод газардсанаар аялал өндөрлөнө.", meals: {} },
    ] } } as never }, { action: "patch", trip_id: "existing-trip", fields: { hotel: "Лумиа буудал" } as never }] };
  await finalizeNewTripActions(proposal, { now: NOW });
  assert.deepEqual(((proposal.actions[0].fields as Row).extra as Row).hotel_profiles, [{ name: "Норвел 4* буудал", url: "", description: "", media: [] }]);
  assert.equal((proposal.actions[1].fields as Row).extra, undefined, "a change to an existing trip gets no hotel profiles");
});

/* ------------------------------------------------ 3. adult + child price to publish */

test("publishing needs the adult and the child fare (per date: on every upcoming row); a draft needs neither", async () => {
  const { publishPriceGap } = await import("../src/lib/tripReview");
  assert.deepEqual(publishPriceGap({ adult_price: null, child_price: null }, NOW), { adult: true, child: true, rows: [] });
  assert.deepEqual(publishPriceGap({ adult_price: 3_290_000, child_price: 0 }, NOW), { adult: false, child: true, rows: [] }, "a child fare of 0 is no fare");
  assert.deepEqual(publishPriceGap({ adult_price: 3_290_000, child_price: 2_590_000, infant_price: null }, NOW), { adult: false, child: false, rows: [] }, "the infant fare is optional");
  const perDate = (groups: Row[]) => ({ adult_price: null, child_price: null, extra: { price_groups: groups } });
  assert.deepEqual(publishPriceGap(perDate([
    { dates: ["2097-05-11"], adult_price: null, child_price: null },
    { dates: ["2098-05-11"], adult_price: 3_290_000, child_price: 2_590_000 },
    { dates: ["2098-06-11"], adult_price: 3_390_000, passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 2_690_000 }] },
  ]), NOW), { adult: false, child: false, rows: [] }, "a past departure's row is not asked for; a child band is a child fare");
  assert.deepEqual(publishPriceGap(perDate([
    { dates: ["2098-05-11"], adult_price: 3_290_000, passenger_prices: [{ label: "Нярай", age_range: "0-23 сар", price: 300_000 }] },
    { hotel: "Норвел буудал", adult_price: null, child_price: 2_590_000 },
  ]), NOW), { adult: true, child: true, rows: [0, 1] }, "an infant band is not a child fare; a row named by hotel counts as upcoming");

  const { reviewedProposal } = await import("../src/lib/adminProposalApply");
  const { validateAIChangeProposal } = await import("../src/lib/travelAIValidation");
  const { newTripSaveProblems } = await import("../src/lib/travelAIApply");
  const fields: Row = { route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", operator_name: "Fixture Travel", duration_text: "2 өдөр 1 шөнө", currency: "MNT", departure_dates: ["2098-05-11"], adult_price: 3_290_000, child_price: null,
    extra: { itinerary_days: [
      { day: 1, title: "УЛААНБААТАР – НОРВЕЛ", description: "Чингис Хаан олон улсын нисэх буудлаас хөөрнө.", meals: {} },
      { day: 2, title: "НОРВЕЛ – УЛААНБААТАР", description: "Улаанбаатар хотод газардсанаар аялал өндөрлөнө.", meals: {} },
    ] } };
  const proposal = { summary: "", needs_confirmation: false, important_reason: "", conflicts: [], conflict_items: [], actions: [{ action: "upsert", fields }] };
  const checked = (mode: "draft" | "publish", next: Row = fields) => newTripSaveProblems(validateAIChangeProposal(reviewedProposal(proposal as never, { 0: next }, mode, NOW) as never, [], { now: NOW }).proposal);
  assert.deepEqual(checked("publish"), ["«НОРВЕЛ ХОТЫН АЯЛАЛ»: Нийтлэхийн өмнө том хүн, хүүхдийн үнийг оруулна уу."], "the server refuses to publish without the child fare");
  assert.deepEqual(checked("draft"), [], "a draft is saved without it");
  assert.deepEqual(checked("publish", { ...fields, child_price: 2_590_000 }), [], "with both fares it is published");
  // A proposal sent straight to the server, with no status at all, is saved active: the same rule.
  assert.equal(newTripSaveProblems(validateAIChangeProposal(proposal as never, [], { now: NOW }).proposal).length, 1);
});

/* ------------------------------------------------ 4. the website link after the save */

test("the saved bar gets each saved trip's public page; a draft or hidden trip gets none", async () => {
  const { savedTripLinks } = await import("../src/lib/savedTripLinks");
  const { newWebsiteTripSlug } = await import("../src/lib/websiteTripSlug");
  const links = savedTripLinks([
    { trip: { id: "trip-new", route_name: "НОРВЕЛ", status: "active", extra: {} }, created: true },
    { trip: { id: "trip-synced", route_name: "ЛУМИА", status: "active", extra: {} } },
    { trip: { id: "trip-draft", route_name: "ВЕЛМОР", status: "draft", extra: {} }, created: true },
    { trip: { id: "trip-hidden", route_name: "НУУЦ", status: "active", extra: { customer_visible: false, website_slug: "nuuts" } } },
    { trip: { id: "trip-unlinked", route_name: "ХОЛБООГҮЙ", status: "active", extra: {} } },
    { trip: { id: "trip-off", route_name: "ЗАДГАЙ", status: "active", extra: { website_slug: "zadgai", website_published: false } } },
    { trip: { id: "trip-going-live", route_name: "НЭЭГДЭЖ", status: "active", extra: { website_slug: "going-live", website_published: false } } },
  ], { "trip-synced": { slug: "lumia-city", pending: false }, "trip-off": { slug: "zadgai", pending: false }, "trip-going-live": { slug: "going-live", pending: true } }, newWebsiteTripSlug);
  assert.deepEqual(links.map((link) => [link.trip_id, link.url, link.pending ?? false]), [
    ["trip-new", `https://uudamtravel.mn/mn/trips/${newWebsiteTripSlug("trip-new")}`, true],
    ["trip-synced", "https://uudamtravel.mn/mn/trips/lumia-city", false],
    ["trip-draft", null, false],
    ["trip-hidden", null, false],
    ["trip-unlinked", null, false],
    ["trip-off", null, false],
    ["trip-going-live", "https://uudamtravel.mn/mn/trips/going-live", true],
  ]);
  assert.match(newWebsiteTripSlug("trip-new"), /^trip-[0-9a-f]{20}$/, "the form the sync gives a new website row");

  const apply = await import("../src/lib/travelAIApply");
  apply.setAIApplyDepsForTests({
    // A live trip has a departure ahead (one without dates is archived on read and has no page).
    getTripById: async (id) => ({ id, route_name: "ЛУМИА", status: "active", departure_dates: ["2099-01-10"], extra: {} }) as never,
    readWebsiteSlugs: async (ids) => Object.fromEntries(ids.map((id) => [id, { slug: `slug-${id}`, pending: false }])),
  });
  try {
    const read = await apply.linksForSnapshots([
      { action: { action: "set_date_state" } as never, trip_id: "t1", before: null, after: null },
      { action: { action: "upsert" } as never, trip_id: "t2", before: null, after: { id: "t2", route_name: "НОРВЕЛ", status: "draft", extra: {} } as never, created: true },
    ]);
    assert.deepEqual(read.map((link) => link.url), ["https://uudamtravel.mn/mn/trips/slug-t1", null]);
    apply.setAIApplyDepsForTests({ getTripById: async () => { throw new Error("database down"); } });
    assert.deepEqual(await apply.linksForSnapshots([{ action: { action: "patch" } as never, trip_id: "t1", before: null, after: null }]), [], "a link failure never fails the save");
  } finally {
    apply.setAIApplyDepsForTests(null);
  }

  const { applyOutcome } = await import("../src/lib/adminProposalApply");
  const outcome = applyOutcome(200, { ok: true, results: ["ok"], links: [
    { trip_id: "a", route_name: "НОРВЕЛ", status: "active", url: "https://uudamtravel.mn/mn/trips/norvel", pending: true },
    { trip_id: "b", route_name: "X", status: "active", url: "https://elsewhere.example.test/mn/trips/x" },
  ] });
  assert.deepEqual(outcome.kind === "saved" && outcome.links.map((link) => link.url), ["https://uudamtravel.mn/mn/trips/norvel", null], "only a page on the trip website is linked");
});

/* ------------------------------------------------ review round: hotel split rule + the per-date price hole */

test("hotel profiles split by the project's rule: + / эсвэл or; never a comma; «similar» parts are no hotel", async () => {
  const { hotelNamesOf, withSuggestedHotelProfiles } = await import("../src/lib/tripHotelNames");
  const { hotelOptionParts } = await import("../src/lib/partnerSync/hotelProfiles");
  // The trip line: «or a similar hotel» is dropped, the stars stay on the one real hotel.
  assert.deepEqual(hotelNamesOf([], "Норвел 4* буудал эсвэл адил зэрэглэлийн буудал"), ["Норвел 4* буудал"]);
  assert.deepEqual(hotelNamesOf([], "Норвел хотел эсвэл ижил зэрэглэлийн зочид буудал"), ["Норвел хотел"]);
  assert.deepEqual(hotelNamesOf([], "Norvel hotel or similar"), ["Norvel hotel"]);
  assert.deepEqual(hotelNamesOf([], "Norvel Grand or a similar hotel"), ["Norvel Grand"]);
  // A comma is part of one name; only a trailing stars tail is cut.
  assert.deepEqual(hotelNamesOf([], "Altara Resort, Sanya"), ["Altara Resort, Sanya"]);
  assert.deepEqual(hotelNamesOf([], "Altara Resort, 5 stars"), ["Altara Resort"]);
  assert.deepEqual(hotelNamesOf([], "Норвел хотын зочид буудал, 4 од"), ["Норвел хотын зочид буудал"]);
  assert.deepEqual(hotelNamesOf([], "Altara Resort & Spa"), ["Altara Resort & Spa"], "«&» is not a separator");
  assert.deepEqual(hotelNamesOf([], "5*"), []);
  assert.deepEqual(hotelNamesOf([], "адил зэрэглэлийн буудал"), [], "a line that names no hotel adds none");
  // Price rows are split the same way (they were kept as one profile before).
  assert.deepEqual(hotelNamesOf([{ hotel: "Норвел Гранд эсвэл Лумиа Инн · Хөтөлбөртэй" }, { hotel: "Велмор + Тавин Бэй" }, { hotel: "Альфа / Бета" }], ""),
    ["Норвел Гранд", "Лумиа Инн", "Велмор", "Тавин Бэй", "Альфа", "Бета"]);
  for (const option of ["Норвел Гранд эсвэл Лумиа Инн", "Велмор Инн + Тавин Бэй", "Альфа Хотел / Бета Хотел"]) {
    assert.deepEqual(hotelNamesOf([{ hotel: option }], ""), hotelOptionParts(option), `${option}: the same parts as hotelOptionParts`);
  }
  // The profiles a new trip gets are those names, nothing else.
  const next = withSuggestedHotelProfiles({ route_name: "X", hotel: "Altara Resort, Sanya", extra: { price_groups: [{ hotel: "Норвел 4* буудал эсвэл адил зэрэглэлийн буудал" }] } });
  assert.deepEqual(((next.extra as Row).hotel_profiles as Row[]).map((profile) => profile.name), ["Норвел 4* буудал", "Altara Resort, Sanya"]);
});

test("a departure that no price row names needs the trip's own adult and child fare to publish, and is never priced by another date's row", async () => {
  const { publishPriceGap, reviewIssues, reviewedFields, unpricedDepartures } = await import("../src/lib/tripReview");
  const row = (dates: string[], extra: Row = {}) => ({ dates, adult_price: 3_290_000, child_price: 2_590_000, ...extra });
  const trip = (groups: Row[], base: Row = {}): Row => ({ route_name: "НОРВЕЛ", departure_dates: ["2098-05-11", "2098-05-18", "2098-05-25"], adult_price: null, child_price: null, ...base, extra: { price_groups: groups } });

  // One row for one of three departures, no trip fare: the other two are unpriced.
  const partial = trip([row(["2098-05-11"])]);
  assert.deepEqual(unpricedDepartures(partial, NOW), { days: ["2098-05-18", "2098-05-25"], other: [] });
  assert.deepEqual(publishPriceGap(partial, NOW), { adult: true, child: true, rows: [] });
  assert.ok(reviewIssues(partial, NOW).some((issue) => issue.key === "price" && issue.blocks === "publish"), "Publish stays blocked in the review");
  const saved = reviewedFields(partial, "publish", NOW);
  assert.equal(saved.adult_price, null, "the unpriced dates do not inherit the one row's fare");
  assert.equal(saved.child_price, null);

  // The trip's own fare covers the unpriced dates: publishable. Only one of the two is not enough.
  assert.deepEqual(publishPriceGap(trip([row(["2098-05-11"])], { adult_price: 3_590_000, child_price: 2_790_000 }), NOW), { adult: false, child: false, rows: [] });
  assert.deepEqual(publishPriceGap(trip([row(["2098-05-11"])], { adult_price: 3_590_000 }), NOW), { adult: false, child: true, rows: [] });
  assert.equal(reviewedFields(trip([row(["2098-05-11"])], { adult_price: 3_590_000, child_price: 2_790_000 }), "publish", NOW).adult_price, 3_590_000, "an entered fare is kept");

  // Every upcoming day has its row: priced, and the «from» fare is the cheapest row as before.
  const covered = trip([row(["2098-05-11", "2098-05-18"]), row(["2098-05-25"], { adult_price: 3_090_000, child_price: 2_390_000 })]);
  assert.deepEqual(publishPriceGap(covered, NOW), { adult: false, child: false, rows: [] });
  assert.equal(reviewedFields(covered, "publish", NOW).adult_price, 3_090_000);
  assert.equal(reviewedFields(covered, "publish", NOW).child_price, 2_390_000);

  // A row with no date (a hotel option) names every departure; a past departure needs no row.
  assert.deepEqual(publishPriceGap(trip([{ hotel: "Норвел буудал", adult_price: 3_290_000, child_price: 2_590_000 }]), NOW), { adult: false, child: false, rows: [] });
  const pastOnly = { ...trip([row(["2098-05-11"])]), departure_dates: ["2098-05-11", "2097-05-11"] };
  assert.deepEqual(publishPriceGap(pastOnly, NOW), { adult: false, child: false, rows: [] });

  // A weekly rule that no row names is open too.
  const weekly = { ...trip([row(["2098-05-11"])]), departure_dates: ["2098-05-11", "Пүрэв гараг бүр"] };
  assert.deepEqual(unpricedDepartures(weekly, NOW).other, ["Пүрэв гараг бүр"]);
  assert.equal(publishPriceGap(weekly, NOW).adult, true);

  // Through the apply path: the server refuses it, a draft is saved.
  const { reviewedProposal } = await import("../src/lib/adminProposalApply");
  const { validateAIChangeProposal } = await import("../src/lib/travelAIValidation");
  const { newTripSaveProblems } = await import("../src/lib/travelAIApply");
  const fields: Row = { ...partial, operator_name: "Fixture Travel", duration_text: "2 өдөр 1 шөнө", currency: "MNT",
    extra: { price_groups: [row(["2098-05-11"])], itinerary_days: [
      { day: 1, title: "УЛААНБААТАР – НОРВЕЛ", description: "Чингис Хаан олон улсын нисэх буудлаас хөөрнө.", meals: {} },
      { day: 2, title: "НОРВЕЛ – УЛААНБААТАР", description: "Улаанбаатар хотод газардсанаар аялал өндөрлөнө.", meals: {} },
    ] } };
  const proposal = { summary: "", needs_confirmation: false, important_reason: "", conflicts: [], conflict_items: [], actions: [{ action: "upsert", fields }] };
  const checked = (mode: "draft" | "publish") => newTripSaveProblems(validateAIChangeProposal(reviewedProposal(proposal as never, { 0: fields }, mode, NOW) as never, [], { now: NOW }).proposal);
  assert.deepEqual(checked("publish"), ["«НОРВЕЛ»: Нийтлэхийн өмнө том хүн, хүүхдийн үнийг оруулна уу."]);
  assert.deepEqual(checked("draft"), []);
});
