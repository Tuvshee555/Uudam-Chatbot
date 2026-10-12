import assert from "node:assert/strict";
import test from "node:test";
import { buildOptionalExtrasReply, isOptionalExtrasQuestion } from "../src/lib/tripExtrasReply";
import type { TravelTrip } from "../src/lib/travelTypes";

function trip(days: Array<Record<string, unknown>>): TravelTrip {
  return { id: "invented", category: "", operator_name: "Invented", route_name: "ЗАНДАН ДАЛАЙН АЯЛАЛ", duration_text: "5 өдөр",
    adult_price: 1_000_000, child_price: null, infant_price: null, currency: "MNT", departure_dates: [], seats_total: null,
    seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: { itinerary_days: days }, created_at: "", updated_at: "" };
}

test("an add-on question lists the program's own add-ons and sends 'compulsory?' to staff", () => {
  const value = trip([
    { day: 2, title: "Нэг", description: "Өдрийн хоол.\nНэмэлт: Лотус тоглолт: 300 юань/хүн" },
    { day: 3, title: "Хоёр", description: "Чөлөөт өдөр." },
  ]);
  for (const text of ["нэмэлт үзвэрийг заавал үзэх үү", "end baigaa nemelt uzwerig zaawal uze yu uzehgvi baij boldog uu"]) {
    const reply = buildOptionalExtrasReply(value, text);
    assert.ok(reply, text);
    assert.match(reply, /2-р өдөр: Лотус тоглолт: 300 юань\/хүн/);
    assert.match(reply, /зөвлөхөөс баталгаажуулж/);
  }
});

test("add-on wording alone, or a trip with no add-ons, is not answered by this module", () => {
  assert.equal(isOptionalExtrasQuestion("нэмэлт үзвэр байна уу"), false);
  assert.equal(buildOptionalExtrasReply(trip([{ day: 1, title: "Нэг", description: "Хоол." }]), "нэмэлт үзвэр заавал юу"), null);
});
