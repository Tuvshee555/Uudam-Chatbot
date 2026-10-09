import test from "node:test";
import assert from "node:assert/strict";
import { buildContactReply, contactSettingsOf, isAddressRequest, isPhoneRequest } from "../src/lib/contactReplies";
import { hasBankAccountRequest, hasPaymentClaimIntent, isReferReply } from "../src/lib/reply";
import { buildPlaceDaysReply } from "../src/lib/tripPlaceDaysReply";
import { verifyTripReply } from "../src/lib/tripReplyVerification";
import { buildAmbiguousTripReply } from "../src/lib/travelFastPathsPricing";
import { buildStructuredTripReply } from "../src/lib/travelFastPaths";
import { joinContextAndTurn } from "../src/lib/customerTurn";
import type { TravelTrip } from "../src/lib/travelTypes";

// Invented trips only — never the real catalogue.
const base: TravelTrip = { id: "fixture-a", route_name: "ЗАНДАН – ХАРСАЙ – УЛААНБААТАР АЯЛАЛ", operator_name: "Uudam", category: "",
  duration_text: "6 өдөр 5 шөнө", adult_price: 1_500_000, child_price: 1_200_000, infant_price: null, currency: "MNT",
  departure_dates: ["2099-03-10", "2099-03-17"], seats_total: null, seats_left: null, has_food: null, status: "active",
  notes: "", hotel: "", source_description: "", photo_urls: [],
  extra: {
    age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-2 нас" },
    itinerary_days: [
      { day: 1, title: "Улаанбаатар – Зандан", description: "Нислэгээр Зандан хотод хүрнэ." },
      { day: 2, title: "Зандан хотын аялал", description: "Хотын төвөөр аялна." },
      { day: 3, title: "Зандан – Харсай", description: "Харсайд нэвтэрч далайн эргээр алхана." },
    ],
  },
  created_at: "", updated_at: "" };
const now = new Date("2099-01-01T00:00:00Z");

test("the page's contact and address buttons get the saved contact details, never an invented address", () => {
  const contact = contactSettingsOf({ contact_phones: "1111 2222 / 3333 4444", office_address: "Төв дүүрэг, 1-р байр" });
  assert.ok(isPhoneRequest("Холбоо барих дугаар  😊") && isPhoneRequest("Холбоо барих дугаар  �"));
  assert.ok(isAddressRequest("Манай хаяг  😊"));
  assert.match(buildContactReply("Холбоо барих дугаар  😊", contact)!, /1111 2222/);
  assert.match(buildContactReply("Манай хаяг  😊", contact)!, /Төв дүүрэг, 1-р байр/);
  const noAddress = buildContactReply("Манай хаяг 😊", { ...contact, address: "" })!;
  assert.match(noAddress, /зөвлөхөөс лавлана/);
  assert.equal(buildContactReply("Зандан аялал хэд вэ", contact), null);
});

test("REFER and SILENT never go out as message text", () => {
  assert.ok(isReferReply("REFER") && isReferReply(" SILENT\n") && !isReferReply("Referral program"));
});

test("payments and account requests typed in Latin letters are recognised", () => {
  for (const text of ["Uridchilgaa 30% tulluu", "mungu shiljuullee", "uridchilgaa yavuulsan"]) assert.ok(hasPaymentClaimIntent(text), text);
  for (const text of ["tolovlogoo hutulbur", "yaj tuluh ve", "tulbur hed ve"]) assert.ok(!hasPaymentClaimIntent(text), text);
  assert.ok(hasBankAccountRequest("dans ruu hiih uu"));
});

test("a question about a place on the trip answers with the days that go there", () => {
  const reply = buildPlaceDaysReply(base, "Харсай орохгүйм бишүү")!;
  assert.match(reply, /3-р өдөр — Зандан – Харсай/);
  assert.doesNotMatch(reply, /1-р өдөр/);
  assert.equal(buildPlaceDaysReply(base, "Харсай"), null, "a bare place name still gets the trip card");
});

test("a fare labelled with an age band is not read as a passenger of the band's lowest age", () => {
  const reply = `✈️ ${base.route_name}\n• Том хүн: 1,500,000₮\n• Хүүхэд /2-11 нас/: 1,200,000₮`;
  assert.equal(verifyTripReply({ reply, trips: [base], now }), reply);
});

test("a sold-out departure is left out of the trip list instead of silencing it", () => {
  const soldOut: TravelTrip = { ...base, id: "fixture-b", extra: { ...base.extra, website_departure_availability: [
    { date: "2099-03-10", status: "sold_out", seatsLeft: 0 }, { date: "2099-03-17", status: "sold_out", seatsLeft: 0 },
  ] } };
  const line = buildAmbiguousTripReply([soldOut]).split("\n").find((entry) => entry.startsWith("•"))!;
  assert.match(line, /суудал дүүрсэн/);
  assert.doesNotMatch(line, /₮/);
});

test("a follow-up that names no trip and asks nothing on the card does not get the card again", () => {
  assert.equal(buildStructuredTripReply(joinContextAndTurn(base.route_name, "За ойлголоо"), [base], now), null);
  assert.equal(buildStructuredTripReply(joinContextAndTurn(base.route_name, "Geree n bolj bnuu"), [base], now), null);
  assert.ok(buildStructuredTripReply(joinContextAndTurn(base.route_name, "үнэ хэд вэ"), [base], now));
});
