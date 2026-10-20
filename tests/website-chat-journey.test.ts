import assert from "node:assert/strict";
import test, { before } from "node:test";
import { BOOKING_WEBSITE_URL, publishedTripWebsiteLink, tripsForWebsiteReference, websiteTripLinksInText, websiteTripSlugFromUrl } from "../src/lib/bookingWebsite";
import type { TravelTrip } from "../src/lib/travelTypes";
import { applyTestEnv } from "./helpers/env";

before(() => { applyTestEnv(); });

function trip(id: string, slug: string): TravelTrip {
  return { id, route_name: `${id === "a" ? "Вэлмор" : "Нерит"} аялал`, category: "", operator_name: "Invented",
    duration_text: "8 өдөр", adult_price: 1_700_000, child_price: null, infant_price: null, currency: "MNT",
    departure_dates: ["2098-03-10"], seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "",
    source_description: "", photo_urls: [], extra: { website_slug: slug, website_published: true }, created_at: "", updated_at: "" };
}
const a = trip("a", "trip-0123456789abcdef0123");
const b = trip("b", "nerith-program");
const url = (slug: string) => `${BOOKING_WEBSITE_URL}/trips/${slug}`;

test("persisted generated slugs link to live pages without requiring a PDF", async () => {
  const { buildTripProgramReply } = await import("../src/lib/travelFastPathsProgram");
  assert.equal(publishedTripWebsiteLink(a), url(a.extra.website_slug as string));
  for (const status of ["draft", "archived", "cancelled"] as const) assert.equal(publishedTripWebsiteLink({ ...a, status }), null);
  assert.equal(publishedTripWebsiteLink({ ...a, extra: { ...a.extra, website_published: false } }), null);
  assert.equal(publishedTripWebsiteLink({ ...a, extra: { ...a.extra, customer_visible: false } }), null);
  assert.equal(publishedTripWebsiteLink({ ...a, extra: { website_slug: "velmor" } }), null);
  const program = buildTripProgramReply("Вэлмор аяллын хөтөлбөр", [a]);
  assert.ok(program);
  assert.match(program.reply, /trip-0123456789abcdef0123/);
  assert.equal(program.brochure, null);
});

test("only exact official detail URLs identify trips; tracking strings cannot become intent", async () => {
  const { buildTripRequest } = await import("../src/lib/tripRequest");
  assert.equal(websiteTripSlugFromUrl(`${BOOKING_WEBSITE_URL}/mn/trips/nerith-program?date=2098-03-10`), "nerith-program");
  for (const value of ["https://uudamtravel.mn.example.test/trips/nerith-program", "https://example.test/trips/nerith-program",
    "https://user@uudamtravel.mn/trips/nerith-program", `${BOOKING_WEBSITE_URL}/trips/one/two`, `${BOOKING_WEBSITE_URL}/trips/%2Fother`, `${BOOKING_WEBSITE_URL}:444/trips/nerith-program`]) {
    assert.equal(websiteTripSlugFromUrl(value), null, value);
  }
  const text = `Үнэ хэд вэ? (${url("nerith-program")}?date=2098-03-10&hotel=fictional&people=4)`;
  assert.deepEqual(websiteTripLinksInText(text).slugs, ["nerith-program"]);
  const request = buildTripRequest(text, [a, b], undefined, new Date("2098-02-01T04:00:00Z"));
  assert.ok(request.topics.includes("price"));
  assert.equal(request.date, null);
  assert.deepEqual(request.passengers, []);
});

test("pasted trip pages resolve by stored identity and never by words in unknown slugs", async () => {
  const { resolveTripFromUserMessage } = await import("../src/lib/travelFastPathsSearch");
  assert.equal(resolveTripFromUserMessage(`${url("nerith-program")} үнэ?`, [a, b]).trip?.id, "b");
  assert.equal(resolveTripFromUserMessage(`${url("nerith-old-page")} Нерит аялал`, [a, b]).status, "not_found");
  assert.equal(resolveTripFromUserMessage(`${url("nerith-program")} ${url(a.extra.website_slug as string)}`, [a, b]).status, "ambiguous");
  assert.equal(resolveTripFromUserMessage(url("nerith-program"), [{ ...b, extra: { ...b.extra, website_published: false } }]).status, "not_found");
  assert.equal(resolveTripFromUserMessage(`https://example.test/nerith-program`, [a, b]).status, "not_found");
});

test("a newly shared page replaces stale clarification and selection without model calls", async () => {
  const { routeFastPathText } = await import("../src/lib/fastPathRouting");
  const { setTripSelection, getTripSelection } = await import("../src/lib/tripSelectionState");
  const { setClarificationState, getClarificationState, clearClarificationState } = await import("../src/lib/clarificationState");
  const { isNoTripText } = await import("../src/lib/customerTurn");
  const senderId = "website-journey-fixture";
  try {
    await setTripSelection(senderId, { tripId: "a", date: "2098-03-10", hotel: null, package: null, passengers: [] });
    await setClarificationState(senderId, ["a"]);
    const text = `${url("nerith-program")}?date=2098-03-10 үнэ хэд вэ`;
    const route = await routeFastPathText({ senderId, text, contextualUserText: `Вэлмор аялал ${text}`, trips: [a, b],
      understand: async () => { throw new Error("explicit page needs no model"); } });
    assert.equal(route.chosenTripId, "b");
    assert.equal(route.selection?.date, null);
    assert.equal(await getClarificationState(senderId), null);
    const unknown = url("nerith-old-page");
    const noTrip = await routeFastPathText({ senderId, text: unknown, contextualUserText: `Нерит аялал ${unknown}`, trips: [a, b] });
    assert.equal(isNoTripText(noTrip.matchText), true);
    assert.equal(await getTripSelection(senderId), null);
  } finally { await setTripSelection(senderId, null); await clearClarificationState(senderId); }
});

test("a tracking date in a page link does not become a sold-out departure question", async () => {
  const { buildSoldOutPrecedenceReply, buildStructuredTripReply } = await import("../src/lib/travelFastPaths");
  const { routeFastPathText } = await import("../src/lib/fastPathRouting");
  const { setTripSelection } = await import("../src/lib/tripSelectionState");
  const dated = { ...b, departure_dates: ["2098-03-10", "2098-03-17"], extra: { ...b.extra,
    website_departure_availability: [{ date: "2098-03-10", status: "SOLD_OUT", seatsLeft: 0 }, { date: "2098-03-17", status: "OPEN", seatsLeft: 7 }] } };
  const text = `${url("nerith-program")}?date=2098-03-10 үнэ хэд вэ`;
  const senderId = "website-tracking-fixture";
  try {
    assert.equal(buildSoldOutPrecedenceReply(text, [dated]), null);
    const routed = await routeFastPathText({ senderId, text, contextualUserText: text, trips: [dated] });
    assert.doesNotMatch(routed.matchText, /2098-03-10/);
    assert.equal(buildSoldOutPrecedenceReply(routed.matchText, [dated]), null);
    const reply = buildStructuredTripReply(routed.matchText, [dated]);
    assert.ok(reply);
    assert.match(reply, /1,700,000/);
  } finally { await setTripSelection(senderId, null); }
});

test("exit grounding follows the current page rather than an old conversation or selection", async () => {
  const { ungroundedTripInReply } = await import("../src/lib/tripGrounding");
  const context = { trips: [a, b], customerText: url("nerith-program"), selectionTripId: "a", routedTripIds: ["a"],
    history: [{ role: "user" as const, text: "Вэлмор аялал" }] };
  assert.equal(ungroundedTripInReply("Нерит аялал мэдээлэл", context), null);
  assert.equal(ungroundedTripInReply("Вэлмор аялал мэдээлэл", context)?.id, "a");
  assert.equal(ungroundedTripInReply("• Вэлмор аялал мэдээлэл", context)?.id, "a");
  assert.equal(ungroundedTripInReply("• Нерит аялал\n• Вэлмор аялал", context)?.id, "a");
  assert.equal(ungroundedTripInReply("Вэлмор аялал мэдээлэл", { ...context, customerText: url("nerith-old-page") })?.id, "a");
  assert.equal(ungroundedTripInReply("• Вэлмор аялал мэдээлэл", { ...context, customerText: url("nerith-old-page") })?.id, "a");
});

test("website Messenger refs cannot select hidden or archived trips or guess from unknown refs", async () => {
  const { rememberAdReferral } = await import("../src/lib/adReferral");
  const { setTripSelection, getTripSelection } = await import("../src/lib/tripSelectionState");
  for (const status of ["draft", "cancelled", "archived"] as const) assert.deepEqual(tripsForWebsiteReference("nerith-program", [{ ...b, status }]), []);
  assert.deepEqual(tripsForWebsiteReference("b", [{ ...b, extra: { ...b.extra, website_published: false } }]), []);
  const senderId = "website-ref-fixture";
  try {
    await setTripSelection(senderId, { tripId: "a", date: null, hotel: null, package: null, passengers: [] });
    await rememberAdReferral({ senderId, platform: "facebook", trips: [a, b], referral: { ref: "nerith-old-page", ads_context_data: { ad_title: "Нерит аялал" } } });
    assert.equal(await getTripSelection(senderId), null);
    await rememberAdReferral({ senderId, platform: "facebook", trips: [a, b], referral: { ref: "nerith-program" } });
    assert.equal((await getTripSelection(senderId))?.tripId, "b");
  } finally { await setTripSelection(senderId, null); }
});
