import assert from "node:assert/strict";
import test from "node:test";
import { buildStructuredTripReply, buildTripProgramReply } from "../src/lib/travelFastPaths";
import type { TravelTrip } from "../src/lib/travelTypes";

const now = new Date("2098-02-01T04:00:00Z");
const dates = Array.from({ length: 8 }, (_, index) => `2098-03-${String(index + 8).padStart(2, "0")}`);
const trip: TravelTrip = {
  id: "compact-overview-fixture", route_name: "ВЭЛМОР НУУРЫН АЯЛАЛ", category: "Аялал", operator_name: "Fixture agency",
  duration_text: "5 өдөр 4 шөнө", adult_price: 901_000, child_price: 401_000, infant_price: null,
  currency: "MNT", departure_dates: dates, seats_total: null, seats_left: null, has_food: null,
  status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
  extra: { price_groups: dates.flatMap(date => ["Lumen Lodge", "Sable Lodge", "Pine Lodge", "Oak Lodge"].map((hotel, index) => ({
    dates: [date], hotel, adult_price: 901_000 + index * 100_000, child_price: 401_000 + index * 100_000,
  }))) }, created_at: "", updated_at: "",
};

test("selecting a trip with many dated hotel fares asks one choice without the fare matrix", () => {
  const reply = buildStructuredTripReply(trip.route_name, [trip], now)!;
  assert.ok(reply.startsWith(trip.route_name));
  assert.equal((reply.match(/\?/g) || []).length, 1);
  assert.ok(reply.length < 240, reply);
  assert.doesNotMatch(reply, /₮|Lumen|Sable|Pine|Oak|undefined/);
  assert.match(reply, /3\/8/);
  assert.doesNotMatch(reply, /3\/11|3\/15/);
});

test("a program link is the answer without unrequested hotel and fare details", () => {
  const published = { ...trip, extra: { ...trip.extra, website_slug: "velmor-fixture", website_published: true } };
  const result = buildTripProgramReply(`${trip.route_name} хөтөлбөр`, [published]);
  assert.ok(result?.reply.includes("/trips/velmor-fixture"));
  assert.equal(result?.reply.split("\n").length, 2);
  assert.doesNotMatch(result?.reply || "", /₮|Буудал|дэлгэрэнгүй мэдээлэл|Том хүн/);
});

test("a default program summary is brief and explicit full program keeps every day", () => {
  const itinerary = { ...trip, extra: { itinerary_days: [
    { day: 1, title: "Люмен хүрэх", description: "Нислэгээр очоод буудалд байрлана." },
    { day: 2, title: "Нууранд амрах", description: "Нуурын эрэгт амарч зугаална." },
    { day: 3, title: "Сэйбл үзэх", description: "Хотын музей үзнэ." },
    { day: 4, title: "Буцах", description: "Буцах нислэгт сууна." },
  ] } };
  const brief = buildTripProgramReply(`${trip.route_name} хөтөлбөр`, [itinerary])!;
  assert.ok(brief.reply.length < 180, brief.reply);
  assert.doesNotMatch(brief.reply, /₮|буудалд байрлана|Хотын музей/);
  const full = buildTripProgramReply(`${trip.route_name} бүтэн хөтөлбөр`, [itinerary])!;
  assert.match(full.reply, /Өдөр 4: Буцах/);
  assert.match(full.reply, /Хотын музей үзнэ/);
});
