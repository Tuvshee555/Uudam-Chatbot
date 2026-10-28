import assert from "node:assert/strict";
import test, { before } from "node:test";
import type { TravelTrip } from "../src/lib/travelTypes";
import { applyTestEnv } from "./helpers/env";

const now = new Date("2098-02-01T04:00:00.000Z");
let routing: typeof import("../src/lib/fastPathRouting");
let clarification: typeof import("../src/lib/clarificationState");
let selection: typeof import("../src/lib/tripSelectionState");
let requestedDepartureScope: typeof import("../src/lib/travelDates").requestedDepartureScope;
let shouldSilenceNoDataReply: typeof import("../src/lib/reply").shouldSilenceNoDataReply;
let queryWantsDirectFlight: typeof import("../src/lib/travelFastPathsSearch").queryWantsDirectFlight;
let buildDocumentReceivedMessage: typeof import("../src/lib/webhookAttachments").buildDocumentReceivedMessage;

before(async () => {
  applyTestEnv({ NEON_DATABASE_URL: undefined, BOOKING_DATABASE_URL: undefined, TRIP_UNDERSTANDING: "off" });
  routing = await import("../src/lib/fastPathRouting");
  clarification = await import("../src/lib/clarificationState");
  selection = await import("../src/lib/tripSelectionState");
  ({ requestedDepartureScope } = await import("../src/lib/travelDates"));
  ({ shouldSilenceNoDataReply } = await import("../src/lib/reply"));
  ({ queryWantsDirectFlight } = await import("../src/lib/travelFastPathsSearch"));
  ({ buildDocumentReceivedMessage } = await import("../src/lib/webhookAttachments"));
});

function trip(id: string, name: string, dates: string[], transport = "direct_flight"): TravelTrip {
  return { id, route_name: name, category: "Аялал", operator_name: "Invented", duration_text: "5 өдөр",
    adult_price: 731_000, child_price: null, infant_price: null, currency: "MNT", departure_dates: dates,
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: { transport_type: transport }, created_at: "", updated_at: "" };
}

const north = trip("velmor-north", "ВЭЛМОР ХОЙД АЯЛАЛ", ["2098-02-05", "2098-03-03", "2098-03-20"]);
const south = trip("velmor-south", "ВЭЛМОР ӨМНӨД АЯЛАЛ", ["2098-02-12", "2098-03-12"], "land_flight");
const trips = [north, south];
const menu = `Энэ чиглэлээр хэд хэдэн сонголт байна 😊\n${trips.map((t) => `• ${t.route_name}`).join("\n")}\nАль аяллыг нь сонирхож байна вэ?`;
const history = [{ role: "user" as const, text: "Велмор" }, { role: "assistant" as const, text: menu }];

async function route(text: string) {
  const senderId = `review-1028-${text}`;
  await clarification.setClarificationState(senderId, trips.map((t) => t.id));
  try {
    return await routing.routeFastPathText({ senderId, text, contextualUserText: text, history, trips, now });
  } finally { await clarification.clearClarificationState(senderId); await selection.setTripSelection(senderId, null); }
}

test("date answers typed fast on a phone still pick the trip that departs that day", async () => {
  // Latin month spellings ("sarin"), a Latin ordinal ("3r"), "around the 20th" and a passenger count.
  for (const [text, expected] of [
    ["3 sarin 20", north.id], ["3 сарын 20доор бгаюу", north.id], ["3r sarin 3nd", north.id],
    ["3/20 nd 2 hun", north.id], ["3.12nii sonirhoj bn", south.id], ["3/12-нд 3 хүн", south.id],
  ] as const) {
    const result = await route(text);
    assert.equal(result.unsupportedRequest, undefined, `${text} must not be silenced`);
    assert.equal(result.chosenTripId, expected, text);
  }
});

test("a month answer with filler words lists the trips of that month instead of silence", async () => {
  const result = await route("3 sard bn");
  assert.equal(result.unsupportedRequest, undefined);
  assert.deepEqual(result.scopedClarify?.map((t) => t.id).sort(), [north.id, south.id].sort());
});

test("a new destination beside a date still cannot borrow the trips on screen", async () => {
  const result = await route("Нерит 3/20 nd bga yu");
  assert.equal(result.unsupportedRequest, true);
  assert.equal(result.chosenTripId, undefined);
});

test("Latin month spellings are read as dates", () => {
  for (const text of ["3 sarin 20", "3 saryn 20", "3sarin 20", "3 sariin 20"]) {
    assert.deepEqual(requestedDepartureScope(text, now), { kind: "dates", dates: ["2098-03-20"] }, text);
  }
  assert.deepEqual(requestedDepartureScope("2r sarin 3nd", now), { kind: "dates", dates: ["2098-02-03"] });
});

test("a typo in 'shuud nisleg' is still a direct-flight question", () => {
  for (const text of ["shuud nudleg bgaa yu", "shuud nisleg uu", "shud nislegtei aylal", "direct flight"]) assert.equal(queryWantsDirectFlight(text), true, text);
  assert.equal(queryWantsDirectFlight("shuud ywna"), false);
  assert.equal(queryWantsDirectFlight("nisleg"), false);
});

test("the model's own 'there is no such trip / departure' is never sent: the data decides, not the model", () => {
  for (const reply of [
    "Хайнан чиглэлд шууд нислэгтэй аялал байхгүй байна. Та өөр чиглэл эсвэл аяллын талаар асуухыг хүсвэл хэлээрэй. 😊",
    "1 сарын 20-нд гарах Хайнан чиглэлийн аялал байхгүй байна. Та өөр огноо эсвэл аяллын сонголт сонирхож байна уу? 😊",
    "ВЭЛМОР ХОЙД АЯЛАЛ чиглэлээр 2-р сарын 3-нд гарах аялал байхгүй байна. Та өөр огноо сонгох уу?",
  ]) assert.equal(shouldSilenceNoDataReply(reply), true, reply);
  // Replies built from the data keep going out: the code's own flight-kind note and fare cards.
  for (const reply of [
    "Шууд нислэгтэй аялал энэ чиглэлд одоогоор байхгүй. Энэ чиглэлийн аяллууд:\n• ВЭЛМОР ӨМНӨД АЯЛАЛ",
    "ВЭЛМОР ХОЙД АЯЛАЛ 3 сарын 20: захиалга нээлттэй. Том хүн 731,000₮",
  ]) assert.equal(shouldSilenceNoDataReply(reply), false, reply);
});

test("the receipt confirmation names each document with its own ending", () => {
  const receipt = buildDocumentReceivedMessage([{ category: "payment_screenshot" }]);
  assert.match(receipt!, /^Таны илгээсэн төлбөрийн баримтыг хүлээн авч бүртгэлээ/);
  assert.doesNotMatch(receipt!, /-ыг/);
  const several = buildDocumentReceivedMessage([{ category: "payment_screenshot" }, { category: "passport" }, { category: "booking_code" }]);
  assert.match(several!, /төлбөрийн баримтыг, паспортын зургийг, захиалгын кодыг хүлээн авч/);
  assert.equal(buildDocumentReceivedMessage([{ category: "misc" }]), null);
});
