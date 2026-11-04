import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { applyTestEnv } from "./helpers/env";
import type { AIChangeProposal } from "../src/lib/travelTypes";

applyTestEnv();

// A partner's program as the model reads it from a Word file (invented places),
// three days from the border town and back, with no photos.
const ROUTE = "НОРВЕЛ ХОТЫН АЯЛАЛ";
const program = () => [
  { day: 1, title: "Эрээн – Норвел", description: "Эрээн авто вокзал дээр аялагчдыг тосно. Норвел хотоос 22:05 цагт нисээд 00:25 цагт бууна.", hotel: "", meals: { breakfast: false, lunch: true, dinner: false } },
  { day: 2, title: "Норвел хот", description: "Лумиа гүүр, хуучин хороолол, оройн гэрэлт үзвэр.", hotel: "Норвел 4* буудал", meals: { breakfast: true, lunch: true, dinner: true } },
  { day: 3, title: "Норвел – Эрээн", description: "Өглөө нисээд 13:25 цагт Эрээнд ирнэ.", hotel: "", meals: { breakfast: true, lunch: false, dinner: false } },
];
const proposal = (): AIChangeProposal => ({
  summary: "", needs_confirmation: false, important_reason: "", conflicts: [], conflict_items: [],
  actions: [{ action: "upsert", fields: { route_name: ROUTE, duration_text: "3 өдөр 2 шөнө",
    extra: { itinerary_days: program(), duration_days: 3, duration_nights: 2, destinations: ["Норвел"] } } }],
});

async function photoDeps() {
  const jpeg = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#7a8b9c" } }).jpeg().toBuffer();
  const uploads: string[] = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/w/api.php")) {
      const query = (url.searchParams.get("gsrsearch") || "").replace(" filetype:bitmap", "");
      const pages = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`${query}-${n}`, {
        title: `File:${query} ${n}.jpg`,
        imageinfo: [{ url: `https://upload.example.test/${n}.jpg`, thumburl: `https://thumb.example.test/${encodeURIComponent(query)}/1920px-${n}.jpg`,
          descriptionurl: `https://commons.example.test/wiki/File:${n}.jpg`, width: 3000, height: 2000, mime: "image/jpeg",
          extmetadata: { LicenseShortName: { value: "CC BY 4.0" }, Artist: { value: "Fixture Author" } } }],
      }]));
      return new Response(JSON.stringify({ query: { pages } }), { status: 200 });
    }
    return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
  }) as unknown as typeof fetch;
  const ask = (async (parts: Array<{ text?: string }>) => {
    const prompt = parts.map((part) => part.text || "").join("\n");
    const text = prompt.includes("search phrases")
      ? JSON.stringify({ queries: [{ q: "Norvel old town", day: 3 }, { q: "Lumia bridge", day: 3 }] })
      : JSON.stringify({ picks: [1, 2, 3, 4, 5, 6] });
    return { text, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }) as never;
  const upload = async (_buffer: Buffer, name: string) => { const url = `https://res.cloudinary.com/fixture/${name}`; uploads.push(url); return url; };
  return { deps: { fetchImpl, ask, upload }, uploads };
}

test("a partner program from a file becomes a complete website trip: standard days, transport, six credited photos", async () => {
  const { finalizeNewTripActions } = await import("../src/lib/tripProposalFinalize");
  const { STANDARD_DAYS, TRANSPORT_CHOICE } = await import("../src/lib/tripTransitDays");
  const { deps, uploads } = await photoDeps();
  const p = proposal();
  await finalizeNewTripActions(p, { photos: deps });
  const fields = p.actions[0].fields as Record<string, unknown>;
  const extra = fields.extra as Record<string, unknown>;
  const days = extra.itinerary_days as Array<Record<string, unknown>>;
  assert.equal(days.length, 5);
  assert.equal(days[0].title, STANDARD_DAYS.departure.title);
  assert.equal(days[4].title, STANDARD_DAYS.arrival.title);
  assert.deepEqual([extra.transport_type, fields.duration_text, extra.duration_days, extra.duration_nights], ["land_flight", "5 өдөр 4 шөнө", 5, 4]);
  assert.deepEqual((extra.website_details_patch as { values: Record<string, unknown> }).values.transport, ["Галт тэрэг", "Онгоц"]);
  const choice = p.conflict_items!.find((item) => item.type === TRANSPORT_CHOICE);
  assert.deepEqual([choice?.severity, choice?.data?.route_name, choice?.data?.transport_type], ["info", ROUTE, "land_flight"]);
  assert.equal(p.needs_confirmation, true, "the admin sees the generated days before saving");
  assert.equal(uploads.length, 6, "six photos were found, downloaded and uploaded");
  assert.deepEqual(fields.photo_urls, uploads);
  const credits = extra.photo_credits as Record<string, Record<string, string>>;
  assert.deepEqual(Object.keys(credits), uploads);
  assert.deepEqual([credits[uploads[0]].provider, credits[uploads[0]].license, credits[uploads[0]].author], ["Wikimedia Commons", "CC BY 4.0", "Fixture Author"]);
  assert.ok(uploads.includes(String(days[2].photo)), "the sight's photo sits on its program day");
  assert.ok(!days[0].photo && !days[4].photo, "transit days never get a photo");
  assert.ok(p.conflict_items!.some((item) => item.type === "photos_found"));
});

test("clicking another transport rebuilds the days and keeps the photos and credits across the revision", async () => {
  const { applyTransportChoice, carryOverPhotoExtras, finalizeNewTripActions } = await import("../src/lib/tripProposalFinalize");
  const { deps } = await photoDeps();
  const first = proposal();
  await finalizeNewTripActions(first, { photos: deps });
  // What the model sends back after the answer: the days it was shown, no photo data.
  const revised = proposal();
  (revised.actions[0].fields!.extra as Record<string, unknown>).itinerary_days = (first.actions[0].fields!.extra as Record<string, unknown>).itinerary_days;
  assert.equal(applyTransportChoice(`"${ROUTE}" аяллын тээврийн төрлийг "Улаанбаатараас шууд нислэгээр" болго (transport_type=direct_flight).`, revised), true);
  carryOverPhotoExtras(first, revised);
  await finalizeNewTripActions(revised);
  const extra = revised.actions[0].fields!.extra as Record<string, unknown>;
  const days = extra.itinerary_days as Array<Record<string, unknown>>;
  assert.equal(days.length, 3, "no train days on a flight");
  assert.equal(extra.transport_type, "direct_flight");
  assert.deepEqual((extra.website_details_patch as { values: Record<string, unknown> }).values.transport, ["Онгоц"]);
  assert.equal(Object.keys(extra.photo_credits as object).length, 6, "credits carried over, nothing searched again");
  assert.ok(days.some((day) => typeof day.photo === "string"), "the day photo followed its day");
  assert.equal(applyTransportChoice("ямар нэг өөр хариулт", revised), false);
});

test("the partner's own length in the summaries becomes the door-to-door duration", async () => {
  const { finalizeNewTripActions } = await import("../src/lib/tripProposalFinalize");
  const p = proposal();
  p.summary = "Норвел хотын аялал 3 өдөр 2 шөнө үргэлжилнэ.";
  (p.actions[0].fields!.extra as Record<string, unknown>).website_summary = "Норвел хотын 2 шөнө / 3 өдөр аялал.";
  await finalizeNewTripActions(p);
  assert.equal(p.summary, "Норвел хотын аялал 5 өдөр 4 шөнө үргэлжилнэ.");
  assert.equal((p.actions[0].fields!.extra as Record<string, unknown>).website_summary, "Норвел хотын 5 өдөр 4 шөнө аялал.");
});

test("a trip the program already writes from Ulaanbaatar is only tagged, never given train days", async () => {
  const { finalizeNewTripActions } = await import("../src/lib/tripProposalFinalize");
  const p = proposal();
  (p.actions[0].fields!.extra as Record<string, unknown>).itinerary_days = [
    { day: 1, title: "УЛААНБААТАР – НОРВЕЛ", description: "Чингис Хаан олон улсын нисэх буудалд цуглаж 23:05 цагт хөөрнө.", meals: {} },
    { day: 2, title: "НОРВЕЛ – УЛААНБААТАР", description: "Өглөө нисч Улаанбаатар хотод газардсанаар аялал өндөрлөнө.", meals: {} },
  ];
  // Priced in tugrug: this test is about the days; a trip without a tugrug price is asked for it (trip-price-rules.test.ts).
  p.actions[0].fields!.adult_price = 3_290_000;
  await finalizeNewTripActions(p);
  const extra = p.actions[0].fields!.extra as Record<string, unknown>;
  assert.equal((extra.itinerary_days as unknown[]).length, 2);
  assert.deepEqual([extra.transport_type, p.actions[0].fields!.duration_text], ["direct_flight", "3 өдөр 2 шөнө"]);
  assert.equal(p.needs_confirmation, false, "nothing was added and the type is certain");
});
