import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

function trip(id: string, route_name: string, extra: Record<string, unknown> = {}): TravelTrip {
  return { id, category: "", operator_name: "Invented", route_name, duration_text: "5 өдөр", adult_price: 1_000_000, child_price: null,
    infant_price: null, currency: "MNT", departure_dates: ["2026-12-17"], seats_total: null, seats_left: null, has_food: null,
    status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], extra, created_at: "", updated_at: "" };
}
const VEL = trip("vel", "Вэлмор -намрын баяр үзэх аялал", { aliases: ["Лотус хороо"] });
const TAR = trip("tar", "ТАРМИЗ – КАРДАН АЯЛАЛ-Лхагва");
const MINI = trip("mini", "ЖИНИН-МИНИ АВАТАР-ХӨХ ХОТЫН АЯЛАЛ");
const DATON = trip("daton", "МИНИ АВАТАР - ХӨХ ХОТ - ДАТОН ХОТЫН АЯЛАЛ");
const TRIPS = [VEL, TAR, MINI, DATON];
const card = (t: TravelTrip) => `✈️ ${t.route_name}\nТом хүн: 1,000,000₮`;

test("a one-trip reply the conversation never pointed to is not sent", async () => {
  applyTestEnv();
  const { ungroundedTripInReply } = await import("../src/lib/tripGrounding");
  // The live cases: "1", "vne" as a first message; "between Oct 20-23?" answered about one trip.
  assert.equal(ungroundedTripInReply(`${TAR.route_name}\nАль гарах өдрөөр аялах вэ?`, { customerText: "vne", history: [{ role: "user", text: "1" }], trips: TRIPS })?.id, "tar");
  assert.equal(ungroundedTripInReply(`${VEL.route_name} 10 сарын 20–23-ны хооронд гарахгүй байна.`, { customerText: "10.20-23-ны хооронд эхлэх аялал бнуу", history: [], trips: TRIPS })?.id, "vel");
  // The customer named a different trip than the reply talks about.
  assert.equal(ungroundedTripInReply(card(MINI), { customerText: `${DATON.route_name} үнэ хэд вэ`, history: [], trips: TRIPS })?.id, "mini");
});

test("a reply about a trip the conversation points to is sent", async () => {
  applyTestEnv();
  const { ungroundedTripInReply } = await import("../src/lib/tripGrounding");
  const none = (reply: string, context: Partial<Parameters<typeof ungroundedTripInReply>[1]>) =>
    assert.equal(ungroundedTripInReply(reply, { customerText: "", history: [], trips: TRIPS, ...context }), null);
  none(card(TAR), { customerText: "Тармиз аялал үнэ" });                                   // named in the message
  none(card(TAR), { customerText: "Хөтөлбөр үзэх", history: [{ role: "assistant", text: card(TAR) }] }); // earlier turn
  none(card(TAR), { customerText: "2", pendingTripIds: ["vel", "tar"] });                // open list
  none(card(TAR), { customerText: "vne", selectionTripId: "tar" });                       // selected / ad / website link
  none(card(DATON), { customerText: "Мини аватар датон үнэ" });                           // best name-word fit
  none(`10 сард гарах аяллууд 😊\n• ${TAR.route_name} — гарах: 10 сарын 22`, { customerText: "10 сард гарах аялал", catalogTripIds: [TAR.id] }); // explicit catalog result
  none("Манай утасны дугаарууд: 7700 0000", { customerText: "Холбоо барих" });            // no trip at all
});
